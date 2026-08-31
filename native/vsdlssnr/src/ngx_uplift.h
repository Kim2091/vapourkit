#pragma once

// nvsdk_ngx_params.h declares Set/Get overloads taking ID3D11Resource* and ID3D12Resource* but
// includes neither header itself, so both have to be in scope before it.
#include <d3d11.h>
#include <d3d12.h>

#include <cstdint>
#include <string>

#include "nvsdk_ngx.h"

namespace vsdlssnr {

  class D3D12Context;

  // Per-evaluation effect controls. Defaults match the snippet's own, so an untouched filter
  // call is the neutral full-strength effect.
  struct UpliftSettings {
    // 0..2; the snippet clamps anything higher to 2 rather than ignoring it.
    uint32_t style = 0;
    // Wet/dry blend against the original colour. Below 1.0 the snippet keeps an extra copy.
    float intensity = 1.0f;
    // Goes to DLSSNR.LocalToneStrength, which is the style blend weight rather than the tone
    // control its name suggests: 0 makes the style a no-op.
    float styleStrength = 1.0f;
    float localStructureStrength = 1.0f;
    // -1 is the snippet's "unset" sentinel: use localStructureStrength for skin too. Both
    // structure strengths are only consulted when autoMask is on.
    float skinStructureStrength = -1.0f;
    bool autoMask = true;
    // A normalized depth clip normally uses 0 = near, 1 = far. Set this when its convention is
    // reversed. Motion values are converted to pixels by these factors inside the snippet.
    bool depthInverted = false;
    float motionVectorScaleX = 1.0f;
    float motionVectorScaleY = 1.0f;
    bool resetHistory = false;
  };

  // Drives the DLSS-NR snippet over a D3D12 command list.
  //
  // Two NGX cores are in play, exactly as in the Remix integration. The driver's own nvngx.dll
  // supplies the NVSDK_NGX_Parameter block - a generic bag with a vtable, which the snippet is
  // happy to consume - while nvngx_dlssnr.dll is loaded by hand and keeps its own NGX state,
  // so it needs a separate Init against the same device.
  class NeuralUpliftContext {
  public:
    NeuralUpliftContext() = default;
    ~NeuralUpliftContext();

    NeuralUpliftContext(const NeuralUpliftContext&) = delete;
    NeuralUpliftContext& operator=(const NeuralUpliftContext&) = delete;

    // snippetPath may be empty, in which case the usual search order is used: next to this
    // plugin, then whatever the loader finds for a bare "nvngx_dlssnr.dll".
    bool load(ID3D12Device* device,
              const std::wstring& snippetPath,
              bool bypassCallerCheck,
              uint32_t applicationId,
              std::string& error);

    // Records feature creation into the caller's open command list. The list must be submitted
    // and waited on before the first evaluate.
    bool createFeature(ID3D12GraphicsCommandList* cmdList,
                       uint32_t width,
                       uint32_t height,
                       int preset,
                       uint32_t featureId,
                       std::string& error);

    // Records one evaluation. Depth and motion are optional: null means leave the corresponding
    // DLSS-NR input unbound. Non-null resources are sampled as normalized R32F depth and RG16F
    // signed pixel vectors respectively.
    bool evaluate(ID3D12GraphicsCommandList* cmdList,
                  ID3D12Resource* color,
                  ID3D12Resource* depth,
                  ID3D12Resource* motion,
                  ID3D12Resource* output,
                  uint32_t width,
                  uint32_t height,
                  const UpliftSettings& settings,
                  std::string& error);

    void releaseFeature();

  private:
    using PFN_Init_Ext = NVSDK_NGX_Result(NVSDK_CONV*)(unsigned long long,
                                                       const wchar_t*,
                                                       ID3D12Device*,
                                                       NVSDK_NGX_Version,
                                                       const NVSDK_NGX_Parameter*);
    using PFN_CreateFeature = NVSDK_NGX_Result(NVSDK_CONV*)(ID3D12GraphicsCommandList*,
                                                            NVSDK_NGX_Feature,
                                                            NVSDK_NGX_Parameter*,
                                                            NVSDK_NGX_Handle**);
    using PFN_EvaluateFeature = NVSDK_NGX_Result(NVSDK_CONV*)(ID3D12GraphicsCommandList*,
                                                              const NVSDK_NGX_Handle*,
                                                              const NVSDK_NGX_Parameter*,
                                                              void*);
    using PFN_ReleaseFeature = NVSDK_NGX_Result(NVSDK_CONV*)(NVSDK_NGX_Handle*);
    using PFN_Shutdown1 = NVSDK_NGX_Result(NVSDK_CONV*)(ID3D12Device*);

    ID3D12Device* m_device = nullptr;
    HMODULE m_snippet = nullptr;
    void** m_callerCheckHookSlot = nullptr;
    bool m_snippetInitialized = false;
    bool m_coreInitialized = false;

    NVSDK_NGX_Parameter* m_parameters = nullptr;
    NVSDK_NGX_Handle* m_feature = nullptr;

    PFN_Init_Ext m_pfnInit_Ext = nullptr;
    PFN_CreateFeature m_pfnCreateFeature = nullptr;
    PFN_EvaluateFeature m_pfnEvaluateFeature = nullptr;
    PFN_ReleaseFeature m_pfnReleaseFeature = nullptr;
    PFN_Shutdown1 m_pfnShutdown1 = nullptr;
  };

} // namespace vsdlssnr
