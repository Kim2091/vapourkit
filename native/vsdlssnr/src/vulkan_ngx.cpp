#include "vulkan_ngx.h"

#include "caller_hook.h"
#include "dlssnr_params.h"
#include "log.h"

#include <windows.h>

#include <mutex>
#include <sstream>
#include <vector>

// The Vulkan NGX entry points of the driver core. Included after vulkan_ngx.h so vulkan.h and
// nvsdk_ngx.h are already in scope, which is what this header expects.
#include "nvsdk_ngx_vk.h"

namespace vsdlssnr {

  namespace {

    // Deliberately duplicated from ngx_uplift.cpp rather than shared. These are twenty lines of
    // string plumbing, and hoisting them into a common header would mean editing the file that
    // drives the working, verified D3D12 path for no functional gain.
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

      std::string narrowed(static_cast<size_t>(needed - 1), '\0');
      WideCharToMultiByte(CP_UTF8, 0, wide, -1, narrowed.data(), needed, nullptr, nullptr);
      return narrowed;
    }

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
        const DWORD written =
          GetModuleFileNameW(self, buffer.data(), static_cast<DWORD>(buffer.size()));
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
      const int needed =
        WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
      if (needed <= 0) {
        return std::string();
      }
      std::string out(static_cast<size_t>(needed - 1), '\0');
      WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, out.data(), needed, nullptr, nullptr);
      return out;
    }

    // Live Vulkan contexts in this process. Both NGX shutdowns behave as process-wide teardown
    // rather than the per-device teardown their VkDevice argument suggests - the same thing the
    // D3D12 backend found the hard way, where destroying one filter instance left the next
    // instance's EvaluateFeature failing with FAIL_InvalidParameter. So the shutdowns are
    // deferred until the last context goes away.
    //
    // Counted separately from the D3D12 side on purpose: the two Shutdown1s are different
    // functions against different APIs, and sharing one counter would mean neither ever fires in
    // a mixed-backend process. Mixing backends in one process is untested either way.
    std::mutex g_vkRuntimeMutex;
    int g_vkRuntimeRefs = 0;

    NVSDK_NGX_Resource_VK toResource(const VulkanContext::Image& image, bool readWrite) {
      NVSDK_NGX_Resource_VK resource = {};
      resource.Type = NVSDK_NGX_RESOURCE_VK_TYPE_VK_IMAGEVIEW;
      resource.Resource.ImageViewInfo.ImageView = image.view;
      resource.Resource.ImageViewInfo.Image = image.image;
      resource.Resource.ImageViewInfo.SubresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
      resource.Resource.ImageViewInfo.Format = image.format;
      resource.Resource.ImageViewInfo.Width = image.width;
      resource.Resource.ImageViewInfo.Height = image.height;
      resource.ReadWrite = readWrite;
      return resource;
    }

  } // namespace

  VulkanUpliftContext::~VulkanUpliftContext() {
    releaseFeature();

    bool lastContext = true;
    {
      std::lock_guard<std::mutex> guard(g_vkRuntimeMutex);
      if (m_runtimeCounted) {
        lastContext = (--g_vkRuntimeRefs == 0);
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
    // destroyed separately, matching the Remix integration and the D3D12 backend.
    m_parameters = nullptr;

    if (lastContext && m_coreInitialized && m_device) {
      NVSDK_NGX_VULKAN_Shutdown1(m_device);
    }
    m_coreInitialized = false;
  }

  bool VulkanUpliftContext::load(const VulkanContext& ctx,
                                 const std::wstring& snippetPath,
                                 bool bypassCallerCheck,
                                 uint32_t applicationId,
                                 std::string& error) {
    m_device = ctx.device();

    const std::wstring logDir = ngxLogDirectory();

    // The driver core first, purely for its parameter block. It knows nothing about DLSS-NR -
    // the driver does not ship the snippet - but an NVSDK_NGX_Parameter is a generic bag, and
    // this is the same block the Remix integration hands the snippet.
    //
    // The loader entry points are passed explicitly rather than left null. This plugin resolves
    // vulkan-1.dll itself, so handing NGX the exact pointers it would otherwise go looking for
    // removes any dependence on how it does that lookup.
    NVSDK_NGX_Result result = NVSDK_NGX_VULKAN_Init(applicationId,
                                                    logDir.c_str(),
                                                    ctx.instance(),
                                                    ctx.physicalDevice(),
                                                    ctx.device(),
                                                    ctx.api().vkGetInstanceProcAddr,
                                                    ctx.api().vkGetDeviceProcAddr,
                                                    nullptr,
                                                    NVSDK_NGX_Version_API);
    if (NVSDK_NGX_FAILED(result)) {
      error = "NVSDK_NGX_VULKAN_Init (driver core) failed: " + ngxResultToString(result);
      return false;
    }
    m_coreInitialized = true;

    result = NVSDK_NGX_VULKAN_GetCapabilityParameters(&m_parameters);
    if (NVSDK_NGX_FAILED(result) || m_parameters == nullptr) {
      error = "NVSDK_NGX_VULKAN_GetCapabilityParameters failed: " + ngxResultToString(result);
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

    m_pfnInit_Ext2 =
      reinterpret_cast<PFN_Init_Ext2>(GetProcAddress(m_snippet, "NVSDK_NGX_VULKAN_Init_Ext2"));
    m_pfnCreateFeature1 = reinterpret_cast<PFN_CreateFeature1>(
      GetProcAddress(m_snippet, "NVSDK_NGX_VULKAN_CreateFeature1"));
    m_pfnEvaluateFeature = reinterpret_cast<PFN_EvaluateFeature>(
      GetProcAddress(m_snippet, "NVSDK_NGX_VULKAN_EvaluateFeature"));
    m_pfnReleaseFeature = reinterpret_cast<PFN_ReleaseFeature>(
      GetProcAddress(m_snippet, "NVSDK_NGX_VULKAN_ReleaseFeature"));
    m_pfnShutdown1 =
      reinterpret_cast<PFN_Shutdown1>(GetProcAddress(m_snippet, "NVSDK_NGX_VULKAN_Shutdown1"));

    if (!m_pfnInit_Ext2 || !m_pfnCreateFeature1 || !m_pfnEvaluateFeature) {
      error = "nvngx_dlssnr.dll does not export the Vulkan NGX entry points";
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
    // Init against the same Vulkan objects.
    result = m_pfnInit_Ext2(applicationId,
                            logDir.c_str(),
                            ctx.instance(),
                            ctx.physicalDevice(),
                            ctx.device(),
                            ctx.api().vkGetInstanceProcAddr,
                            ctx.api().vkGetDeviceProcAddr,
                            nullptr,
                            NVSDK_NGX_Version_API);
    if (NVSDK_NGX_FAILED(result)) {
      error = "The snippet's NVSDK_NGX_VULKAN_Init_Ext2 failed: " + ngxResultToString(result);
      return false;
    }

    m_snippetInitialized = true;

    {
      std::lock_guard<std::mutex> guard(g_vkRuntimeMutex);
      ++g_vkRuntimeRefs;
      m_runtimeCounted = true;
    }

    logInfo("Snippet initialized (Vulkan)");
    return true;
  }

  bool VulkanUpliftContext::createFeature(VkCommandBuffer cmd,
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

    // Types below match the getter the snippet reads each parameter back with, one for one with
    // the D3D12 backend. NGX stores a value under the type it was set with, so an int written as
    // unsigned reads back as the default - silently.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Width, static_cast<unsigned int>(width));
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Height, static_cast<unsigned int>(height));
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Hint_Render_Preset, preset);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthInverted, 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Enabled, 1);
    m_parameters->Set(NVSDK_NGX_Parameter_CreationNodeMask, 1u);
    m_parameters->Set(NVSDK_NGX_Parameter_VisibilityNodeMask, 1u);

    const NVSDK_NGX_Result result = m_pfnCreateFeature1(
      m_device, cmd, static_cast<NVSDK_NGX_Feature>(featureId), m_parameters, &m_feature);

    if (NVSDK_NGX_FAILED(result)) {
      std::ostringstream os;
      os << "Failed to create the Neural Uplift feature (id " << featureId
         << ") on Vulkan: " << ngxResultToString(result);
      if (result == NVSDK_NGX_Result_FAIL_FeatureNotFound) {
        os << ". If the snippet renumbered the feature, sweep feature_id.";
      }
      error = os.str();
      m_feature = nullptr;
      return false;
    }

    std::ostringstream os;
    os << "Created the Neural Uplift feature on Vulkan (id " << featureId << ", preset " << preset
       << ") at " << width << "x" << height;
    logInfo(os.str());
    return true;
  }

  bool VulkanUpliftContext::evaluate(VkCommandBuffer cmd,
                                     const VulkanContext::Image& color,
                                     const VulkanContext::Image* depth,
                                     const VulkanContext::Image* motion,
                                     const VulkanContext::Image& output,
                                     uint32_t width,
                                     uint32_t height,
                                     const UpliftSettings& settings,
                                     std::string& error) {
    if (m_feature == nullptr || m_parameters == nullptr) {
      error = "Neural Uplift feature is not created";
      return false;
    }

    // These live until EvaluateFeature returns: the parameter block stores the pointers, and the
    // snippet dereferences them while recording.
    NVSDK_NGX_Resource_VK colorResource = toResource(color, false);
    NVSDK_NGX_Resource_VK outputResource = toResource(output, true);

    // Resources go into the void* slot, not the ID3D12Resource* one. That is the overload the
    // Remix Vulkan port uses and the one the snippet reads Vulkan resources back through.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Color, static_cast<void*>(&colorResource));
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Output, static_cast<void*>(&outputResource));

    // Colour and output must agree on width/height whenever both carry a non-trivial rect, or
    // the snippet aborts the evaluation outright. Both images are allocated at exactly the clip
    // size, so they always do here. Read back as int.
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

    // Do not write null resources into the parameter bag: an unbound input is valid, while a
    // null resource is indistinguishable from an attempted (and invalid) binding to the snippet.
    NVSDK_NGX_Resource_VK motionResource = {};
    if (motion != nullptr && motion->image != VK_NULL_HANDLE) {
      motionResource = toResource(*motion, false);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVec, static_cast<void*>(&motionResource));
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecSubrectBaseX, 0);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecSubrectBaseY, 0);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecSubrectWidth, w);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecSubrectHeight, h);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecScaleX, settings.motionVectorScaleX);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_MVecScaleY, settings.motionVectorScaleY);
    }

    NVSDK_NGX_Resource_VK depthResource = {};
    if (depth != nullptr && depth->image != VK_NULL_HANDLE) {
      depthResource = toResource(*depth, false);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Depth, static_cast<void*>(&depthResource));
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthSubrectBaseX, 0);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthSubrectBaseY, 0);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthSubrectWidth, w);
      m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthSubrectHeight, h);
    }

    // Read per evaluation, not just at creation: with Enabled clear the snippet copies its
    // colour input straight to the output and skips the network entirely.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Enabled, 1);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_DepthInverted, settings.depthInverted ? 1 : 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Reset, settings.resetHistory ? 1 : 0);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_UseAutoMask, settings.autoMask ? 1 : 0);
    // Style is the one control read back as unsigned.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Style, settings.style);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_Intensity, settings.intensity);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_LocalToneStrength, settings.styleStrength);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_LocalStructureStrength,
                      settings.localStructureStrength);
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_SkinStructureStrength,
                      settings.skinStructureStrength);

    // "The colour input already has the UI composited into it." Video has no separable UI layer,
    // so zero is the only honest answer - and it is answered explicitly because the snippet reads
    // it every evaluation and an unset parameter reads back as the type's default.
    m_parameters->Set(NVSDK_NGX_Parameter_DLSSNR_UICorrection, 0);

    const NVSDK_NGX_Result result = m_pfnEvaluateFeature(cmd, m_feature, m_parameters, nullptr);
    if (NVSDK_NGX_FAILED(result)) {
      error = "EvaluateFeature failed: " + ngxResultToString(result);
      return false;
    }

    return true;
  }

  void VulkanUpliftContext::releaseFeature() {
    if (m_feature) {
      // Always the snippet's own release: the handle came from the snippet's CreateFeature1 and
      // the driver core knows nothing about it.
      if (m_pfnReleaseFeature) {
        m_pfnReleaseFeature(m_feature);
      }
      m_feature = nullptr;
    }
  }

} // namespace vsdlssnr
