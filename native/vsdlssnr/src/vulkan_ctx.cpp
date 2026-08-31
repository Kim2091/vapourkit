#include "vulkan_ctx.h"

#include "log.h"

#include <windows.h>

#include <algorithm>
#include <cstring>
#include <sstream>

namespace vsdlssnr {

  namespace {

    // The same three formats the D3D12 backend uses, and for the same reasons. The colour format
    // is a plain float format, never an _SRGB one: the model wants sRGB-ENCODED VALUES, and an
    // _SRGB view would have the hardware linearise them on read - the inverse of the
    // double-transfer bug, and just as wrong.
    constexpr VkFormat kColorFormat = VK_FORMAT_R16G16B16A16_SFLOAT;
    constexpr VkFormat kDepthFormat = VK_FORMAT_R32_SFLOAT;
    constexpr VkFormat kMotionFormat = VK_FORMAT_R16G16_SFLOAT;

    constexpr uint32_t bytesPerTexel(VkFormat format) {
      return format == kColorFormat ? 8u : 4u;
    }

    std::string vkToString(const char* what, VkResult result) {
      std::ostringstream os;
      os << what << " failed (VkResult " << static_cast<int>(result) << ")";
      return os.str();
    }

    bool hasExtension(const std::vector<VkExtensionProperties>& available, const char* name) {
      for (const VkExtensionProperties& e : available) {
        if (std::strcmp(e.extensionName, name) == 0) {
          return true;
        }
      }
      return false;
    }

    // Device extensions the DLSS-NR snippet's own checks look for, confirmed against the strings
    // in nvngx_dlssnr.dll itself. There is no capability query for this feature - the driver does
    // not know it exists - so a shortfall otherwise surfaces as a CreateFeature failure with
    // nothing to say which piece was missing. Checking here turns that into a named error.
    const char* const kRequiredDeviceExtensions[] = {
      VK_NVX_BINARY_IMPORT_EXTENSION_NAME,
      VK_NVX_IMAGE_VIEW_HANDLE_EXTENSION_NAME,
      VK_KHR_PUSH_DESCRIPTOR_EXTENSION_NAME,
      VK_KHR_BUFFER_DEVICE_ADDRESS_EXTENSION_NAME,
    };

    // VK_EXT_buffer_device_address is deliberately absent. The snippet resolves all three
    // spellings of the entry point (vkGetBufferDeviceAddress, ...EXT and ...KHR are all present
    // in its string table), and naming the EXT extension alongside
    // VkPhysicalDeviceVulkan12Features::bufferDeviceAddress is invalid. KHR plus the 1.2 feature
    // is what the validated dxvk-remix integration runs DLSS-NR with.

    // Enabled when present but not worth failing over. The 1.2 promotions are no-ops on a 1.2
    // device; the rest are interop paths NGX uses opportunistically.
    const char* const kOptionalDeviceExtensions[] = {
      VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME,
      VK_EXT_DESCRIPTOR_INDEXING_EXTENSION_NAME,
      VK_KHR_EXTERNAL_MEMORY_WIN32_EXTENSION_NAME,
      VK_KHR_EXTERNAL_SEMAPHORE_WIN32_EXTENSION_NAME,
      VK_KHR_EXTERNAL_MEMORY_EXTENSION_NAME,
      VK_KHR_EXTERNAL_SEMAPHORE_EXTENSION_NAME,
      VK_KHR_SYNCHRONIZATION_2_EXTENSION_NAME,
    };

    std::string describeMemoryFlags(VkMemoryPropertyFlags flags) {
      std::string out;
      auto add = [&](VkMemoryPropertyFlags bit, const char* name) {
        if (flags & bit) {
          if (!out.empty()) {
            out += "|";
          }
          out += name;
        }
      };
      add(VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, "DEVICE_LOCAL");
      add(VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT, "HOST_VISIBLE");
      add(VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, "HOST_COHERENT");
      add(VK_MEMORY_PROPERTY_HOST_CACHED_BIT, "HOST_CACHED");
      return out.empty() ? "none" : out;
    }

  } // namespace

  VulkanContext::~VulkanContext() {
    if (m_device && m_api.vkDeviceWaitIdle) {
      // A queued frame may still be in flight; freeing memory under it would fault in the driver.
      m_api.vkDeviceWaitIdle(m_device);
    }

    destroyImage(m_color);
    destroyImage(m_output);
    destroyImage(m_depth);
    destroyImage(m_motion);

    destroyBuffer(m_upload);
    destroyBuffer(m_depthUpload);
    destroyBuffer(m_motionUpload);
    destroyBuffer(m_readback);

    if (m_device) {
      if (m_fence && m_api.vkDestroyFence) {
        m_api.vkDestroyFence(m_device, m_fence, nullptr);
        m_fence = VK_NULL_HANDLE;
      }
      if (m_commandPool && m_api.vkDestroyCommandPool) {
        m_api.vkDestroyCommandPool(m_device, m_commandPool, nullptr);
        m_commandPool = VK_NULL_HANDLE;
      }
      if (m_api.vkDestroyDevice) {
        m_api.vkDestroyDevice(m_device, nullptr);
      }
      m_device = VK_NULL_HANDLE;
    }

    if (m_instance && m_api.vkDestroyInstance) {
      m_api.vkDestroyInstance(m_instance, nullptr);
      m_instance = VK_NULL_HANDLE;
    }

    if (m_loader) {
      FreeLibrary(static_cast<HMODULE>(m_loader));
      m_loader = nullptr;
    }
  }

