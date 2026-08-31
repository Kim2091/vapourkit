// VapourSynth binding for DLSS-NR ("Neural Uplift", the DLSS 5 generation).
//
// dlssnr.Enhance(clip) runs the snippet's neural enhancement over each frame at 1:1. It is not
// an upscaler - the snippet pins its scaling ratio to 1.0 - so this belongs at the end of a
// chain, after whatever actually changed the resolution.
//
// COLOUR SPACE IS A CORRECTNESS REQUIREMENT, not a tuning choice. The model is LDR-clamped and
// trained on tonemapped, sRGB-ENCODED frames. Hand it linear light and it reads the values as
// though they were already gamma-encoded; the result is lifted blacks and washed-out greys,
// which is exactly the bug the Remix integration hit before it anchored the pass after its
// sRGB encode. Convert before calling, e.g.
//
//   clip = core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s="709",
//                              transfer_in_s="709", transfer_s="srgb", range_s="full")
//
// and convert back afterwards. HDR sources (PQ/HLG) must be tonemapped to SDR first - they are
// outside the trained domain in both range and transfer.

#include <windows.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <DirectXPackedVector.h>

#include "VSHelper4.h"
#include "VapourSynth4.h"

#include "d3d12_ctx.h"
#include "dlssnr_params.h"
#include "log.h"
#include "ngx_uplift.h"

using namespace vsdlssnr;

namespace {

  constexpr uint32_t kDefaultApplicationId = 102100511;

  struct EnhanceData {
    VSNode* node = nullptr;
    VSNode* depthNode = nullptr;
    VSNode* motionNode = nullptr;
    VSVideoInfo vi = {};

    // Declaration order is load-bearing: NeuralUpliftContext holds a raw ID3D12Device* borrowed
    // from D3D12Context and touches it during shutdown, so it must be destroyed first. Members
    // destruct in reverse declaration order, so the device context is declared first.
    D3D12Context d3d;
    NeuralUpliftContext ngx;

    UpliftSettings settings;

    // The snippet's temporal history is only meaningful if the evaluation before this one
    // produced it. VapourSynth is free to ask for any frame at any time - a seek in the preview,
    // a re-request after a dropped cache entry - so a frame that does not directly follow the
    // last one processed resets the history rather than reprojecting against an unrelated one.
    int lastFrame = -2;

    // fmFrameState already serialises calls, but the D3D12 command list and the NGX parameter
    // block are process-visible state and the cost of being wrong is a corrupted frame or a
    // device removal. The lock is uncontended in the normal case.
    std::mutex mutex;

    bool inputIsFloat = false;
    int inputBytesPerSample = 0;
    bool hasDepth = false;
    bool depthIsFloat = false;
    int depthBytesPerSample = 0;
    bool hasMotion = false;
  };

