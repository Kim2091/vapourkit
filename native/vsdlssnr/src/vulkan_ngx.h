#pragma once

// Drives the DLSS-NR snippet over a Vulkan command buffer - the parallel of NeuralUpliftContext,
// which does the same over a D3D12 command list.
//
// THIS HEADER MUST NOT BE INCLUDED BY THE D3D12 PATH: it pulls in vulkan.h through vulkan_ctx.h.
// plugin.cpp reaches all of this through vulkan_backend.h, which names no Vulkan type.
//
// Two NGX cores are in play, exactly as on the D3D12 side and exactly as in the Remix
// integration. The driver's own nvngx.dll supplies the NVSDK_NGX_Parameter block - a generic bag
// with a vtable, which the snippet consumes happily - while nvngx_dlssnr.dll is loaded by hand
// and keeps its own NGX state, so it gets its own Init against the same Vulkan objects.

#include "vulkan_ctx.h"

// nvsdk_ngx_params.h declares Set/Get overloads taking ID3D11Resource* and ID3D12Resource* but
// includes neither header itself, so both have to be in scope before it. That is a D3D header in
// a Vulkan translation unit, which is fine - the leak that matters is the other direction.
#include <d3d11.h>
#include <d3d12.h>

#include <cstdint>
#include <string>

#include "nvsdk_ngx.h"
#include "ngx_uplift.h" // UpliftSettings, shared verbatim between the two backends.

namespace vsdlssnr {

  class VulkanUpliftContext {
  public:
    VulkanUpliftContext() = default;
    ~VulkanUpliftContext();

    VulkanUpliftContext(const VulkanUpliftContext&) = delete;
    VulkanUpliftContext& operator=(const VulkanUpliftContext&) = delete;

    // snippetPath may be empty, in which case the usual search order is used: next to this
    // plugin, then whatever the loader finds for a bare "nvngx_dlssnr.dll".
    bool load(const VulkanContext& ctx,
              const std::wstring& snippetPath,
              bool bypassCallerCheck,
              uint32_t applicationId,
              std::string& error);

    // Records feature creation into the caller's open command buffer. The buffer must be
    // submitted and waited on before the first evaluate.
    bool createFeature(VkCommandBuffer cmd,
                       uint32_t width,
                       uint32_t height,
                       int preset,
                       uint32_t featureId,
                       std::string& error);

    // Records one evaluation. Depth and motion are optional: a null pointer means leave the
    // corresponding DLSS-NR input unbound.
    bool evaluate(VkCommandBuffer cmd,
                  const VulkanContext::Image& color,
                  const VulkanContext::Image* depth,
                  const VulkanContext::Image* motion,
                  const VulkanContext::Image& output,
                  uint32_t width,
                  uint32_t height,
                  const UpliftSettings& settings,
                  std::string& error);

    void releaseFeature();

  private:
    // Signatures copied from the validated dxvk-remix integration rather than from the SDK
    // header: the snippet's _Ext exports exist only under NGX_SNIPPET_BUILD, so they are reached
    // through GetProcAddress and need no declaration. Init_Ext2 takes the trailing
    // FeatureCommonInfo/Version pair of the non-snippet Init, which is what the working Remix
    // port calls it with.
    using PFN_Init_Ext2 = NVSDK_NGX_Result(NVSDK_CONV*)(unsigned long long,
                                                        const wchar_t*,
                                                        VkInstance,
                                                        VkPhysicalDevice,
                                                        VkDevice,
                                                        PFN_vkGetInstanceProcAddr,
                                                        PFN_vkGetDeviceProcAddr,
                                                        const NVSDK_NGX_FeatureCommonInfo*,
                                                        NVSDK_NGX_Version);
    using PFN_CreateFeature1 = NVSDK_NGX_Result(NVSDK_CONV*)(VkDevice,
                                                             VkCommandBuffer,
                                                             NVSDK_NGX_Feature,
                                                             NVSDK_NGX_Parameter*,
                                                             NVSDK_NGX_Handle**);
    // The last parameter is really PFN_NVSDK_NGX_ProgressCallback; it is always null here.
    using PFN_EvaluateFeature = NVSDK_NGX_Result(NVSDK_CONV*)(VkCommandBuffer,
                                                              const NVSDK_NGX_Handle*,
                                                              const NVSDK_NGX_Parameter*,
                                                              void*);
    using PFN_ReleaseFeature = NVSDK_NGX_Result(NVSDK_CONV*)(NVSDK_NGX_Handle*);
    using PFN_Shutdown1 = NVSDK_NGX_Result(NVSDK_CONV*)(VkDevice);

    VkDevice m_device = VK_NULL_HANDLE;
    HMODULE m_snippet = nullptr;
    // Whether this context holds a reference on the process-wide caller-check bypass. The hook
    // is shared between every live context - see caller_hook.h - so what is tracked here is only
    // the reference, to be released exactly once.
    bool m_holdsCallerCheckBypass = false;
    // Whether this context is counted among the live Vulkan NGX runtimes in the process, which
    // is what decides who gets to call the two Shutdown1s.
    bool m_runtimeCounted = false;
    bool m_snippetInitialized = false;
    bool m_coreInitialized = false;

    NVSDK_NGX_Parameter* m_parameters = nullptr;
    NVSDK_NGX_Handle* m_feature = nullptr;

    PFN_Init_Ext2 m_pfnInit_Ext2 = nullptr;
    PFN_CreateFeature1 m_pfnCreateFeature1 = nullptr;
    PFN_EvaluateFeature m_pfnEvaluateFeature = nullptr;
    PFN_ReleaseFeature m_pfnReleaseFeature = nullptr;
    PFN_Shutdown1 m_pfnShutdown1 = nullptr;
  };

} // namespace vsdlssnr
