#include "ngx_uplift.h"

#include "caller_hook.h"
#include "dlssnr_params.h"
#include "log.h"

#include <windows.h>

#include <mutex>
#include <sstream>
#include <vector>

namespace vsdlssnr {

  namespace {

    std::string ngxResultToString(NVSDK_NGX_Result result) {
      const wchar_t* wide = GetNGXResultAsString(result);
      if (wide == nullptr) {
        std::ostringstream os;
        os << "NVSDK_NGX_Result 0x" << std::hex << static_cast<unsigned>(result);
        return os.str();
      }

      const int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
      if (needed <= 0) {
        return "unknown NGX result";
      }

      std::string narrow(static_cast<size_t>(needed - 1), '\0');
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, narrow.data(), needed, nullptr, nullptr);
      return narrow;
    }

    // Directory this DLL lives in, with a trailing backslash. The snippet is looked for next to
    // the plugin first so a drop-in install works without touching PATH.
    std::wstring thisModuleDirectory() {
      HMODULE self = nullptr;
      if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                              reinterpret_cast<LPCWSTR>(&ngxResultToString),
                              &self) ||
          self == nullptr) {
        return std::wstring();
      }

      std::vector<wchar_t> buffer(MAX_PATH);
      for (;;) {
        const DWORD written = GetModuleFileNameW(self, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (written == 0) {
          return std::wstring();
        }
        if (written < buffer.size() - 1) {
          break;
        }
        buffer.resize(buffer.size() * 2);
      }

      std::wstring path(buffer.data());
      const size_t slash = path.find_last_of(L"\\/");
      if (slash == std::wstring::npos) {
        return std::wstring();
      }

      return path.substr(0, slash + 1);
    }

    std::wstring ngxLogDirectory() {
      std::vector<wchar_t> buffer(MAX_PATH + 1);
      const DWORD written = GetTempPathW(static_cast<DWORD>(buffer.size()), buffer.data());
      if (written == 0 || written > buffer.size()) {
        return L".\\";
      }
      return std::wstring(buffer.data(), written);
    }

    std::string narrow(const std::wstring& wide) {
      if (wide.empty()) {
        return std::string();
      }
      const int needed = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
      if (needed <= 0) {
        return std::string();
      }
      std::string out(static_cast<size_t>(needed - 1), '\0');
      WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, out.data(), needed, nullptr, nullptr);
      return out;
    }

    // Live contexts in this process. Both NGX shutdowns below behave as process-wide teardown
    // rather than the per-device teardown their ID3D12Device* argument suggests: with two
    // filter instances alive, destroying the first left the second's next EvaluateFeature
    // failing with FAIL_InvalidParameter, because its capability parameter block had gone out
    // from under it. So the shutdowns are deferred until the last context goes away.
    std::mutex g_runtimeMutex;
    int g_runtimeRefs = 0;

  } // namespace

  NeuralUpliftContext::~NeuralUpliftContext() {
    releaseFeature();

    bool lastContext = true;
    {
      std::lock_guard<std::mutex> guard(g_runtimeMutex);
      if (m_runtimeCounted) {
        lastContext = (--g_runtimeRefs == 0);
        m_runtimeCounted = false;
      }
    }

    if (m_snippet) {
      // Shutdown goes through the caller check like everything else, so the hook has to survive
      // until it has been called - and has to be undone before the library is unmapped, since
      // the slot it points into disappears with it.
      if (lastContext && m_snippetInitialized && m_pfnShutdown1) {
        m_pfnShutdown1(m_device);
      }

      if (m_holdsCallerCheckBypass) {
        releaseCallerCheckBypass();
        m_holdsCallerCheckBypass = false;
      }

      FreeLibrary(m_snippet);
      m_snippet = nullptr;
    }

    // The parameter block belongs to the driver core and goes away with its shutdown; it is not
    // destroyed separately, matching the Remix integration.
    m_parameters = nullptr;

    if (lastContext && m_coreInitialized && m_device) {
      NVSDK_NGX_D3D12_Shutdown1(m_device);
    }
    m_coreInitialized = false;
  }

  bool NeuralUpliftContext::load(ID3D12Device* device,
                                 const std::wstring& snippetPath,
                                 bool bypassCallerCheck,
                                 uint32_t applicationId,
                                 std::string& error) {
    m_device = device;

    const std::wstring logDir = ngxLogDirectory();

    // The driver core first, purely for its parameter block. It knows nothing about DLSS-NR -
    // the driver does not ship the snippet - but an NVSDK_NGX_Parameter is a generic bag, and
    // this is the same block the Remix integration hands the snippet.
    //
    // Plain Init rather than Init_Ext: the _Ext variants are declared only under
    // NGX_SNIPPET_BUILD, which is the header's mode for building a snippet rather than
    // consuming the SDK. The snippet's own Init_Ext is reached through GetProcAddress below,
    // so it needs no declaration here.
    NVSDK_NGX_Result result =
      NVSDK_NGX_D3D12_Init(applicationId, logDir.c_str(), device, nullptr, NVSDK_NGX_Version_API);
    if (NVSDK_NGX_FAILED(result)) {
      error = "NVSDK_NGX_D3D12_Init (driver core) failed: " + ngxResultToString(result);
      return false;
    }
    m_coreInitialized = true;

    result = NVSDK_NGX_D3D12_GetCapabilityParameters(&m_parameters);
    if (NVSDK_NGX_FAILED(result) || m_parameters == nullptr) {
      error = "NVSDK_NGX_D3D12_GetCapabilityParameters failed: " + ngxResultToString(result);
      return false;
    }

    std::vector<std::wstring> candidates;
    if (!snippetPath.empty()) {
      candidates.push_back(snippetPath);
    } else {
      const std::wstring dir = thisModuleDirectory();
      if (!dir.empty()) {
        candidates.push_back(dir + L"nvngx_dlssnr.dll");
      }
      candidates.push_back(L"nvngx_dlssnr.dll");
    }

    for (const std::wstring& candidate : candidates) {
      m_snippet = LoadLibraryW(candidate.c_str());
      if (m_snippet) {
        logInfo("Loaded " + narrow(candidate));
        break;
      }
    }

    if (m_snippet == nullptr) {
      error = "nvngx_dlssnr.dll could not be loaded. NVIDIA does not ship this snippet with the "
              "driver; place it next to the plugin or pass snippet=.";
      return false;
    }

    m_pfnInit_Ext = reinterpret_cast<PFN_Init_Ext>(GetProcAddress(m_snippet, "NVSDK_NGX_D3D12_Init_Ext"));
    m_pfnCreateFeature =
      reinterpret_cast<PFN_CreateFeature>(GetProcAddress(m_snippet, "NVSDK_NGX_D3D12_CreateFeature"));
    m_pfnEvaluateFeature =
      reinterpret_cast<PFN_EvaluateFeature>(GetProcAddress(m_snippet, "NVSDK_NGX_D3D12_EvaluateFeature"));
    m_pfnReleaseFeature =
      reinterpret_cast<PFN_ReleaseFeature>(GetProcAddress(m_snippet, "NVSDK_NGX_D3D12_ReleaseFeature"));
    m_pfnShutdown1 = reinterpret_cast<PFN_Shutdown1>(GetProcAddress(m_snippet, "NVSDK_NGX_D3D12_Shutdown1"));

    if (!m_pfnInit_Ext || !m_pfnCreateFeature || !m_pfnEvaluateFeature) {
      error = "nvngx_dlssnr.dll does not export the D3D12 NGX entry points";
      return false;
    }

    // Must be installed before the first snippet call, Init included.
    if (bypassCallerCheck) {
      m_holdsCallerCheckBypass = acquireCallerCheckBypass(m_snippet);
    } else {
      logInfo("Caller check left in place (bypass_caller_check=0); the snippet is expected to "
              "reject calls from this module");
    }

    // The snippet keeps its own NGX state, separate from the driver core, so it needs its own
    // Init against the same device.
    result = m_pfnInit_Ext(applicationId, logDir.c_str(), device, NVSDK_NGX_Version_API, nullptr);
    if (NVSDK_NGX_FAILED(result)) {
      error = "The snippet's NVSDK_NGX_D3D12_Init_Ext failed: " + ngxResultToString(result);
      return false;
    }

    m_snippetInitialized = true;

    {
      std::lock_guard<std::mutex> guard(g_runtimeMutex);
      ++g_runtimeRefs;
      m_runtimeCounted = true;
    }

    logInfo("Snippet initialized");
    return true;
  }

  bool NeuralUpliftContext::createFeature(ID3D12GraphicsCommandList* cmdList,
                                          uint32_t width,
                                          uint32_t height,
                                          int preset,
                                          uint32_t featureId,
                                          std::string& error) {
    if (!m_snippetInitialized || m_parameters == nullptr) {
      error = "Neural Uplift is not initialized";
      return false;
    }

    releaseFeature();

    // Types below match the getter the snippet reads each parameter back with. NGX stores a
    // value under the type it was set with, so an int written as unsigned reads back as the
    // default - silently, which is the failure mode this feature keeps presenting.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Width, static_cast<unsigned int>(width));
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Height, static_cast<unsigned int>(height));
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Hint_Render_Preset, preset);
    // No depth is bound, so inversion is meaningless - set anyway so the block is deterministic.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthInverted, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Enabled, 1);
    m_parameters->Set(NVSDK_NGX_Parameter_CreationNodeMask, 1u);
    m_parameters->Set(NVSDK_NGX_Parameter_VisibilityNodeMask, 1u);

    const NVSDK_NGX_Result result = m_pfnCreateFeature(
      cmdList, static_cast<NVSDK_NGX_Feature>(featureId), m_parameters, &m_feature);

    if (NVSDK_NGX_FAILED(result)) {
      std::ostringstream os;
      os << "Failed to create the Neural Uplift feature (id " << featureId
         << "): " << ngxResultToString(result);
      if (result == NVSDK_NGX_Result_FAIL_FeatureNotFound) {
        os << ". If the snippet renumbered the feature, sweep feature_id.";
      }
      error = os.str();
      m_feature = nullptr;
      return false;
    }

    std::ostringstream os;
    os << "Created the Neural Uplift feature (id " << featureId << ", preset " << preset << ") at "
       << width << "x" << height;
    logInfo(os.str());
    return true;
  }

  bool NeuralUpliftContext::evaluate(ID3D12GraphicsCommandList* cmdList,
                                     ID3D12Resource* color,
                                     ID3D12Resource* output,
                                     uint32_t width,
                                     uint32_t height,
                                     const UpliftSettings& settings,
                                     std::string& error) {
    if (m_feature == nullptr || m_parameters == nullptr) {
      error = "Neural Uplift feature is not created";
      return false;
    }

    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Color, color);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Output, output);

    // Colour and output must agree on width/height whenever both carry a non-trivial rect, or
    // the snippet aborts the evaluation outright. Both textures are allocated at exactly the
    // clip size, so they always do here. Read back as int.
    const int w = static_cast<int>(width);
    const int h = static_cast<int>(height);

    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_ColorSubrectBaseX, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_ColorSubrectBaseY, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_ColorSubrectWidth, w);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_ColorSubrectHeight, h);

    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_OutputSubrectBaseX, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_OutputSubrectBaseY, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_OutputSubrectWidth, w);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_OutputSubrectHeight, h);

    // Read per evaluation, not just at creation: with Enabled clear the snippet copies its
    // colour input straight to the output and skips the network entirely.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Enabled, 1);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthInverted, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Reset, settings.resetHistory ? 1 : 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_UseAutoMask, settings.autoMask ? 1 : 0);
    // Style is the one control read back as unsigned.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Style, settings.style);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Intensity, settings.intensity);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_LocalToneStrength, settings.styleStrength);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_LocalStructureStrength, settings.localStructureStrength);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_SkinStructureStrength, settings.skinStructureStrength);

    // "The colour input already has the UI composited into it." Answered explicitly rather than
    // left to whatever the parameter block holds, since the snippet reads it every evaluation
    // and an unset parameter reads back as the type's default. Video has no separable UI layer,
    // so zero is the only honest answer.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_UICorrection, 0);

    const NVSDK_NGX_Result result = m_pfnEvaluateFeature(cmdList, m_feature, m_parameters, nullptr);
    if (NVSDK_NGX_FAILED(result)) {
      error = "EvaluateFeature failed: " + ngxResultToString(result);
      return false;
    }

    return true;
  }

  void NeuralUpliftContext::releaseFeature() {
    if (m_feature) {
      // Always the snippet's own release: the handle came from the snippet's CreateFeature and
      // the driver core knows nothing about it.
      if (m_pfnReleaseFeature) {
        m_pfnReleaseFeature(m_feature);
      }
      m_feature = nullptr;
    }
  }

} // namespace vsdlssnr