  std::wstring widen(const char* utf8) {
    if (utf8 == nullptr || *utf8 == '\0') {
      return std::wstring();
    }
    const int needed = MultiByteToWideChar(CP_UTF8, 0, utf8, -1, nullptr, 0);
    if (needed <= 0) {
      return std::wstring();
    }
    std::wstring out(static_cast<size_t>(needed - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8, -1, out.data(), needed);
    return out;
  }

  // Planar RGB -> packed RGBA16F, which is the format the Remix integration stages DLSS-NR
  // through. Values are clamped to 0..1 because the model is LDR-clamped; letting a stray
  // negative or a specular overshoot through would put the network outside its training domain
  // for that pixel rather than producing a brighter result.
  void packToHalf4(const EnhanceData* d,
                   const VSFrame* src,
                   const VSAPI* vsapi,
                   uint8_t* dstBase,
                   uint32_t rowPitch) {
    using DirectX::PackedVector::XMConvertFloatToHalf;

    const int width = d->vi.width;
    const int height = d->vi.height;

    const uint8_t* planes[3];
    ptrdiff_t strides[3];
    for (int p = 0; p < 3; ++p) {
      planes[p] = vsapi->getReadPtr(src, p);
      strides[p] = vsapi->getStride(src, p);
    }

    const float intScale = d->inputBytesPerSample == 1 ? (1.0f / 255.0f) : (1.0f / 65535.0f);
    const uint16_t one = XMConvertFloatToHalf(1.0f);

    for (int y = 0; y < height; ++y) {
      auto* row = reinterpret_cast<uint16_t*>(dstBase + static_cast<size_t>(y) * rowPitch);

      for (int p = 0; p < 3; ++p) {
        const uint8_t* srcRow = planes[p] + static_cast<size_t>(y) * strides[p];

        for (int x = 0; x < width; ++x) {
          float value;
          if (d->inputIsFloat) {
            value = reinterpret_cast<const float*>(srcRow)[x];
          } else if (d->inputBytesPerSample == 1) {
            value = srcRow[x] * intScale;
          } else {
            value = reinterpret_cast<const uint16_t*>(srcRow)[x] * intScale;
          }

          row[x * 4 + p] = XMConvertFloatToHalf(std::clamp(value, 0.0f, 1.0f));
        }
      }

      for (int x = 0; x < width; ++x) {
        row[x * 4 + 3] = one;
      }
    }
  }

  float readSample(const uint8_t* row, int x, bool isFloat, int bytesPerSample) {
    if (isFloat) {
      return reinterpret_cast<const float*>(row)[x];
    }
    if (bytesPerSample == 1) {
      return row[x] * (1.0f / 255.0f);
    }
    return reinterpret_cast<const uint16_t*>(row)[x] * (1.0f / 65535.0f);
  }

  // A depth clip is deliberately a single normalized plane. The NGX interface has no way to
  // infer whether an arbitrary RGB image represents metric depth, so accepting one would turn a
  // common wiring mistake into corrupted temporal history rather than a clear create-time error.
  void packDepth(const EnhanceData* d,
                 const VSFrame* src,
                 const VSAPI* vsapi,
                 uint8_t* dstBase,
                 uint32_t rowPitch) {
    const uint8_t* plane = vsapi->getReadPtr(src, 0);
    const ptrdiff_t stride = vsapi->getStride(src, 0);

    for (int y = 0; y < d->vi.height; ++y) {
      auto* dstRow = reinterpret_cast<float*>(dstBase + static_cast<size_t>(y) * rowPitch);
      const uint8_t* srcRow = plane + static_cast<size_t>(y) * stride;
      for (int x = 0; x < d->vi.width; ++x) {
        const float value = readSample(srcRow, x, d->depthIsFloat, d->depthBytesPerSample);
        // Depth values are normalized device depth. Reject NaNs and out-of-domain values at the
        // boundary instead of passing undefined reprojection data into the snippet.
        dstRow[x] = std::isfinite(value) ? std::clamp(value, 0.0f, 1.0f) : 0.0f;
      }
    }
  }

  // Motion is RGBS with R = horizontal and G = vertical displacement in signed source pixels.
  // It remains a float clip at the VS boundary so negative flow and subpixel precision survive;
  // the upload uses RG16F because that is ample for video motion and halves VRAM bandwidth.
  void packMotion(const EnhanceData* d,
                  const VSFrame* src,
                  const VSAPI* vsapi,
                  uint8_t* dstBase,
                  uint32_t rowPitch) {
    using DirectX::PackedVector::XMConvertFloatToHalf;

    const uint8_t* xPlane = vsapi->getReadPtr(src, 0);
    const uint8_t* yPlane = vsapi->getReadPtr(src, 1);
    const ptrdiff_t xStride = vsapi->getStride(src, 0);
    const ptrdiff_t yStride = vsapi->getStride(src, 1);

    for (int y = 0; y < d->vi.height; ++y) {
      auto* dstRow = reinterpret_cast<uint16_t*>(dstBase + static_cast<size_t>(y) * rowPitch);
      const auto* xRow = reinterpret_cast<const float*>(xPlane + static_cast<size_t>(y) * xStride);
      const auto* yRow = reinterpret_cast<const float*>(yPlane + static_cast<size_t>(y) * yStride);
      for (int x = 0; x < d->vi.width; ++x) {
        const float vx = std::isfinite(xRow[x]) ? xRow[x] : 0.0f;
        const float vy = std::isfinite(yRow[x]) ? yRow[x] : 0.0f;
        dstRow[x * 2] = XMConvertFloatToHalf(vx);
        dstRow[x * 2 + 1] = XMConvertFloatToHalf(vy);
      }
    }
  }

  void unpackFromHalf4(const EnhanceData* d,
                       VSFrame* dst,
                       const VSAPI* vsapi,
                       const uint8_t* srcBase,
                       uint32_t rowPitch) {
    using DirectX::PackedVector::XMConvertHalfToFloat;

    const int width = d->vi.width;
    const int height = d->vi.height;

    uint8_t* planes[3];
    ptrdiff_t strides[3];
    for (int p = 0; p < 3; ++p) {
      planes[p] = vsapi->getWritePtr(dst, p);
      strides[p] = vsapi->getStride(dst, p);
    }

    const float intScale = d->inputBytesPerSample == 1 ? 255.0f : 65535.0f;
    const float intMax = intScale;

    for (int y = 0; y < height; ++y) {
      const auto* row = reinterpret_cast<const uint16_t*>(srcBase + static_cast<size_t>(y) * rowPitch);

      for (int p = 0; p < 3; ++p) {
        uint8_t* dstRow = planes[p] + static_cast<size_t>(y) * strides[p];

        for (int x = 0; x < width; ++x) {
          const float value = XMConvertHalfToFloat(row[x * 4 + p]);

          if (d->inputIsFloat) {
            reinterpret_cast<float*>(dstRow)[x] = value;
          } else {
            const float scaled = std::clamp(value, 0.0f, 1.0f) * intScale;
            // Round to nearest rather than truncate: truncation biases the whole image down by
            // half a code value, which is visible as a slight darkening on flat gradients.
            const float rounded = std::min(scaled + 0.5f, intMax);
            if (d->inputBytesPerSample == 1) {
              dstRow[x] = static_cast<uint8_t>(rounded);
            } else {
              reinterpret_cast<uint16_t*>(dstRow)[x] = static_cast<uint16_t>(rounded);
            }
          }
        }
      }
    }
  }

  const VSFrame* VS_CC enhanceGetFrame(int n,
                                       int activationReason,
                                       void* instanceData,
                                       void** frameData,
                                       VSFrameContext* frameCtx,
                                       VSCore* core,
                                       const VSAPI* vsapi) {
    (void) frameData;
    auto* d = static_cast<EnhanceData*>(instanceData);

    if (activationReason == arInitial) {
      vsapi->requestFrameFilter(n, d->node, frameCtx);
      if (d->hasDepth) {
        vsapi->requestFrameFilter(n, d->depthNode, frameCtx);
      }
      if (d->hasMotion) {
        vsapi->requestFrameFilter(n, d->motionNode, frameCtx);
      }
      return nullptr;
    }

    if (activationReason != arAllFramesReady) {
      return nullptr;
    }

    const VSFrame* src = vsapi->getFrameFilter(n, d->node, frameCtx);
    const VSFrame* depth = d->hasDepth ? vsapi->getFrameFilter(n, d->depthNode, frameCtx) : nullptr;
    const VSFrame* motion = d->hasMotion ? vsapi->getFrameFilter(n, d->motionNode, frameCtx) : nullptr;
    VSFrame* dst = vsapi->newVideoFrame(&d->vi.format, d->vi.width, d->vi.height, src, core);

    std::lock_guard<std::mutex> guard(d->mutex);

    UpliftSettings settings = d->settings;
    settings.resetHistory = (n != d->lastFrame + 1);

    std::string error;

    auto fail = [&](const std::string& message) -> const VSFrame* {
      vsapi->setFilterError(("dlssnr.Enhance: " + message).c_str(), frameCtx);
      vsapi->freeFrame(dst);
      vsapi->freeFrame(src);
      if (depth) {
        vsapi->freeFrame(depth);
      }
      if (motion) {
        vsapi->freeFrame(motion);
      }
      // A failed evaluation did not advance the snippet's history, so the next frame must not
      // reproject against it.
      d->lastFrame = -2;
      return nullptr;
    };

    if (!d->d3d.begin(error)) {
      return fail(error);
    }

    uint8_t* upload = d->d3d.mapUpload(error);
    if (upload == nullptr) {
      return fail(error);
    }
    packToHalf4(d, src, vsapi, upload, d->d3d.stagingRowPitch());
    d->d3d.unmapUpload();

    if (d->hasDepth) {
      uint8_t* depthUpload = d->d3d.mapDepthUpload(error);
      if (depthUpload == nullptr) {
        return fail(error);
      }
      packDepth(d, depth, vsapi, depthUpload, d->d3d.depthRowPitch());
      d->d3d.unmapDepthUpload();
    }

    if (d->hasMotion) {
      uint8_t* motionUpload = d->d3d.mapMotionUpload(error);
      if (motionUpload == nullptr) {
        return fail(error);
      }
      packMotion(d, motion, vsapi, motionUpload, d->d3d.motionRowPitch());
      d->d3d.unmapMotionUpload();
    }

    d->d3d.recordPreEvaluate();

    if (!d->ngx.evaluate(d->d3d.commandList(), d->d3d.colorTexture(), d->d3d.depthTexture(),
                         d->d3d.motionTexture(), d->d3d.outputTexture(),
                         static_cast<uint32_t>(d->vi.width), static_cast<uint32_t>(d->vi.height),
                         settings, error)) {
      // The list is left open and will be reset by the next begin(); nothing was submitted.
      return fail(error);
    }

    d->d3d.recordPostEvaluate();

    if (!d->d3d.endAndWait(error)) {
      return fail(error);
    }

    const uint8_t* readback = d->d3d.mapReadback(error);
    if (readback == nullptr) {
      return fail(error);
    }
    unpackFromHalf4(d, dst, vsapi, readback, d->d3d.stagingRowPitch());
    d->d3d.unmapReadback();

    d->lastFrame = n;

    vsapi->freeFrame(src);
    if (depth) {
      vsapi->freeFrame(depth);
    }
    if (motion) {
      vsapi->freeFrame(motion);
    }
    return dst;
  }

  void VS_CC enhanceFree(void* instanceData, VSCore* core, const VSAPI* vsapi) {
    (void) core;
    auto* d = static_cast<EnhanceData*>(instanceData);
    vsapi->freeNode(d->node);
    if (d->depthNode) {
      vsapi->freeNode(d->depthNode);
    }
    if (d->motionNode) {
      vsapi->freeNode(d->motionNode);
    }
    delete d;
  }

  void VS_CC enhanceCreate(const VSMap* in,
                           VSMap* out,
                           void* userData,
                           VSCore* core,
                           const VSAPI* vsapi) {
    (void) userData;
    (void) core;

    auto d = std::make_unique<EnhanceData>();

    d->node = vsapi->mapGetNode(in, "clip", 0, nullptr);
    d->vi = *vsapi->getVideoInfo(d->node);

    auto releaseNodes = [&]() {
      if (d->node) {
        vsapi->freeNode(d->node);
        d->node = nullptr;
      }
      if (d->depthNode) {
        vsapi->freeNode(d->depthNode);
        d->depthNode = nullptr;
      }
      if (d->motionNode) {
        vsapi->freeNode(d->motionNode);
        d->motionNode = nullptr;
      }
    };

    auto bail = [&](const std::string& message) {
      vsapi->mapSetError(out, ("dlssnr.Enhance: " + message).c_str());
      releaseNodes();
    };

    if (!vsh::isConstantVideoFormat(&d->vi)) {
      bail("only clips with a constant format and dimensions are supported");
      return;
    }

    if (d->vi.format.colorFamily != cfRGB) {
      bail("input must be RGB. Convert first, and encode it as sRGB: "
           "core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s=\"709\", "
           "transfer_in_s=\"709\", transfer_s=\"srgb\", range_s=\"full\")");
      return;
    }

    d->inputIsFloat = d->vi.format.sampleType == stFloat;
    d->inputBytesPerSample = d->vi.format.bytesPerSample;

    if (d->inputIsFloat) {
      if (d->vi.format.bitsPerSample != 32) {
        bail("float input must be 32-bit (RGBS)");
        return;
      }
    } else if (d->vi.format.bitsPerSample != 8 && d->vi.format.bitsPerSample != 16) {
      bail("integer input must be 8-bit (RGB24) or 16-bit (RGB48)");
      return;
    }

    int optionalNodeError = 0;
    d->depthNode = vsapi->mapGetNode(in, "depth", 0, &optionalNodeError);
    d->hasDepth = d->depthNode != nullptr;
    d->motionNode = vsapi->mapGetNode(in, "motion", 0, &optionalNodeError);
    d->hasMotion = d->motionNode != nullptr;

    auto validateTimeline = [&](const VSVideoInfo& aux, const char* name) {
      if (!vsh::isConstantVideoFormat(&aux) || aux.width != d->vi.width ||
          aux.height != d->vi.height || aux.numFrames != d->vi.numFrames) {
        bail(std::string(name) + " must have the same constant dimensions and frame count as clip");
        return false;
      }
      return true;
    };

    if (d->hasDepth) {
      const VSVideoInfo& depthVi = *vsapi->getVideoInfo(d->depthNode);
      if (!validateTimeline(depthVi, "depth")) {
        return;
      }
      if (depthVi.format.colorFamily != cfGray || depthVi.format.numPlanes != 1) {
        bail("depth must be a single-plane gray clip (GRAY8, GRAY16, or GRAYS)");
        return;
      }
      d->depthIsFloat = depthVi.format.sampleType == stFloat;
      d->depthBytesPerSample = depthVi.format.bytesPerSample;
      if ((d->depthIsFloat && depthVi.format.bitsPerSample != 32) ||
          (!d->depthIsFloat && depthVi.format.bitsPerSample != 8 &&
           depthVi.format.bitsPerSample != 16)) {
        bail("depth must be GRAYS, GRAY8, or GRAY16 with normalized values");
        return;
      }
    }

    if (d->hasMotion) {
      const VSVideoInfo& motionVi = *vsapi->getVideoInfo(d->motionNode);
      if (!validateTimeline(motionVi, "motion")) {
        return;
      }
      if (motionVi.format.colorFamily != cfRGB || motionVi.format.numPlanes < 2 ||
          motionVi.format.sampleType != stFloat || motionVi.format.bitsPerSample != 32) {
        bail("motion must be RGBS: R = horizontal and G = vertical signed pixel displacement");
        return;
      }
    }

    int err = 0;

    auto optInt = [&](const char* name, int64_t fallback) -> int64_t {
      const int64_t value = vsapi->mapGetInt(in, name, 0, &err);
      return err ? fallback : value;
    };
    auto optFloat = [&](const char* name, double fallback) -> double {
      const double value = vsapi->mapGetFloat(in, name, 0, &err);
      return err ? fallback : value;
    };

    const int64_t style = optInt("style", 0);
    if (style < 0 || style > kNeuralUpliftMaxStyle) {
      bail("style must be 0-2; the snippet ships three style blocks and clamps anything higher");
      return;
    }
    d->settings.style = static_cast<uint32_t>(style);

    d->settings.intensity = static_cast<float>(optFloat("intensity", 1.0));
    d->settings.styleStrength = static_cast<float>(optFloat("style_strength", 1.0));
    d->settings.localStructureStrength = static_cast<float>(optFloat("local_structure", 1.0));
    // -1 is the snippet's "unset" sentinel: use local_structure for skin too. Not the same as 0,
    // which explicitly disables structure enhancement on skin.
    d->settings.skinStructureStrength = static_cast<float>(optFloat("skin_structure", -1.0));
    d->settings.autoMask = optInt("auto_mask", 1) != 0;
    const int64_t depthInverted = optInt("depth_inverted", 0);
    if (depthInverted != 0 && depthInverted != 1) {
      bail("depth_inverted must be 0 or 1");
      return;
    }
    d->settings.depthInverted = depthInverted != 0;
    d->settings.motionVectorScaleX = static_cast<float>(optFloat("motion_scale_x", 1.0));
    d->settings.motionVectorScaleY = static_cast<float>(optFloat("motion_scale_y", 1.0));
    if (!std::isfinite(d->settings.motionVectorScaleX) ||
        !std::isfinite(d->settings.motionVectorScaleY)) {
      bail("motion_scale_x and motion_scale_y must be finite");
      return;
    }

    const int preset = static_cast<int>(optInt("preset", 0));
    const auto featureId = static_cast<uint32_t>(optInt("feature_id", kNgxFeatureDlssNrDefault));
    const auto applicationId = static_cast<uint32_t>(optInt("app_id", kDefaultApplicationId));
    const bool bypassCallerCheck = optInt("bypass_caller_check", 1) != 0;

    const char* snippetArg = vsapi->mapGetData(in, "snippet", 0, &err);
    const std::wstring snippetPath = err ? std::wstring() : widen(snippetArg);

    std::string error;

    if (!d->d3d.initialize(static_cast<uint32_t>(d->vi.width), static_cast<uint32_t>(d->vi.height),
                           d->hasDepth, d->hasMotion, error)) {
      bail(error);
      return;
    }

    if (!d->ngx.load(d->d3d.device(), snippetPath, bypassCallerCheck, applicationId, error)) {
      bail(error);
      return;
    }

    // Feature creation records into a command list, so it needs one submitted and waited on
    // before the first evaluation can run.
    if (!d->d3d.begin(error)) {
      bail(error);
      return;
    }

    if (!d->ngx.createFeature(d->d3d.commandList(), static_cast<uint32_t>(d->vi.width),
                              static_cast<uint32_t>(d->vi.height), preset, featureId, error)) {
      bail(error);
      return;
    }

    if (!d->d3d.endAndWait(error)) {
      bail(error);
      return;
    }

    std::vector<VSFilterDependency> deps = { { d->node, rpStrictSpatial } };
    if (d->hasDepth) {
      deps.push_back({ d->depthNode, rpStrictSpatial });
    }
    if (d->hasMotion) {
      deps.push_back({ d->motionNode, rpStrictSpatial });
    }

    // fmFrameState, not fmParallel: the snippet carries temporal state across evaluations and
    // can only hold one frame's worth at a time, which is precisely what this mode exists for.
    vsapi->createVideoFilter(out, "Enhance", &d->vi, enhanceGetFrame, enhanceFree, fmFrameState,
                             deps.data(), static_cast<int>(deps.size()), d.get(), core);
    d.release();
  }

} // namespace

VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin* plugin, const VSPLUGINAPI* vspapi) {
  vspapi->configPlugin("com.vapourkit.dlssnr", "dlssnr", "DLSS-NR Neural Uplift",
                       VS_MAKE_VERSION(1, 0), VAPOURSYNTH_API_VERSION, 0, plugin);

  vspapi->registerFunction("Enhance",
                           "clip:vnode;"
                           "depth:vnode:opt;"
                           "motion:vnode:opt;"
                           "style:int:opt;"
                           "intensity:float:opt;"
                           "style_strength:float:opt;"
                           "local_structure:float:opt;"
                           "skin_structure:float:opt;"
                           "auto_mask:int:opt;"
                           "depth_inverted:int:opt;"
                           "motion_scale_x:float:opt;"
                           "motion_scale_y:float:opt;"
                           "preset:int:opt;"
                           "feature_id:int:opt;"
                           "app_id:int:opt;"
                           "snippet:data:opt;"
                           "bypass_caller_check:int:opt;",
                           "clip:vnode;", enhanceCreate, nullptr, plugin);
}
