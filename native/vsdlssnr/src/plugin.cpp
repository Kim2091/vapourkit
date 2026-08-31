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
#include <chrono>
#include <thread>
#include <cstdlib>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include <DirectXPackedVector.h>

#include "VSHelper4.h"
#include "VapourSynth4.h"

#include <intrin.h>

#include "convert_simd.h"
#include "d3d12_ctx.h"
#include "dlssnr_params.h"
#include "log.h"
#include "ngx_uplift.h"
#include "vulkan_backend.h"

namespace vsdlssnr {

  // Deliberately in this translation unit, which is built for baseline x64. A CPUID probe
  // compiled with /arch:AVX2 can be handed AVX2 instructions by the optimizer and fault on the
  // very CPUs it exists to detect.
  bool hasAvx2F16c() {
    static const bool supported = [] {
      int info[4] = {};
      __cpuid(info, 0);
      if (info[0] < 7) {
        return false;
      }
      __cpuid(info, 1);
      const bool osxsave = (info[2] & (1 << 27)) != 0;
      const bool avx = (info[2] & (1 << 28)) != 0;
      const bool f16c = (info[2] & (1 << 29)) != 0;
      if (!osxsave || !avx || !f16c) {
        return false;
      }
      // OSXSAVE only says the OS *can* save extended state; bits 1 and 2 of XCR0 say it does
      // save XMM and YMM. Without them a VEX instruction faults.
      if ((_xgetbv(0) & 0x6u) != 0x6u) {
        return false;
      }
      __cpuidex(info, 7, 0);
      if ((info[1] & (1 << 5)) == 0) {
        return false;
      }
      // An escape hatch, so the scalar path can be exercised on a machine that has AVX2. The
      // two are meant to be bitwise identical; this is how that gets checked.
      return std::getenv("VSDLSSNR_NO_SIMD") == nullptr;
    }();
    return supported;
  }

} // namespace vsdlssnr

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

    // The Vulkan alternative. Non-null only when backend="vulkan", in which case d3d and ngx
    // above are never initialized and never touched. It owns its own device context and NGX
    // state in the right destruction order internally, so its position here does not matter.
    std::unique_ptr<VulkanBackend> vk;
    bool useVulkan = false;

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
    // Diagnostic: return the motion field instead of an enhanced frame.
    bool debugMotion = false;
    bool autoMotion = false;

    // One frame is evaluated ahead of the one being returned, so the CPU pack and unpack run
    // while the GPU is busy instead of on either side of a blocking fence. See enhanceGetFrame.
    bool pipeline = false;
    int inflightFrame = -1;
    uint32_t inflightSlot = 0;
    int previousRequested = -2;

    // Phase timing, enabled by setting VSDLSSNR_PROFILE. Off by default and costing two clock
    // reads per phase when on, so it can stay in a release build: the alternative is guessing
    // which part of a 100ms frame is the expensive one.
    bool profile = false;
    double tPack = 0.0, tRecord = 0.0, tGpu = 0.0, tUnpack = 0.0, tAutoMotion = 0.0;
    int profiledFrames = 0;
    // GPU-side split of the opaque gpu+wait number, from the queue's own timestamps.
    double gUpload = 0.0, gEval = 0.0, gRead = 0.0, gTotal = 0.0;
    double gSubmit = 0.0, gWait = 0.0, gLatency = 0.0;
    int gpuTimedFrames = 0;
  };

  using ProfileClock = std::chrono::steady_clock;

  // Splits a frame's rows across worker threads.
  //
  // The pack and unpack loops were the whole cost of a frame - 77ms of 101ms at 4K - and ran on
  // one core while the other thirty-one idled. They are embarrassingly parallel over rows: each
  // row reads and writes only its own slice of both buffers.
  //
  // Threads are created per call rather than pooled. That costs on the order of 0.2ms against a
  // budget of tens of milliseconds, and a pool would have to outlive the frame and be shared
  // with VapourSynth's own scheduler, which is a lot of machinery for the last fraction of a
  // percent. Capped at 16 because this filter is fmFrameState - the rest of the graph still
  // wants cores.
  template <typename Fn>
  void parallelRows(int height, const Fn& fn) {
    const unsigned hardware = std::thread::hardware_concurrency();
    int workers = static_cast<int>(std::min<unsigned>(hardware ? hardware : 1u, 16u));
    if (workers > height / 16) {
      workers = std::max(1, height / 16);
    }

    if (workers <= 1) {
      fn(0, height);
      return;
    }

    std::vector<std::thread> threads;
    threads.reserve(static_cast<size_t>(workers) - 1);

    const int band = (height + workers - 1) / workers;
    for (int w = 1; w < workers; ++w) {
      const int begin = w * band;
      const int end = std::min(height, begin + band);
      if (begin >= end) {
        break;
      }
      threads.emplace_back([&fn, begin, end] { fn(begin, end); });
    }

    fn(0, std::min(height, band)); // This thread takes the first band rather than idling.

    for (std::thread& t : threads) {
      t.join();
    }
  }

  inline double msSince(ProfileClock::time_point start) {
    return std::chrono::duration<double, std::milli>(ProfileClock::now() - start).count();
  }

  void logProfile(const EnhanceData* d) {
    const double f = d->profiledFrames;
    std::ostringstream os;
    os << "profile over " << d->profiledFrames << " frames (ms/frame): "
       << "pack " << d->tPack / f << ", record " << d->tRecord / f
       << ", gpu+wait " << d->tGpu / f << ", unpack " << d->tUnpack / f;
    if (d->tAutoMotion > 0.0) {
      os << ", auto-motion " << d->tAutoMotion / f;
    }
    os << ", total "
       << (d->tPack + d->tRecord + d->tGpu + d->tUnpack + d->tAutoMotion) / f;
    logInfo(os.str());
    if (d->gpuTimedFrames > 0) {
      const double gf = d->gpuTimedFrames;
      std::ostringstream gs;
      gs << "  gpu over " << d->gpuTimedFrames << " frames (ms/frame): "
         << "upload " << d->gUpload / gf << ", evaluate " << d->gEval / gf
         << ", readback " << d->gRead / gf << ", gpu total " << d->gTotal / gf
         << " | cpu submit " << d->gSubmit / gf << ", submit->done " << d->gWait / gf
         << ", queue latency " << d->gLatency / gf;
      logInfo(gs.str());
    }
  }

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
    const uint64_t one = XMConvertFloatToHalf(1.0f);
    const bool isFloat = d->inputIsFloat;
    const int bytesPerSample = d->inputBytesPerSample;
    // RGBS on any CPU of the last decade. The scalar body below is still the only path for
    // integer input and for CPUs without F16C, and remains the definition of correct.
    const bool useSimd = isFloat && hasAvx2F16c();

    parallelRows(height, [&](int rowBegin, int rowEnd) {
      for (int y = rowBegin; y < rowEnd; ++y) {
        auto* row = reinterpret_cast<uint64_t*>(dstBase + static_cast<size_t>(y) * rowPitch);
        const uint8_t* rRow = planes[0] + static_cast<size_t>(y) * strides[0];
        const uint8_t* gRow = planes[1] + static_cast<size_t>(y) * strides[1];
        const uint8_t* bRow = planes[2] + static_cast<size_t>(y) * strides[2];

        if (useSimd) {
          packRowRgbaHalfAvx2(reinterpret_cast<const float*>(rRow),
                              reinterpret_cast<const float*>(gRow),
                              reinterpret_cast<const float*>(bRow), row, width);
          continue;
        }

        // One sequential 64-bit store per pixel, assembled in a register.
        //
        // This buffer lives in a D3D12 UPLOAD heap, which is write-combined: it only reaches
        // full bandwidth on sequential, full-width writes, and degrades badly on partial ones.
        // Reading the three planes in a single interleaved pass and writing each whole RGBA
        // pixel once was worth far more than threading the old three-strided-passes version,
        // which wrote two bytes out of every eight and left write-combining nothing to combine.
        // Alpha rides along in the same store, so writing it costs nothing.
        for (int x = 0; x < width; ++x) {
          float r, g, b;
          if (isFloat) {
            r = reinterpret_cast<const float*>(rRow)[x];
            g = reinterpret_cast<const float*>(gRow)[x];
            b = reinterpret_cast<const float*>(bRow)[x];
          } else if (bytesPerSample == 1) {
            r = rRow[x] * intScale;
            g = gRow[x] * intScale;
            b = bRow[x] * intScale;
          } else {
            r = reinterpret_cast<const uint16_t*>(rRow)[x] * intScale;
            g = reinterpret_cast<const uint16_t*>(gRow)[x] * intScale;
            b = reinterpret_cast<const uint16_t*>(bRow)[x] * intScale;
          }

          const uint64_t packed =
            static_cast<uint64_t>(XMConvertFloatToHalf(std::clamp(r, 0.0f, 1.0f))) |
            (static_cast<uint64_t>(XMConvertFloatToHalf(std::clamp(g, 0.0f, 1.0f))) << 16) |
            (static_cast<uint64_t>(XMConvertFloatToHalf(std::clamp(b, 0.0f, 1.0f))) << 32) |
            (one << 48);
          row[x] = packed;
        }
      }
    });
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

  // D3D12 Video motion estimation takes NV12, but it is interested in image motion rather
  // than colour. Feed it a stable Rec.709 luma plane and neutral chroma; this avoids an RGB ->
  // YUV conversion filter and keeps the auxiliary pass fixed-function after this small upload.
  void packAutoMotionLuma(const EnhanceData* d,
                          const VSFrame* src,
                          const VSAPI* vsapi,
                          uint8_t* dstBase,
                          uint32_t lumaRowPitch,
                          uint32_t chromaRowPitch,
                          uint64_t chromaOffset,
                          uint32_t motionWidth,
                          uint32_t motionHeight,
                          uint32_t motionScale) {
    const uint8_t* planes[3];
    ptrdiff_t strides[3];
    for (int p = 0; p < 3; ++p) {
      planes[p] = vsapi->getReadPtr(src, p);
      strides[p] = vsapi->getStride(src, p);
    }

    // Two million scalar RGB->luma conversions per 4K frame, and this used to run on one core
    // while the rest of the frame was already threaded. Rows are independent.
    parallelRows(static_cast<int>(motionHeight), [&](int rowBegin, int rowEnd) {
      for (uint32_t y = static_cast<uint32_t>(rowBegin); y < static_cast<uint32_t>(rowEnd); ++y) {
        uint8_t* dstRow = dstBase + static_cast<size_t>(y) * lumaRowPitch;
        const uint32_t sourceY = std::min(y * motionScale, static_cast<uint32_t>(d->vi.height - 1));
        const uint8_t* rRow = planes[0] + static_cast<size_t>(sourceY) * strides[0];
        const uint8_t* gRow = planes[1] + static_cast<size_t>(sourceY) * strides[1];
        const uint8_t* bRow = planes[2] + static_cast<size_t>(sourceY) * strides[2];
        for (uint32_t x = 0; x < motionWidth; ++x) {
          const uint32_t sourceX = std::min(x * motionScale, static_cast<uint32_t>(d->vi.width - 1));
          const float r = readSample(rRow, static_cast<int>(sourceX), d->inputIsFloat, d->inputBytesPerSample);
          const float g = readSample(gRow, static_cast<int>(sourceX), d->inputIsFloat, d->inputBytesPerSample);
          const float b = readSample(bRow, static_cast<int>(sourceX), d->inputIsFloat, d->inputBytesPerSample);
          const float luma = std::isfinite(r) && std::isfinite(g) && std::isfinite(b)
            ? std::clamp(0.2126f * r + 0.7152f * g + 0.0722f * b, 0.0f, 1.0f)
            : 0.0f;
          dstRow[x] = static_cast<uint8_t>(luma * 255.0f + 0.5f);
        }
      }
    });

    // Neutral U/V makes the input an exact greyscale image. Both NV12 planes use the motion
    // input width in bytes; the texture is guaranteed even-sized before this path is enabled.
    for (uint32_t y = 0; y < motionHeight / 2; ++y) {
      std::memset(dstBase + chromaOffset + static_cast<size_t>(y) * chromaRowPitch, 128,
                  static_cast<size_t>(motionWidth));
    }
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

    parallelRows(d->vi.height, [&](int rowBegin, int rowEnd) {
      for (int y = rowBegin; y < rowEnd; ++y) {
        auto* dstRow = reinterpret_cast<float*>(dstBase + static_cast<size_t>(y) * rowPitch);
        const uint8_t* srcRow = plane + static_cast<size_t>(y) * stride;
        for (int x = 0; x < d->vi.width; ++x) {
          const float value = readSample(srcRow, x, d->depthIsFloat, d->depthBytesPerSample);
          // Depth values are normalized device depth. Reject NaNs and out-of-domain values at
          // the boundary instead of passing undefined reprojection data into the snippet.
          dstRow[x] = std::isfinite(value) ? std::clamp(value, 0.0f, 1.0f) : 0.0f;
        }
      }
    });
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

    parallelRows(d->vi.height, [&](int rowBegin, int rowEnd) {
      for (int y = rowBegin; y < rowEnd; ++y) {
        auto* dstRow = reinterpret_cast<uint16_t*>(dstBase + static_cast<size_t>(y) * rowPitch);
        const auto* xRow =
          reinterpret_cast<const float*>(xPlane + static_cast<size_t>(y) * xStride);
        const auto* yRow =
          reinterpret_cast<const float*>(yPlane + static_cast<size_t>(y) * yStride);
        for (int x = 0; x < d->vi.width; ++x) {
          const float vx = std::isfinite(xRow[x]) ? xRow[x] : 0.0f;
          const float vy = std::isfinite(yRow[x]) ? yRow[x] : 0.0f;
          dstRow[x * 2] = XMConvertFloatToHalf(vx);
          dstRow[x * 2 + 1] = XMConvertFloatToHalf(vy);
        }
      }
    });
  }

  // Writes the estimated motion field into the output frame as raw pixel offsets: R carries the
  // horizontal component, G the vertical, B is zeroed. Deliberately unnormalised - the point is
  // to read the actual magnitudes back out with PlaneStats, not to look at a pretty picture.
  void unpackMotionField(const EnhanceData* d,
                         VSFrame* dst,
                         const VSAPI* vsapi,
                         const uint8_t* srcBase,
                         uint32_t rowPitch,
                         bool motionValid) {
    using DirectX::PackedVector::XMConvertHalfToFloat;

    const int width = d->vi.width;
    const int height = d->vi.height;

    float* planes[3];
    ptrdiff_t strides[3];
    for (int p = 0; p < 3; ++p) {
      planes[p] = reinterpret_cast<float*>(vsapi->getWritePtr(dst, p));
      strides[p] = vsapi->getStride(dst, p) / static_cast<ptrdiff_t>(sizeof(float));
    }

    for (int y = 0; y < height; ++y) {
      float* rRow = planes[0] + static_cast<size_t>(y) * strides[0];
      float* gRow = planes[1] + static_cast<size_t>(y) * strides[1];
      float* bRow = planes[2] + static_cast<size_t>(y) * strides[2];

      // A frame with no motion bound - the first of a sequence, or after a reset - reports an
      // exactly zero field rather than whatever the texture happens to still hold.
      const auto* row = reinterpret_cast<const uint16_t*>(srcBase + static_cast<size_t>(y) * rowPitch);

      for (int x = 0; x < width; ++x) {
        rRow[x] = motionValid ? XMConvertHalfToFloat(row[x * 2 + 0]) : 0.0f;
        gRow[x] = motionValid ? XMConvertHalfToFloat(row[x * 2 + 1]) : 0.0f;
        bRow[x] = 0.0f;
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
    const bool isFloat = d->inputIsFloat;
    const int bytesPerSample = d->inputBytesPerSample;
    const bool useSimd = isFloat && hasAvx2F16c();

    parallelRows(height, [&](int rowBegin, int rowEnd) {
      for (int y = rowBegin; y < rowEnd; ++y) {
        const auto* row =
          reinterpret_cast<const uint16_t*>(srcBase + static_cast<size_t>(y) * rowPitch);

        if (useSimd) {
          // One pass over the interleaved row instead of three, which also stops the scalar
          // version's habit of walking the same cache lines once per plane.
          unpackRowRgbaHalfAvx2(
            row,
            reinterpret_cast<float*>(planes[0] + static_cast<size_t>(y) * strides[0]),
            reinterpret_cast<float*>(planes[1] + static_cast<size_t>(y) * strides[1]),
            reinterpret_cast<float*>(planes[2] + static_cast<size_t>(y) * strides[2]),
            width);
          continue;
        }

        for (int p = 0; p < 3; ++p) {
          uint8_t* dstRow = planes[p] + static_cast<size_t>(y) * strides[p];

          for (int x = 0; x < width; ++x) {
            const float value = XMConvertHalfToFloat(row[x * 4 + p]);

            if (isFloat) {
              reinterpret_cast<float*>(dstRow)[x] = value;
            } else {
              const float scaled = std::clamp(value, 0.0f, 1.0f) * intScale;
              // Round to nearest rather than truncate: truncation biases the whole image down
              // by half a code value, visible as a slight darkening on flat gradients.
              const float rounded = std::min(scaled + 0.5f, intMax);
              if (bytesPerSample == 1) {
                dstRow[x] = static_cast<uint8_t>(rounded);
              } else {
                reinterpret_cast<uint16_t*>(dstRow)[x] = static_cast<uint16_t>(rounded);
              }
            }
          }
        }
      }
    });
  }

  // The two halves of a colour-only frame, kept apart so the pipelined path can put the GPU
  // wait between them: the pack writes a staging slot and needs no command list, while the
  // record and submit need one and may only reset the shared allocator once the previous
  // submission has completed.
  bool packColourSlot(EnhanceData* d,
                      const VSFrame* frame,
                      const VSAPI* vsapi,
                      uint32_t slot,
                      double& packMs,
                      std::string& error) {
    const auto start = ProfileClock::now();
    uint8_t* upload = d->d3d.mapUpload(slot, error);
    if (upload == nullptr) {
      return false;
    }
    packToHalf4(d, frame, vsapi, upload, d->d3d.stagingRowPitch());
    d->d3d.unmapUpload(slot);
    packMs += msSince(start);
    return true;
  }

  bool submitColourSlot(EnhanceData* d,
                        uint32_t slot,
                        const UpliftSettings& settings,
                        double& recordMs,
                        std::string& error) {
    const auto start = ProfileClock::now();
    if (!d->d3d.begin(error)) {
      return false;
    }
    d->d3d.recordPreEvaluate(false, slot);
    if (!d->ngx.evaluate(d->d3d.commandList(), d->d3d.colorTexture(), nullptr, nullptr,
                         d->d3d.outputTexture(), static_cast<uint32_t>(d->vi.width),
                         static_cast<uint32_t>(d->vi.height), settings, error)) {
      return false;
    }
    d->d3d.recordPostEvaluate(slot);
    const bool ok = d->d3d.submit(error);
    recordMs += msSince(start);
    return ok;
  }

  const VSFrame* VS_CC enhanceGetFrame(int n,
                                       int activationReason,
                                       void* instanceData,
                                       void** frameData,
                                       VSFrameContext* frameCtx,
                                       VSCore* core,
                                       const VSAPI* vsapi) {
    auto* d = static_cast<EnhanceData*>(instanceData);

    if (activationReason == arInitial) {
      vsapi->requestFrameFilter(n, d->node, frameCtx);
      if (d->hasDepth) {
        vsapi->requestFrameFilter(n, d->depthNode, frameCtx);
      }
      if (d->hasMotion) {
        vsapi->requestFrameFilter(n, d->motionNode, frameCtx);
      }
      // Only run ahead while the caller is actually walking forward. Scrubbing a preview asks
      // for scattered single frames, and speculating there would evaluate - and pay for - a
      // second frame nobody wanted. previousRequested is written under fmFrameState, which
      // gives this filter one getFrame call at a time, so it needs no lock.
      if (d->pipeline && n == d->previousRequested + 1 && n + 1 < d->vi.numFrames) {
        vsapi->requestFrameFilter(n + 1, d->node, frameCtx);
        *frameData = reinterpret_cast<void*>(static_cast<uintptr_t>(1));
      }
      return nullptr;
    }

    if (activationReason != arAllFramesReady) {
      return nullptr;
    }

    const VSFrame* src = vsapi->getFrameFilter(n, d->node, frameCtx);
    const VSFrame* srcNext = (*frameData != nullptr)
      ? vsapi->getFrameFilter(n + 1, d->node, frameCtx)
      : nullptr;
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
      if (srcNext) {
        vsapi->freeFrame(srcNext);
      }
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

    auto releaseSources = [&]() {
      vsapi->freeFrame(src);
      if (srcNext) {
        vsapi->freeFrame(srcNext);
      }
      if (depth) {
        vsapi->freeFrame(depth);
      }
      if (motion) {
        vsapi->freeFrame(motion);
      }
    };

    // The Vulkan backend runs the same sequence with none of the auto-motion machinery, which
    // is D3D12 Video and has no Vulkan counterpart. Kept as a separate block rather than folded
    // into the D3D12 one: the working D3D12 path is verified, and this must not be able to
    // perturb it.
    if (d->useVulkan) {
      VulkanBackend& vk = *d->vk;

      if (!vk.begin(error)) {
        return fail(error);
      }

      const auto tPackStart = ProfileClock::now();
      uint8_t* upload = vk.mapUpload(error);
      if (upload == nullptr) {
        return fail(error);
      }
      packToHalf4(d, src, vsapi, upload, vk.stagingRowPitch());
      vk.unmapUpload();
      if (d->profile) {
        d->tPack += msSince(tPackStart);
      }

      const auto tRecordStart = ProfileClock::now();

      if (d->hasDepth) {
        uint8_t* depthUpload = vk.mapDepthUpload(error);
        if (depthUpload == nullptr) {
          return fail(error);
        }
        packDepth(d, depth, vsapi, depthUpload, vk.depthRowPitch());
        vk.unmapDepthUpload();
      }

      if (d->hasMotion) {
        uint8_t* motionUpload = vk.mapMotionUpload(error);
        if (motionUpload == nullptr) {
          return fail(error);
        }
        packMotion(d, motion, vsapi, motionUpload, vk.motionRowPitch());
        vk.unmapMotionUpload();
      }

      vk.recordPreEvaluate(d->hasMotion);

      if (!vk.evaluate(d->hasMotion, settings, error)) {
        // The buffer is left open and will be reset by the next begin(); nothing was submitted.
        return fail(error);
      }

      vk.recordPostEvaluate();

      if (d->profile) {
        d->tRecord += msSince(tRecordStart);
      }

      const auto tGpuStart = ProfileClock::now();
      if (!vk.endAndWait(error)) {
        return fail(error);
      }
      if (d->profile) {
        d->tGpu += msSince(tGpuStart);
      }

      const auto tUnpackStart = ProfileClock::now();
      const uint8_t* readback = vk.mapReadback(error);
      if (readback == nullptr) {
        return fail(error);
      }
      unpackFromHalf4(d, dst, vsapi, readback, vk.stagingRowPitch());
      vk.unmapReadback();

      if (d->profile) {
        d->tUnpack += msSince(tUnpackStart);
        if (++d->profiledFrames % 30 == 0) {
          logProfile(d);
        }
      }

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

    // Pipelined colour-only path.
    //
    // The serial version blocked on a fence for the whole GPU evaluation - more than half the
    // frame - with every core idle, then did all of its CPU work with the GPU idle. Measured at
    // 4K the GPU was busy 21ms of a 44ms frame and nvidia-smi agreed: 42% utilisation, which is
    // exactly 21/44. There was never a submission cost to remove; there was a hole to fill.
    //
    // Frame n+1 is packed while the GPU is still evaluating frame n, submitted the moment the
    // fence for n clears, and frame n is then unpacked while the GPU works on n+1. DLSS-NR sees
    // the same evaluations in the same order with the same reset flags, so the output does not
    // move. Only one submission is ever outstanding, so the shared command allocator is still
    // only reset after a wait; what is doubled is the staging pair, so the buffer being unpacked
    // is not the one the GPU is writing.
    //
    // Speculating past the frame the caller asked for is safe because lastFrame records what was
    // actually evaluated, not what was asked for: a caller that then jumps elsewhere gets Reset
    // asserted exactly as before, and one that continues forward finds its frame already done.
    if (d->pipeline) {
      double packMs = 0.0, recordMs = 0.0, gpuMs = 0.0, unpackMs = 0.0;

      auto failPipelined = [&](const std::string& message) -> const VSFrame* {
        // Something may still be queued that this call can no longer account for, and the next
        // begin() would reset the command allocator underneath it.
        std::string ignored;
        d->d3d.drain(ignored);
        d->inflightFrame = -1;
        d->previousRequested = -2;
        return fail(message);
      };

      if (d->inflightFrame != n) {
        // Either the first frame of a forward run, or the caller went somewhere the speculation
        // did not predict. Retire whatever is in flight and start this frame from scratch.
        if (d->inflightFrame >= 0) {
          const auto waitStart = ProfileClock::now();
          const bool ok = d->d3d.wait(error);
          gpuMs += msSince(waitStart);
          d->inflightFrame = -1;
          if (!ok) {
            return failPipelined(error);
          }
        }

        settings.resetHistory = (n != d->lastFrame + 1);
        if (!packColourSlot(d, src, vsapi, d->inflightSlot, packMs, error) ||
            !submitColourSlot(d, d->inflightSlot, settings, recordMs, error)) {
          return failPipelined(error);
        }
        d->lastFrame = n;
        d->inflightFrame = n;
      }

      const uint32_t doneSlot = d->inflightSlot;
      const uint32_t nextSlot = doneSlot ^ 1u;
      d->inflightFrame = -1;

      // Packing n+1 here, before the wait, is the entire point of this path: it is ~5ms of
      // memory traffic that now happens while the GPU is mid-evaluation instead of after it.
      bool packedNext = false;
      if (srcNext != nullptr) {
        if (!packColourSlot(d, srcNext, vsapi, nextSlot, packMs, error)) {
          return failPipelined(error);
        }
        packedNext = true;
      }

      // Snapshot before anything else touches the context: the next submission's begin() clears
      // the query state, and in this path that happens before the frame is even unpacked.
      D3D12Context::GpuTimings gpuTimings;
      {
        const auto waitStart = ProfileClock::now();
        const bool ok = d->d3d.wait(error);
        gpuMs += msSince(waitStart);
        if (!ok) {
          return failPipelined(error);
        }
        gpuTimings = d->d3d.lastGpuTimings();
      }

      if (packedNext) {
        UpliftSettings nextSettings = d->settings;
        nextSettings.resetHistory = false; // n+1 directly follows the evaluation just finished
        if (!submitColourSlot(d, nextSlot, nextSettings, recordMs, error)) {
          return failPipelined(error);
        }
        d->lastFrame = n + 1;
        d->inflightFrame = n + 1;
        d->inflightSlot = nextSlot;
      }

      {
        const auto unpackStart = ProfileClock::now();
        const uint8_t* readback = d->d3d.mapReadback(doneSlot, error);
        if (readback == nullptr) {
          return failPipelined(error);
        }
        unpackFromHalf4(d, dst, vsapi, readback, d->d3d.stagingRowPitch());
        d->d3d.unmapReadback(doneSlot);
        unpackMs += msSince(unpackStart);
      }

      if (d->profile) {
        d->tPack += packMs;
        d->tRecord += recordMs;
        d->tGpu += gpuMs;
        d->tUnpack += unpackMs;
        if (gpuTimings.valid) {
          d->gUpload += gpuTimings.uploadMs;
          d->gEval += gpuTimings.evaluateMs;
          d->gRead += gpuTimings.readbackMs;
          d->gTotal += gpuTimings.totalMs;
          d->gSubmit += gpuTimings.submitMs;
          d->gWait += gpuTimings.waitMs;
          d->gLatency += gpuTimings.latencyMs;
          ++d->gpuTimedFrames;
        }
        if (++d->profiledFrames % 30 == 0) {
          logProfile(d);
        }
      }

      d->previousRequested = n;
      releaseSources();
      return dst;
    }

    // In the normal case automatic flow is created here. It is intentionally omitted on a
    // reset frame: there is no trustworthy predecessor after a seek, and DLSS-NR receives the
    // matching Reset flag below. A caller-provided motion clip always takes precedence.
    bool haveGeneratedMotion = false;
    if (d->autoMotion) {
      // Timed as one phase. It is the whole reason auto_motion=1 is slower than colour-only:
      // an NV12 pack, a command list on the direct queue with a blocking wait, and a video-queue
      // submission with a second blocking wait. Both waits are deliberate driver workarounds -
      // see endAutoMotionInputAndGenerate - which is also why this path is not pipelined.
      const auto tAutoStart = ProfileClock::now();
      const auto finishAutoTiming = [&] {
        if (d->profile) {
          d->tAutoMotion += msSince(tAutoStart);
        }
      };
      if (!d->d3d.beginAutoMotion(error)) {
        finishAutoTiming();
        return fail(error);
      }
      uint8_t* autoUpload = d->d3d.mapAutoMotionUpload(error);
      if (autoUpload == nullptr) {
        finishAutoTiming();
        return fail(error);
      }
      packAutoMotionLuma(d, src, vsapi, autoUpload, d->d3d.autoMotionLumaRowPitch(),
                         d->d3d.autoMotionChromaRowPitch(), d->d3d.autoMotionChromaOffset(),
                         d->d3d.autoMotionInputWidth(), d->d3d.autoMotionInputHeight(),
                         d->d3d.autoMotionScale());
      d->d3d.unmapAutoMotionUpload();
      d->d3d.recordAutoMotionInput(!settings.resetHistory);
      const bool generated = d->d3d.endAutoMotionInputAndGenerate(!settings.resetHistory, error);
      finishAutoTiming();
      if (!generated) {
        return fail(error);
      }
      haveGeneratedMotion = !settings.resetHistory;
    }

    if (!d->d3d.begin(error)) {
      return fail(error);
    }

    const auto tPackStart = ProfileClock::now();
    uint8_t* upload = d->d3d.mapUpload(0, error);
    if (upload == nullptr) {
      return fail(error);
    }
    packToHalf4(d, src, vsapi, upload, d->d3d.stagingRowPitch());
    d->d3d.unmapUpload(0);
    if (d->profile) {
      d->tPack += msSince(tPackStart);
    }
    const auto tRecordStart = ProfileClock::now();

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

    if (haveGeneratedMotion) {
      d->d3d.recordAutoMotionExpand();
    }

    // Diagnostic mode returns the motion field instead of an enhanced image, so the estimator
    // can be judged on its own output rather than inferred from what DLSS-NR did with it. The
    // NGX evaluation is skipped entirely: this is not a frame anybody wants enhanced.
    if (d->debugMotion) {
      d->d3d.recordMotionReadback();

      if (!d->d3d.endAndWait(error)) {
        return fail(error);
      }

      const uint8_t* motionReadback = d->d3d.mapMotionReadback(error);
      if (motionReadback == nullptr) {
        return fail(error);
      }
      unpackMotionField(d, dst, vsapi, motionReadback, d->d3d.motionRowPitch(),
                        d->hasMotion || haveGeneratedMotion);
      d->d3d.unmapMotionReadback();

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

    d->d3d.recordPreEvaluate(d->hasMotion);

    if (!d->ngx.evaluate(d->d3d.commandList(), d->d3d.colorTexture(), d->d3d.depthTexture(),
                         (d->hasMotion || haveGeneratedMotion) ? d->d3d.motionTexture() : nullptr,
                         d->d3d.outputTexture(),
                         static_cast<uint32_t>(d->vi.width), static_cast<uint32_t>(d->vi.height),
                         settings, error)) {
      // The list is left open and will be reset by the next begin(); nothing was submitted.
      return fail(error);
    }

    d->d3d.recordPostEvaluate();

    if (d->profile) {
      d->tRecord += msSince(tRecordStart);
    }

    const auto tGpuStart = ProfileClock::now();
    if (!d->d3d.endAndWait(error)) {
      return fail(error);
    }
    if (d->profile) {
      d->tGpu += msSince(tGpuStart);
      const D3D12Context::GpuTimings& g = d->d3d.lastGpuTimings();
      if (g.valid) {
        d->gUpload += g.uploadMs;
        d->gEval += g.evaluateMs;
        d->gRead += g.readbackMs;
        d->gTotal += g.totalMs;
        d->gSubmit += g.submitMs;
        d->gWait += g.waitMs;
        d->gLatency += g.latencyMs;
        ++d->gpuTimedFrames;
      }
    }

    const auto tUnpackStart = ProfileClock::now();
    const uint8_t* readback = d->d3d.mapReadback(0, error);
    if (readback == nullptr) {
      return fail(error);
    }
    unpackFromHalf4(d, dst, vsapi, readback, d->d3d.stagingRowPitch());
    d->d3d.unmapReadback(0);

    if (d->profile) {
      d->tUnpack += msSince(tUnpackStart);
      if (++d->profiledFrames % 30 == 0) {
        logProfile(d);
      }
    }

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

    d->profile = std::getenv("VSDLSSNR_PROFILE") != nullptr;
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

    // d3d12 stays the default. Vulkan is the newer path and has to earn its way to being the
    // default by being measured, not by being written.
    const char* backendArg = vsapi->mapGetData(in, "backend", 0, &err);
    const std::string backendName = (err || backendArg == nullptr) ? "d3d12" : backendArg;
    if (backendName != "d3d12" && backendName != "vulkan") {
      bail("backend must be \"d3d12\" or \"vulkan\"");
      return;
    }
    d->useVulkan = backendName == "vulkan";

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
    const int64_t autoMotion = optInt("auto_motion", 1);
    // Whether the script actually asked for it, as opposed to inheriting the default. optInt
    // leaves err set when the argument was absent.
    const bool autoMotionRequested = err == 0;
    if (autoMotion != 0 && autoMotion != 1) {
      bail("auto_motion must be 0 or 1");
      return;
    }

    // Automatic motion is D3D12 Video fixed-function motion estimation. Vulkan has no equivalent
    // - VK_NV_optical_flow is a different mechanism and a separate piece of work - so an explicit
    // request for it on this backend is an error rather than a silent downgrade. Left at its
    // default it degrades to colour-only and says so, which is what D3D12 already does on
    // hardware whose driver does not expose the estimator.
    if (d->useVulkan && autoMotion != 0) {
      if (autoMotionRequested) {
        bail("auto_motion is not supported with backend=\"vulkan\": it uses D3D12 Video motion "
             "estimation, which has no Vulkan counterpart. Pass auto_motion=0, supply a motion "
             "clip, or use backend=\"d3d12\".");
        return;
      }
      logInfo("Automatic motion is unavailable on the Vulkan backend; running colour-only. "
              "Supply a motion clip, or use backend=\"d3d12\" for D3D12 Video motion estimation.");
    }

    // An explicitly supplied vector clip is higher-quality whenever it comes from the source
    // renderer, so it wins over the video-estimator fallback without making the script choose.
    const bool wantAutoMotion = !d->useVulkan && !d->hasMotion && autoMotion != 0;

    d->debugMotion = optInt("debug_motion", 0) != 0;
    if (d->debugMotion) {
      // The field is written as raw pixel offsets, which are routinely negative and can exceed
      // one, so an integer output format would silently clamp exactly the values being measured.
      if (!d->inputIsFloat) {
        bail("debug_motion requires a 32-bit float clip (RGBS); motion is written as raw signed "
             "pixel offsets, which an integer format would clamp");
        return;
      }
      if (d->useVulkan) {
        bail("debug_motion is only implemented on backend=\"d3d12\": it reads the motion texture "
             "back, which exists to inspect the D3D12 Video estimator");
        return;
      }
      if (!d->hasMotion && !wantAutoMotion) {
        bail("debug_motion needs motion to look at: supply a motion clip, or leave auto_motion on");
        return;
      }
    }

    const int preset = static_cast<int>(optInt("preset", 0));
    const auto featureId = static_cast<uint32_t>(optInt("feature_id", kNgxFeatureDlssNrDefault));
    const auto applicationId = static_cast<uint32_t>(optInt("app_id", kDefaultApplicationId));
    const bool bypassCallerCheck = optInt("bypass_caller_check", 1) != 0;

    const char* snippetArg = vsapi->mapGetData(in, "snippet", 0, &err);
    const std::wstring snippetPath = err ? std::wstring() : widen(snippetArg);

    std::string error;

    if (d->useVulkan) {
      // Device creation, snippet load and feature creation all happen inside the backend, which
      // is the only thing in this file that knows Vulkan exists.
      VulkanBackendConfig config;
      config.width = static_cast<uint32_t>(d->vi.width);
      config.height = static_cast<uint32_t>(d->vi.height);
      config.needDepth = d->hasDepth;
      config.needMotion = d->hasMotion;
      config.snippetPath = snippetPath;
      config.bypassCallerCheck = bypassCallerCheck;
      config.applicationId = applicationId;
      config.preset = preset;
      config.featureId = featureId;

      d->vk = createVulkanBackend(config, error);
      if (!d->vk) {
        bail(error);
        return;
      }
    } else {
      // Speculation is colour-only on purpose. Depth and external motion would each need a
      // second staging buffer and a lookahead request of their own, and automatic motion runs a
      // separate video-engine pass with ping-pong reference frames and two blocking waits that
      // exist to work around a driver-side heap recycling bug - that is not a machine to run a
      // frame ahead of itself without a lot more evidence than this change carries.
      // VSDLSSNR_NO_PIPELINE forces the original strictly-serial flow. The two are meant to be
      // bitwise identical, and this is how that gets checked.
      const bool wantPipeline = !d->hasDepth && !d->hasMotion && !wantAutoMotion &&
                                !d->debugMotion && std::getenv("VSDLSSNR_NO_PIPELINE") == nullptr;

      if (!d->d3d.initialize(static_cast<uint32_t>(d->vi.width),
                             static_cast<uint32_t>(d->vi.height), d->hasDepth,
                             d->hasMotion || wantAutoMotion, wantAutoMotion, wantPipeline,
                             error)) {
        bail(error);
        return;
      }
      d->autoMotion = wantAutoMotion && d->d3d.autoMotionAvailable();
      d->pipeline = wantPipeline && d->d3d.slotCount() > 1;
      if (d->profile) {
        d->d3d.setProfiling(true);
      }

      if (d->debugMotion && !d->d3d.ensureMotionReadback(error)) {
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
                           "auto_motion:int:opt;"
                           "backend:data:opt;"
                           "debug_motion:int:opt;"
                           "preset:int:opt;"
                           "feature_id:int:opt;"
                           "app_id:int:opt;"
                           "snippet:data:opt;"
                           "bypass_caller_check:int:opt;",
                           "clip:vnode;", enhanceCreate, nullptr, plugin);
}
