#include "vulkan_backend.h"

#include "vulkan_ctx.h"
#include "vulkan_ngx.h"

namespace vsdlssnr {

  namespace {

    class VulkanBackendImpl final : public VulkanBackend {
    public:
      // Declaration order is load-bearing, exactly as in EnhanceData on the D3D12 side:
      // VulkanUpliftContext holds a VkDevice borrowed from VulkanContext and touches it during
      // shutdown, so it must be destroyed first. Members destruct in reverse declaration order,
      // so the device context is declared first.
      VulkanContext ctx;
      VulkanUpliftContext ngx;
      uint32_t width = 0;
      uint32_t height = 0;
      bool hasDepth = false;
      bool hasMotion = false;

      uint32_t stagingRowPitch() const override { return ctx.stagingRowPitch(); }
      uint32_t depthRowPitch() const override { return ctx.depthRowPitch(); }
      uint32_t motionRowPitch() const override { return ctx.motionRowPitch(); }

      bool begin(std::string& error) override { return ctx.begin(error); }

      uint8_t* mapUpload(std::string& error) override { return ctx.mapUpload(error); }
      void unmapUpload() override { ctx.unmapUpload(); }
      uint8_t* mapDepthUpload(std::string& error) override { return ctx.mapDepthUpload(error); }
      void unmapDepthUpload() override { ctx.unmapDepthUpload(); }
      uint8_t* mapMotionUpload(std::string& error) override { return ctx.mapMotionUpload(error); }
      void unmapMotionUpload() override { ctx.unmapMotionUpload(); }

      void recordPreEvaluate(bool uploadMotion) override { ctx.recordPreEvaluate(uploadMotion); }

      bool evaluate(bool bindMotion, const UpliftSettings& settings, std::string& error) override {
        return ngx.evaluate(ctx.commandBuffer(),
                            ctx.colorImage(),
                            hasDepth ? &ctx.depthImage() : nullptr,
                            bindMotion ? &ctx.motionImage() : nullptr,
                            ctx.outputImage(),
                            width,
                            height,
                            settings,
                            error);
      }

      void recordPostEvaluate() override { ctx.recordPostEvaluate(); }
      bool endAndWait(std::string& error) override { return ctx.endAndWait(error); }

      const uint8_t* mapReadback(std::string& error) override { return ctx.mapReadback(error); }
      void unmapReadback() override { ctx.unmapReadback(); }
    };

  } // namespace

  std::unique_ptr<VulkanBackend> createVulkanBackend(const VulkanBackendConfig& config,
                                                     std::string& error) {
    auto backend = std::make_unique<VulkanBackendImpl>();
    backend->width = config.width;
    backend->height = config.height;
    backend->hasDepth = config.needDepth;
    backend->hasMotion = config.needMotion;

    if (!backend->ctx.initialize(config.width, config.height, config.needDepth, config.needMotion,
                                 error)) {
      return nullptr;
    }

    if (!backend->ngx.load(backend->ctx, config.snippetPath, config.bypassCallerCheck,
                           config.applicationId, error)) {
      return nullptr;
    }

    // Feature creation records into a command buffer, so it needs one submitted and waited on
    // before the first evaluation can run - the same shape as the D3D12 path.
    if (!backend->ctx.begin(error)) {
      return nullptr;
    }

    if (!backend->ngx.createFeature(backend->ctx.commandBuffer(), config.width, config.height,
                                    config.preset, config.featureId, error)) {
      return nullptr;
    }

    if (!backend->ctx.endAndWait(error)) {
      return nullptr;
    }

    return backend;
  }

} // namespace vsdlssnr