  bool VulkanContext::initialize(uint32_t width,
                                 uint32_t height,
                                 bool needDepth,
                                 bool needMotion,
                                 std::string& error) {
    m_width = width;
    m_height = height;
    m_needDepth = needDepth;
    m_needMotion = needMotion;

    return loadLoader(error) && createInstance(error) && pickPhysicalDevice(error) &&
           createDevice(error) && createCommandObjects(error) && createResources(error);
  }

  bool VulkanContext::loadLoader(std::string& error) {
    m_loader = LoadLibraryW(L"vulkan-1.dll");
    if (m_loader == nullptr) {
      error = "Vulkan backend unavailable: vulkan-1.dll could not be loaded, so this system has "
              "no Vulkan loader. Use backend=\"d3d12\".";
      return false;
    }

    m_api.vkGetInstanceProcAddr = reinterpret_cast<PFN_vkGetInstanceProcAddr>(
      GetProcAddress(static_cast<HMODULE>(m_loader), "vkGetInstanceProcAddr"));
    if (m_api.vkGetInstanceProcAddr == nullptr) {
      error = "Vulkan backend unavailable: vulkan-1.dll does not export vkGetInstanceProcAddr";
      return false;
    }

#define VSDLSSNR_LOAD_GLOBAL(name)                                                               \
  m_api.name = reinterpret_cast<PFN_##name>(m_api.vkGetInstanceProcAddr(VK_NULL_HANDLE, #name)); \
  if (m_api.name == nullptr) {                                                                   \
    error = "Vulkan loader is missing " #name;                                                   \
    return false;                                                                                \
  }

    VSDLSSNR_LOAD_GLOBAL(vkCreateInstance)
    VSDLSSNR_LOAD_GLOBAL(vkEnumerateInstanceExtensionProperties)
#undef VSDLSSNR_LOAD_GLOBAL

    return true;
  }

  bool VulkanContext::createInstance(std::string& error) {
    uint32_t count = 0;
    m_api.vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr);
    std::vector<VkExtensionProperties> available(count);
    if (count > 0) {
      m_api.vkEnumerateInstanceExtensionProperties(nullptr, &count, available.data());
    }

    // The first three are 1.1 promotions and no-ops on a 1.2 instance, but naming them keeps the
    // arrangement identical on a loader that reports a lower version. VK_EXT_debug_utils is here
    // because the snippet resolves vkSetDebugUtilsObjectNameEXT and vkCmdBeginDebugUtilsLabelEXT;
    // enabling it costs nothing and means those lookups return a real function rather than null.
    static const char* const wanted[] = {
      VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME,
      VK_KHR_EXTERNAL_MEMORY_CAPABILITIES_EXTENSION_NAME,
      VK_KHR_EXTERNAL_SEMAPHORE_CAPABILITIES_EXTENSION_NAME,
      VK_EXT_DEBUG_UTILS_EXTENSION_NAME,
    };

    std::vector<const char*> enabled;
    for (const char* name : wanted) {
      if (hasExtension(available, name)) {
        enabled.push_back(name);
      }
    }

    VkApplicationInfo appInfo = {};
    appInfo.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    appInfo.pApplicationName = "vsdlssnr";
    appInfo.applicationVersion = 1;
    appInfo.pEngineName = "vsdlssnr";
    appInfo.engineVersion = 1;
    // 1.2 is what the feature set below needs; asking for more buys nothing and narrows the set
    // of loaders that will answer.
    appInfo.apiVersion = VK_API_VERSION_1_2;

    VkInstanceCreateInfo createInfo = {};
    createInfo.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    createInfo.pApplicationInfo = &appInfo;
    createInfo.enabledExtensionCount = static_cast<uint32_t>(enabled.size());
    createInfo.ppEnabledExtensionNames = enabled.empty() ? nullptr : enabled.data();

    const VkResult result = m_api.vkCreateInstance(&createInfo, nullptr, &m_instance);
    if (result != VK_SUCCESS) {
      error = vkToString("vkCreateInstance", result);
      return false;
    }

#define VSDLSSNR_LOAD_INSTANCE(name)                                                         \
  m_api.name = reinterpret_cast<PFN_##name>(m_api.vkGetInstanceProcAddr(m_instance, #name)); \
  if (m_api.name == nullptr) {                                                               \
    error = "Vulkan instance is missing " #name;                                             \
    return false;                                                                            \
  }

