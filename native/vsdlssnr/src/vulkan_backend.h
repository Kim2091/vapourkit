#pragma once

// The Vulkan backend as plugin.cpp sees it: an abstract interface that names no Vulkan type.
//
// This is the whole point of the file. vulkan.h must never reach a translation unit on the D3D12
// path - adding it to a shared header once already broke compilation of the entire plugin,
// working D3D12 path included. Everything Vulkan lives behind this vtable, in vulkan_backend.cpp
// and the two files it includes.
//
// The call sequence mirrors D3D12Context exactly, so the frame loop reads the same either way:
//
//   begin -> mapUpload/pack/unmapUpload -> recordPreEvaluate -> evaluate -> recordPostEvaluate
//         -> endAndWait -> mapReadback/unpack/unmapReadback
//
// auto_motion has no counterpart here and never will: it is D3D12 Video fixed-function motion
// estimation. plugin.cpp rejects auto_motion with backend="vulkan" at create time.

#include <cstdint>
#include <memory>
#include <string>

#include "ngx_uplift.h" // UpliftSettings, shared verbatim between the two backends.

namespace vsdlssnr {

  struct VulkanBackendConfig {
    uint32_t width = 0;
    uint32_t height = 0;
    bool needDepth = false;
    bool needMotion = false;
    std::wstring snippetPath;
    bool bypassCallerCheck = true;
    uint32_t applicationId = 0;
    int preset = 0;
    uint32_t featureId = 0;
  };

  class VulkanBackend {
  public:
    virtual ~VulkanBackend() = default;

    // Bytes per row in the staging buffers. Vulkan copies carry no 256-byte alignment rule, so
    // these are exactly width * bytesPerTexel - which at 3840 is the same number D3D12 lands on.
    virtual uint32_t stagingRowPitch() const = 0;
    virtual uint32_t depthRowPitch() const = 0;
    virtual uint32_t motionRowPitch() const = 0;

    virtual bool begin(std::string& error) = 0;

    // Host-visible staging stays mapped for the life of the backend, so these are cheap
    // accessors rather than real map calls. The names match D3D12Context deliberately.
    virtual uint8_t* mapUpload(std::string& error) = 0;
    virtual void unmapUpload() = 0;
    virtual uint8_t* mapDepthUpload(std::string& error) = 0;
    virtual void unmapDepthUpload() = 0;
    virtual uint8_t* mapMotionUpload(std::string& error) = 0;
    virtual void unmapMotionUpload() = 0;

    virtual void recordPreEvaluate(bool uploadMotion) = 0;
    virtual bool evaluate(bool bindMotion, const UpliftSettings& settings, std::string& error) = 0;
    virtual void recordPostEvaluate() = 0;
    virtual bool endAndWait(std::string& error) = 0;

    virtual const uint8_t* mapReadback(std::string& error) = 0;
    virtual void unmapReadback() = 0;
  };

  // Returns null and fills error on any failure, including "this machine has no Vulkan loader".
  // A Vulkan shortfall must never be fatal to the plugin as a whole - the D3D12 backend has to
  // keep working on a machine where vulkan-1.dll is missing or broken.
  std::unique_ptr<VulkanBackend> createVulkanBackend(const VulkanBackendConfig& config,
                                                     std::string& error);

} // namespace vsdlssnr