    VSDLSSNR_LOAD_INSTANCE(vkDestroyInstance)
    VSDLSSNR_LOAD_INSTANCE(vkEnumeratePhysicalDevices)
    VSDLSSNR_LOAD_INSTANCE(vkGetPhysicalDeviceProperties)
    VSDLSSNR_LOAD_INSTANCE(vkGetPhysicalDeviceFeatures2)
    VSDLSSNR_LOAD_INSTANCE(vkGetPhysicalDeviceMemoryProperties)
    VSDLSSNR_LOAD_INSTANCE(vkGetPhysicalDeviceQueueFamilyProperties)
    VSDLSSNR_LOAD_INSTANCE(vkEnumerateDeviceExtensionProperties)
    VSDLSSNR_LOAD_INSTANCE(vkCreateDevice)
    VSDLSSNR_LOAD_INSTANCE(vkGetDeviceProcAddr)
#undef VSDLSSNR_LOAD_INSTANCE

    return true;
  }

  bool VulkanContext::pickPhysicalDevice(std::string& error) {
    uint32_t count = 0;
    m_api.vkEnumeratePhysicalDevices(m_instance, &count, nullptr);
    if (count == 0) {
      error = "No Vulkan physical devices were found.";
      return false;
    }

    std::vector<VkPhysicalDevice> devices(count);
    m_api.vkEnumeratePhysicalDevices(m_instance, &count, devices.data());

    // The snippet rejects anything below Blackwell, so a non-NVIDIA adapter cannot run it at all.
    // Picking explicitly also keeps this off the integrated GPU on a laptop, which is where a
    // "first device" rule frequently lands.
    constexpr uint32_t kVendorNvidia = 0x10DE;
    std::string shortfall;

    for (VkPhysicalDevice candidate : devices) {
      VkPhysicalDeviceProperties props = {};
      m_api.vkGetPhysicalDeviceProperties(candidate, &props);
      if (props.vendorID != kVendorNvidia) {
        continue;
      }

      uint32_t extCount = 0;
      m_api.vkEnumerateDeviceExtensionProperties(candidate, nullptr, &extCount, nullptr);
      std::vector<VkExtensionProperties> extensions(extCount);
      if (extCount > 0) {
        m_api.vkEnumerateDeviceExtensionProperties(candidate, nullptr, &extCount, extensions.data());
      }

      std::string missing;
      for (const char* name : kRequiredDeviceExtensions) {
        if (!hasExtension(extensions, name)) {
          if (!missing.empty()) {
            missing += ", ";
          }
          missing += name;
        }
      }

      if (!missing.empty()) {
        shortfall = std::string(props.deviceName) + " is missing " + missing;
        continue;
      }

      uint32_t familyCount = 0;
      m_api.vkGetPhysicalDeviceQueueFamilyProperties(candidate, &familyCount, nullptr);
      std::vector<VkQueueFamilyProperties> families(familyCount);
      m_api.vkGetPhysicalDeviceQueueFamilyProperties(candidate, &familyCount, families.data());

      // One queue does everything here: the buffer copies, and whatever compute NGX records.
      constexpr VkQueueFlags kNeeded = VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT;
      bool foundFamily = false;
      for (uint32_t i = 0; i < familyCount; ++i) {
        if ((families[i].queueFlags & kNeeded) == kNeeded && families[i].queueCount > 0) {
          m_queueFamily = i;
          foundFamily = true;
          break;
        }
      }

      if (!foundFamily) {
        shortfall = std::string(props.deviceName) + " has no compute+transfer queue family";
        continue;
      }

      m_physicalDevice = candidate;
      m_api.vkGetPhysicalDeviceMemoryProperties(candidate, &m_memoryProperties);
      logInfo(std::string("Vulkan adapter: ") + props.deviceName);
      return true;
    }

    error = shortfall.empty()
              ? "No NVIDIA Vulkan device was found. DLSS-NR requires a Blackwell (RTX 50-series) GPU."
              : ("No usable NVIDIA Vulkan device: " + shortfall);
    return false;
  }

  bool VulkanContext::createDevice(std::string& error) {
    uint32_t extCount = 0;
    m_api.vkEnumerateDeviceExtensionProperties(m_physicalDevice, nullptr, &extCount, nullptr);
    std::vector<VkExtensionProperties> available(extCount);
    if (extCount > 0) {
      m_api.vkEnumerateDeviceExtensionProperties(m_physicalDevice, nullptr, &extCount,
                                                 available.data());
    }

    std::vector<const char*> enabled;
    for (const char* name : kRequiredDeviceExtensions) {
      enabled.push_back(name);
    }
    for (const char* name : kOptionalDeviceExtensions) {
      if (hasExtension(available, name)) {
        enabled.push_back(name);
      }
    }

    VkPhysicalDeviceVulkan12Features supported12 = {};
    supported12.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES;
    VkPhysicalDeviceFeatures2 supported = {};
    supported.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    supported.pNext = &supported12;
    m_api.vkGetPhysicalDeviceFeatures2(m_physicalDevice, &supported);

    if (!supported12.timelineSemaphore || !supported12.descriptorIndexing ||
        !supported12.bufferDeviceAddress) {
      std::ostringstream os;
      os << "The Vulkan device does not support the features DLSS-NR needs (timelineSemaphore="
         << supported12.timelineSemaphore
         << ", descriptorIndexing=" << supported12.descriptorIndexing
         << ", bufferDeviceAddress=" << supported12.bufferDeviceAddress << ")";
      error = os.str();
      return false;
    }

    // Enable everything the device advertises at 1.2 level rather than hand-picking: the snippet
    // is not documented, its descriptor-indexing needs are not published, and a feature it wanted
    // but did not get comes back as an opaque CreateFeature failure. The two capture/replay flags
    // are the exception - they make the driver reserve address space for a debugger that is not
    // attached.
    VkPhysicalDeviceVulkan12Features features12 = supported12;
    features12.pNext = nullptr;
    features12.bufferDeviceAddressCaptureReplay = VK_FALSE;
    features12.bufferDeviceAddressMultiDevice = VK_FALSE;

    VkPhysicalDeviceFeatures base = {};
    base.shaderStorageImageWriteWithoutFormat = supported.features.shaderStorageImageWriteWithoutFormat;
    base.shaderStorageImageReadWithoutFormat = supported.features.shaderStorageImageReadWithoutFormat;
    base.shaderInt64 = supported.features.shaderInt64;
    base.shaderInt16 = supported.features.shaderInt16;
    base.fragmentStoresAndAtomics = supported.features.fragmentStoresAndAtomics;
    base.vertexPipelineStoresAndAtomics = supported.features.vertexPipelineStoresAndAtomics;
    // robustBufferAccess is deliberately left off: a per-access cost on every shader for a safety
    // net nothing here needs.

    VkPhysicalDeviceFeatures2 enabledFeatures = {};
    enabledFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    enabledFeatures.pNext = &features12;
    enabledFeatures.features = base;

    const float priority = 1.0f;
    VkDeviceQueueCreateInfo queueInfo = {};
    queueInfo.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    queueInfo.queueFamilyIndex = m_queueFamily;
    queueInfo.queueCount = 1;
    queueInfo.pQueuePriorities = &priority;

    VkDeviceCreateInfo deviceInfo = {};
    deviceInfo.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    deviceInfo.pNext = &enabledFeatures;
    deviceInfo.queueCreateInfoCount = 1;
    deviceInfo.pQueueCreateInfos = &queueInfo;
    deviceInfo.enabledExtensionCount = static_cast<uint32_t>(enabled.size());
    deviceInfo.ppEnabledExtensionNames = enabled.data();
    // pEnabledFeatures stays null: the features live in the pNext VkPhysicalDeviceFeatures2.

    const VkResult result = m_api.vkCreateDevice(m_physicalDevice, &deviceInfo, nullptr, &m_device);
    if (result != VK_SUCCESS) {
      error = vkToString("vkCreateDevice", result);
      return false;
    }

#define VSDLSSNR_LOAD_DEVICE(name)                                                       \
  m_api.name = reinterpret_cast<PFN_##name>(m_api.vkGetDeviceProcAddr(m_device, #name)); \
  if (m_api.name == nullptr) {                                                           \
    error = "Vulkan device is missing " #name;                                           \
    return false;                                                                        \
  }

    VSDLSSNR_LOAD_DEVICE(vkDestroyDevice)
    VSDLSSNR_LOAD_DEVICE(vkDeviceWaitIdle)
    VSDLSSNR_LOAD_DEVICE(vkGetDeviceQueue)
    VSDLSSNR_LOAD_DEVICE(vkCreateCommandPool)
    VSDLSSNR_LOAD_DEVICE(vkDestroyCommandPool)
    VSDLSSNR_LOAD_DEVICE(vkResetCommandPool)
    VSDLSSNR_LOAD_DEVICE(vkAllocateCommandBuffers)
    VSDLSSNR_LOAD_DEVICE(vkBeginCommandBuffer)
    VSDLSSNR_LOAD_DEVICE(vkEndCommandBuffer)
    VSDLSSNR_LOAD_DEVICE(vkQueueSubmit)
    VSDLSSNR_LOAD_DEVICE(vkCreateFence)
    VSDLSSNR_LOAD_DEVICE(vkDestroyFence)
    VSDLSSNR_LOAD_DEVICE(vkWaitForFences)
    VSDLSSNR_LOAD_DEVICE(vkResetFences)
    VSDLSSNR_LOAD_DEVICE(vkCreateImage)
    VSDLSSNR_LOAD_DEVICE(vkDestroyImage)
    VSDLSSNR_LOAD_DEVICE(vkGetImageMemoryRequirements)
    VSDLSSNR_LOAD_DEVICE(vkBindImageMemory)
    VSDLSSNR_LOAD_DEVICE(vkCreateImageView)
    VSDLSSNR_LOAD_DEVICE(vkDestroyImageView)
    VSDLSSNR_LOAD_DEVICE(vkCreateBuffer)
    VSDLSSNR_LOAD_DEVICE(vkDestroyBuffer)
    VSDLSSNR_LOAD_DEVICE(vkGetBufferMemoryRequirements)
    VSDLSSNR_LOAD_DEVICE(vkBindBufferMemory)
    VSDLSSNR_LOAD_DEVICE(vkAllocateMemory)
    VSDLSSNR_LOAD_DEVICE(vkFreeMemory)
    VSDLSSNR_LOAD_DEVICE(vkMapMemory)
    VSDLSSNR_LOAD_DEVICE(vkUnmapMemory)
    VSDLSSNR_LOAD_DEVICE(vkCmdPipelineBarrier)
    VSDLSSNR_LOAD_DEVICE(vkCmdCopyBufferToImage)
    VSDLSSNR_LOAD_DEVICE(vkCmdCopyImageToBuffer)
#undef VSDLSSNR_LOAD_DEVICE

    m_api.vkGetDeviceQueue(m_device, m_queueFamily, 0, &m_queue);
    return true;
  }

  bool VulkanContext::createCommandObjects(std::string& error) {
    VkCommandPoolCreateInfo poolInfo = {};
    poolInfo.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    poolInfo.flags = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
    poolInfo.queueFamilyIndex = m_queueFamily;

    VkResult result = m_api.vkCreateCommandPool(m_device, &poolInfo, nullptr, &m_commandPool);
    if (result != VK_SUCCESS) {
      error = vkToString("vkCreateCommandPool", result);
      return false;
    }

    VkCommandBufferAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    allocInfo.commandPool = m_commandPool;
    allocInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocInfo.commandBufferCount = 1;

    result = m_api.vkAllocateCommandBuffers(m_device, &allocInfo, &m_commandBuffer);
    if (result != VK_SUCCESS) {
      error = vkToString("vkAllocateCommandBuffers", result);
      return false;
    }

    VkFenceCreateInfo fenceInfo = {};
    fenceInfo.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    result = m_api.vkCreateFence(m_device, &fenceInfo, nullptr, &m_fence);
    if (result != VK_SUCCESS) {
      error = vkToString("vkCreateFence", result);
      return false;
    }

    return true;
  }

  bool VulkanContext::findMemoryType(uint32_t typeBits,
                                     VkMemoryPropertyFlags required,
                                     VkMemoryPropertyFlags forbidden,
                                     uint32_t& outType) const {
    for (uint32_t i = 0; i < m_memoryProperties.memoryTypeCount; ++i) {
      if ((typeBits & (1u << i)) == 0) {
        continue;
      }
      const VkMemoryPropertyFlags flags = m_memoryProperties.memoryTypes[i].propertyFlags;
      if ((flags & required) != required) {
        continue;
      }
      if ((flags & forbidden) != 0) {
        continue;
      }
      outType = i;
      return true;
    }
    return false;
  }

  bool VulkanContext::createImage(Image& out, VkFormat format, const char* label, std::string& error) {
    VkImageCreateInfo info = {};
    info.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    info.imageType = VK_IMAGE_TYPE_2D;
    info.format = format;
    info.extent = { m_width, m_height, 1 };
    info.mipLevels = 1;
    info.arrayLayers = 1;
    info.samples = VK_SAMPLE_COUNT_1_BIT;
    info.tiling = VK_IMAGE_TILING_OPTIMAL;
    // STORAGE on everything, matching the D3D12 backend's decision to give both colour textures
    // UAV capability: NVSDK_NGX_Resource_VK::ReadWrite requires VK_IMAGE_USAGE_STORAGE_BIT on the
    // output, and a format that can be bound either way removes one way for a mismatch to become
    // a driver-side surprise.
    info.usage = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_SAMPLED_BIT |
                 VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    info.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

    VkResult result = m_api.vkCreateImage(m_device, &info, nullptr, &out.image);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkCreateImage (") + label + ")").c_str(), result);
      return false;
    }

    VkMemoryRequirements requirements = {};
    m_api.vkGetImageMemoryRequirements(m_device, out.image, &requirements);

    uint32_t typeIndex = 0;
    if (!findMemoryType(requirements.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0,
                        typeIndex)) {
      error = std::string("No device-local memory type for the ") + label + " image";
      return false;
    }

    VkMemoryAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = requirements.size;
    allocInfo.memoryTypeIndex = typeIndex;

    result = m_api.vkAllocateMemory(m_device, &allocInfo, nullptr, &out.memory);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkAllocateMemory (") + label + ")").c_str(), result);
      return false;
    }

    result = m_api.vkBindImageMemory(m_device, out.image, out.memory, 0);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkBindImageMemory (") + label + ")").c_str(), result);
      return false;
    }

    VkImageViewCreateInfo viewInfo = {};
    viewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
    viewInfo.image = out.image;
    viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
    // The view format matches the image format exactly. No _SRGB view: see kColorFormat above.
    viewInfo.format = format;
    viewInfo.components = { VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY,
                            VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY };
    viewInfo.subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };

    result = m_api.vkCreateImageView(m_device, &viewInfo, nullptr, &out.view);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkCreateImageView (") + label + ")").c_str(), result);
      return false;
    }

    out.format = format;
    out.width = m_width;
    out.height = m_height;
    out.initialized = false;
    out.committedInitialized = false;
    return true;
  }

  bool VulkanContext::createBuffer(Buffer& out,
                                   VkDeviceSize size,
                                   VkBufferUsageFlags usage,
                                   VkMemoryPropertyFlags required,
                                   VkMemoryPropertyFlags forbidden,
                                   const char* label,
                                   std::string& error) {
    VkBufferCreateInfo info = {};
    info.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    info.size = size;
    info.usage = usage;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    VkResult result = m_api.vkCreateBuffer(m_device, &info, nullptr, &out.buffer);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkCreateBuffer (") + label + ")").c_str(), result);
      return false;
    }

    VkMemoryRequirements requirements = {};
    m_api.vkGetBufferMemoryRequirements(m_device, out.buffer, &requirements);

    uint32_t typeIndex = 0;
    if (!findMemoryType(requirements.memoryTypeBits, required, forbidden, typeIndex)) {
      // Retry without the exclusions rather than fail outright: they express a performance
      // preference, not a correctness requirement.
      if (!findMemoryType(requirements.memoryTypeBits, required, 0, typeIndex)) {
        error = std::string("No host-visible memory type for the ") + label + " buffer";
        return false;
      }
      logInfo(std::string("Falling back to a less suitable memory type for the ") + label +
              " buffer");
    }

    logInfo(std::string("Vulkan ") + label + " buffer memory type " + std::to_string(typeIndex) +
            " (" + describeMemoryFlags(m_memoryProperties.memoryTypes[typeIndex].propertyFlags) +
            ")");

    VkMemoryAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.allocationSize = requirements.size;
    allocInfo.memoryTypeIndex = typeIndex;

    result = m_api.vkAllocateMemory(m_device, &allocInfo, nullptr, &out.memory);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkAllocateMemory (") + label + ")").c_str(), result);
      return false;
    }

    result = m_api.vkBindBufferMemory(m_device, out.buffer, out.memory, 0);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkBindBufferMemory (") + label + ")").c_str(), result);
      return false;
    }

    // Mapped once and left mapped. The allocation never changes, and a vkMapMemory per frame is
    // a driver round trip that buys nothing.
    void* mapped = nullptr;
    result = m_api.vkMapMemory(m_device, out.memory, 0, VK_WHOLE_SIZE, 0, &mapped);
    if (result != VK_SUCCESS) {
      error = vkToString((std::string("vkMapMemory (") + label + ")").c_str(), result);
      return false;
    }

    out.mapped = static_cast<uint8_t*>(mapped);
    out.size = size;
    return true;
  }

  bool VulkanContext::createResources(std::string& error) {
    if (!createImage(m_color, kColorFormat, "colour", error) ||
        !createImage(m_output, kColorFormat, "output", error)) {
      return false;
    }

    m_rowPitch = m_width * bytesPerTexel(kColorFormat);
    const VkDeviceSize colorBytes =
      static_cast<VkDeviceSize>(m_rowPitch) * static_cast<VkDeviceSize>(m_height);

    // HOST_VISIBLE | HOST_COHERENT but explicitly NOT HOST_CACHED and NOT DEVICE_LOCAL, which on
    // NVIDIA selects write-combined system memory - the same class of memory a D3D12 UPLOAD heap
    // lands in. That is what the pack loop is tuned for: one sequential, full-width 64-bit store
    // per pixel. Getting this wrong is a 40ms/frame mistake, not a rounding error.
    if (!createBuffer(m_upload, colorBytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      VK_MEMORY_PROPERTY_HOST_CACHED_BIT | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      "colour upload", error)) {
      return false;
    }

    // Readback wants the opposite: HOST_CACHED, because the unpack loop reads every byte of it.
    // An uncached readback buffer would move the whole cost of the frame into unpack.
    if (!createBuffer(m_readback, colorBytes, VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT |
                        VK_MEMORY_PROPERTY_HOST_CACHED_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, "readback", error)) {
      return false;
    }

    if (m_needDepth) {
      if (!createImage(m_depth, kDepthFormat, "depth", error)) {
        return false;
      }
      m_depthRowPitch = m_width * bytesPerTexel(kDepthFormat);
      if (!createBuffer(m_depthUpload,
                        static_cast<VkDeviceSize>(m_depthRowPitch) * m_height,
                        VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                        VK_MEMORY_PROPERTY_HOST_CACHED_BIT | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                        "depth upload", error)) {
        return false;
      }
    }

    if (m_needMotion) {
      if (!createImage(m_motion, kMotionFormat, "motion", error)) {
        return false;
      }
      m_motionRowPitch = m_width * bytesPerTexel(kMotionFormat);
      if (!createBuffer(m_motionUpload,
                        static_cast<VkDeviceSize>(m_motionRowPitch) * m_height,
                        VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                        VK_MEMORY_PROPERTY_HOST_CACHED_BIT | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                        "motion upload", error)) {
        return false;
      }
    }

    return true;
  }

  void VulkanContext::destroyImage(Image& image) {
    if (m_device == VK_NULL_HANDLE) {
      return;
    }
    if (image.view && m_api.vkDestroyImageView) {
      m_api.vkDestroyImageView(m_device, image.view, nullptr);
      image.view = VK_NULL_HANDLE;
    }
    if (image.image && m_api.vkDestroyImage) {
      m_api.vkDestroyImage(m_device, image.image, nullptr);
      image.image = VK_NULL_HANDLE;
    }
    if (image.memory && m_api.vkFreeMemory) {
      m_api.vkFreeMemory(m_device, image.memory, nullptr);
      image.memory = VK_NULL_HANDLE;
    }
  }

  void VulkanContext::destroyBuffer(Buffer& buffer) {
    if (m_device == VK_NULL_HANDLE) {
      return;
    }
    if (buffer.mapped && m_api.vkUnmapMemory) {
      m_api.vkUnmapMemory(m_device, buffer.memory);
      buffer.mapped = nullptr;
    }
    if (buffer.buffer && m_api.vkDestroyBuffer) {
      m_api.vkDestroyBuffer(m_device, buffer.buffer, nullptr);
      buffer.buffer = VK_NULL_HANDLE;
    }
    if (buffer.memory && m_api.vkFreeMemory) {
      m_api.vkFreeMemory(m_device, buffer.memory, nullptr);
      buffer.memory = VK_NULL_HANDLE;
    }
  }

  // Every image here spends its entire life in VK_IMAGE_LAYOUT_GENERAL, transitioned once out of
  // UNDEFINED and never moved again.
  //
  // This is deliberate rather than lazy. The snippet records its own pipeline barriers against
  // the images it is handed, and nothing documents what layouts it expects or leaves behind. If
  // it moved an image and this class believed otherwise, the next frame would declare an
  // oldLayout the image was never in - which is undefined behaviour, and would show up as
  // corrupted output rather than an error. The validated dxvk-remix integration hands NGX storage
  // images in GENERAL, so GENERAL in and GENERAL out is the arrangement that has actually been
  // exercised. On NVIDIA a STORAGE-capable image is uncompressed anyway, so GENERAL costs nothing
  // against TRANSFER_DST_OPTIMAL for these copies.
  void VulkanContext::toGeneral(Image& image) {
    if (image.initialized) {
      return;
    }

    VkImageMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    barrier.srcAccessMask = 0;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_READ_BIT |
                            VK_ACCESS_SHADER_WRITE_BIT;
    barrier.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    barrier.newLayout = VK_IMAGE_LAYOUT_GENERAL;
    barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.image = image.image;
    barrier.subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };

    m_api.vkCmdPipelineBarrier(m_commandBuffer, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
                               VK_PIPELINE_STAGE_TRANSFER_BIT |
                                 VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                               0, 0, nullptr, 0, nullptr, 1, &barrier);
    image.initialized = true;
  }

  void VulkanContext::memoryBarrier(Image& image,
                                    VkPipelineStageFlags srcStage,
                                    VkAccessFlags srcAccess,
                                    VkPipelineStageFlags dstStage,
                                    VkAccessFlags dstAccess) {
    VkImageMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    barrier.srcAccessMask = srcAccess;
    barrier.dstAccessMask = dstAccess;
    barrier.oldLayout = VK_IMAGE_LAYOUT_GENERAL;
    barrier.newLayout = VK_IMAGE_LAYOUT_GENERAL;
    barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.image = image.image;
    barrier.subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };

    m_api.vkCmdPipelineBarrier(m_commandBuffer, srcStage, dstStage, 0, 0, nullptr, 0, nullptr, 1,
                               &barrier);
  }

  void VulkanContext::copyBufferToImage(const Buffer& buffer,
                                        Image& image,
                                        uint32_t rowPitchTexels) {
    toGeneral(image);

    VkBufferImageCopy region = {};
    region.bufferOffset = 0;
    region.bufferRowLength = rowPitchTexels;
    region.bufferImageHeight = m_height;
    region.imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
    region.imageOffset = { 0, 0, 0 };
    region.imageExtent = { m_width, m_height, 1 };

    m_api.vkCmdCopyBufferToImage(m_commandBuffer, buffer.buffer, image.image,
                                 VK_IMAGE_LAYOUT_GENERAL, 1, &region);

    memoryBarrier(image, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT,
                  VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT);
  }

  bool VulkanContext::begin(std::string& error) {
    // A previous frame that failed after begin() left the buffer open with barriers recorded but
    // never submitted. Close it and roll the tracked state back to what the GPU actually saw,
    // otherwise the next frame skips a transition that never executed.
    if (m_recording) {
      m_api.vkEndCommandBuffer(m_commandBuffer);
      m_recording = false;
      m_color.initialized = m_color.committedInitialized;
      m_output.initialized = m_output.committedInitialized;
      m_depth.initialized = m_depth.committedInitialized;
      m_motion.initialized = m_motion.committedInitialized;
    }

    VkResult result = m_api.vkResetCommandPool(m_device, m_commandPool, 0);
    if (result != VK_SUCCESS) {
      error = vkToString("vkResetCommandPool", result);
      return false;
    }

    VkCommandBufferBeginInfo beginInfo = {};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;

    result = m_api.vkBeginCommandBuffer(m_commandBuffer, &beginInfo);
    if (result != VK_SUCCESS) {
      error = vkToString("vkBeginCommandBuffer", result);
      return false;
    }

    m_recording = true;
    return true;
  }

  void VulkanContext::recordPreEvaluate(bool uploadMotion) {
    copyBufferToImage(m_upload, m_color, m_width);
    if (m_needDepth) {
      copyBufferToImage(m_depthUpload, m_depth, m_width);
    }
    if (m_needMotion && uploadMotion) {
      copyBufferToImage(m_motionUpload, m_motion, m_width);
    }

    // The output is written by NGX, so nothing in it needs preserving. All it needs is to be in
    // GENERAL and for last frame's readback copy to have finished reading it.
    toGeneral(m_output);
    memoryBarrier(m_output, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT,
                  VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT);
  }

  void VulkanContext::recordPostEvaluate() {
    memoryBarrier(m_output, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT,
                  VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT);

    VkBufferImageCopy region = {};
    region.bufferOffset = 0;
    region.bufferRowLength = m_width;
    region.bufferImageHeight = m_height;
    region.imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
    region.imageOffset = { 0, 0, 0 };
    region.imageExtent = { m_width, m_height, 1 };

    m_api.vkCmdCopyImageToBuffer(m_commandBuffer, m_output.image, VK_IMAGE_LAYOUT_GENERAL,
                                 m_readback.buffer, 1, &region);

    // Signalling a fence does not make device writes visible to the host - the access scope of a
    // fence only reaches the device domain - so the readback needs an explicit barrier into the
    // host domain. Coherent memory does not remove this: it removes the invalidate, not the
    // availability operation.
    VkBufferMemoryBarrier hostBarrier = {};
    hostBarrier.sType = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER;
    hostBarrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    hostBarrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    hostBarrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    hostBarrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    hostBarrier.buffer = m_readback.buffer;
    hostBarrier.offset = 0;
    hostBarrier.size = VK_WHOLE_SIZE;

    m_api.vkCmdPipelineBarrier(m_commandBuffer, VK_PIPELINE_STAGE_TRANSFER_BIT,
                               VK_PIPELINE_STAGE_HOST_BIT, 0, 0, nullptr, 1, &hostBarrier, 0,
                               nullptr);
  }

  bool VulkanContext::endAndWait(std::string& error) {
    auto rollback = [this]() {
      m_color.initialized = m_color.committedInitialized;
      m_output.initialized = m_output.committedInitialized;
      m_depth.initialized = m_depth.committedInitialized;
      m_motion.initialized = m_motion.committedInitialized;
    };

    VkResult result = m_api.vkEndCommandBuffer(m_commandBuffer);
    m_recording = false;

    if (result != VK_SUCCESS) {
      // Nothing was submitted, so the recorded barriers never happened.
      rollback();
      error = vkToString("vkEndCommandBuffer", result);
      return false;
    }

    result = m_api.vkResetFences(m_device, 1, &m_fence);
    if (result != VK_SUCCESS) {
      rollback();
      error = vkToString("vkResetFences", result);
      return false;
    }

    VkSubmitInfo submit = {};
    submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submit.commandBufferCount = 1;
    submit.pCommandBuffers = &m_commandBuffer;

    result = m_api.vkQueueSubmit(m_queue, 1, &submit, m_fence);
    if (result != VK_SUCCESS) {
      rollback();
      error = vkToString("vkQueueSubmit", result);
      return false;
    }

    // Submitted: the recorded barriers are now what the GPU will have seen.
    m_color.committedInitialized = m_color.initialized;
    m_output.committedInitialized = m_output.initialized;
    m_depth.committedInitialized = m_depth.initialized;
    m_motion.committedInitialized = m_motion.initialized;

    // A generous but finite wait, for the same reason the D3D12 backend uses one: an indefinite
    // wait turns a driver-side hang into a frozen encode with no diagnostic.
    constexpr uint64_t kTimeoutNs = 30ull * 1000ull * 1000ull * 1000ull;
    result = m_api.vkWaitForFences(m_device, 1, &m_fence, VK_TRUE, kTimeoutNs);
    if (result == VK_TIMEOUT) {
      error = "Timed out waiting for the GPU to finish the Neural Uplift evaluation";
      return false;
    }
    if (result != VK_SUCCESS) {
      error = vkToString("vkWaitForFences", result);
      return false;
    }

    return true;
  }

  uint8_t* VulkanContext::mapUpload(std::string& error) {
    if (m_upload.mapped == nullptr) {
      error = "The colour upload buffer is not mapped";
    }
    return m_upload.mapped;
  }

  void VulkanContext::unmapUpload() {}

  uint8_t* VulkanContext::mapDepthUpload(std::string& error) {
    if (m_depthUpload.mapped == nullptr) {
      error = "The depth upload buffer is not mapped";
    }
    return m_depthUpload.mapped;
  }

  void VulkanContext::unmapDepthUpload() {}

  uint8_t* VulkanContext::mapMotionUpload(std::string& error) {
    if (m_motionUpload.mapped == nullptr) {
      error = "The motion upload buffer is not mapped";
    }
    return m_motionUpload.mapped;
  }

  void VulkanContext::unmapMotionUpload() {}

  const uint8_t* VulkanContext::mapReadback(std::string& error) {
    if (m_readback.mapped == nullptr) {
      error = "The readback buffer is not mapped";
    }
    return m_readback.mapped;
  }

  void VulkanContext::unmapReadback() {}

} // namespace vsdlssnr
