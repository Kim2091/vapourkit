#pragma once

// Vulkan host for one DLSS-NR feature - the parallel of D3D12Context, offered as an alternative
// backend rather than a replacement. The contract is deliberately the same shape:
//
//   initialize / begin / map upload / recordPreEvaluate / recordPostEvaluate / endAndWait /
//   map readback
//
// so the frame loop drives either one through the same sequence of calls.
//
// THIS HEADER MUST NOT BE INCLUDED BY THE D3D12 PATH. It pulls in vulkan.h, and leaking that
// into the shared headers is what broke the working D3D12 build once already. plugin.cpp reaches
// the Vulkan backend only through vulkan_backend.h, which names no Vulkan type at all.
//
// What is NOT here, on purpose: automatic motion. That path is D3D12 Video fixed-function motion
// estimation, which has no Vulkan equivalent (VK_NV_optical_flow is a different animal and a
// separate piece of work). auto_motion with backend="vulkan" is a create-time error in the
// plugin rather than a silent degradation.

#define VK_NO_PROTOTYPES
// VK_KHR_external_memory_win32 / _semaphore_win32 are Win32-platform extensions, so their name
// macros only exist once this is defined. They are optional here - NGX uses them opportunistically
// - but naming them keeps the device arrangement identical to the validated dxvk-remix one.
#define VK_USE_PLATFORM_WIN32_KHR
#include <vulkan/vulkan.h>

#include <cstdint>
#include <string>
#include <vector>

namespace vsdlssnr {

  // Every Vulkan entry point this file uses, resolved out of vulkan-1.dll at runtime.
  //
  // Loaded by hand rather than linked. This plugin ships to every user; a static import on
  // vulkan-1.lib means that on any machine with a missing or broken loader, vsdlssnr.dll fails
  // to load at all and takes the working D3D12 backend down with it. Resolved dynamically, a
  // missing loader degrades to "the Vulkan backend is unavailable" and nothing else changes.
  struct VulkanApi {
    PFN_vkGetInstanceProcAddr vkGetInstanceProcAddr = nullptr;
    PFN_vkGetDeviceProcAddr vkGetDeviceProcAddr = nullptr;

    PFN_vkCreateInstance vkCreateInstance = nullptr;
    PFN_vkEnumerateInstanceExtensionProperties vkEnumerateInstanceExtensionProperties = nullptr;

    PFN_vkDestroyInstance vkDestroyInstance = nullptr;
    PFN_vkEnumeratePhysicalDevices vkEnumeratePhysicalDevices = nullptr;
    PFN_vkGetPhysicalDeviceProperties vkGetPhysicalDeviceProperties = nullptr;
    PFN_vkGetPhysicalDeviceFeatures2 vkGetPhysicalDeviceFeatures2 = nullptr;
    PFN_vkGetPhysicalDeviceMemoryProperties vkGetPhysicalDeviceMemoryProperties = nullptr;
    PFN_vkGetPhysicalDeviceQueueFamilyProperties vkGetPhysicalDeviceQueueFamilyProperties = nullptr;
    PFN_vkEnumerateDeviceExtensionProperties vkEnumerateDeviceExtensionProperties = nullptr;
    PFN_vkCreateDevice vkCreateDevice = nullptr;

    PFN_vkDestroyDevice vkDestroyDevice = nullptr;
    PFN_vkDeviceWaitIdle vkDeviceWaitIdle = nullptr;
    PFN_vkGetDeviceQueue vkGetDeviceQueue = nullptr;
    PFN_vkCreateCommandPool vkCreateCommandPool = nullptr;
    PFN_vkDestroyCommandPool vkDestroyCommandPool = nullptr;
    PFN_vkResetCommandPool vkResetCommandPool = nullptr;
    PFN_vkAllocateCommandBuffers vkAllocateCommandBuffers = nullptr;
    PFN_vkBeginCommandBuffer vkBeginCommandBuffer = nullptr;
    PFN_vkEndCommandBuffer vkEndCommandBuffer = nullptr;
    PFN_vkQueueSubmit vkQueueSubmit = nullptr;
    PFN_vkCreateFence vkCreateFence = nullptr;
    PFN_vkDestroyFence vkDestroyFence = nullptr;
    PFN_vkWaitForFences vkWaitForFences = nullptr;
    PFN_vkResetFences vkResetFences = nullptr;
    PFN_vkCreateImage vkCreateImage = nullptr;
    PFN_vkDestroyImage vkDestroyImage = nullptr;
    PFN_vkGetImageMemoryRequirements vkGetImageMemoryRequirements = nullptr;
    PFN_vkBindImageMemory vkBindImageMemory = nullptr;
    PFN_vkCreateImageView vkCreateImageView = nullptr;
    PFN_vkDestroyImageView vkDestroyImageView = nullptr;
    PFN_vkCreateBuffer vkCreateBuffer = nullptr;
    PFN_vkDestroyBuffer vkDestroyBuffer = nullptr;
    PFN_vkGetBufferMemoryRequirements vkGetBufferMemoryRequirements = nullptr;
    PFN_vkBindBufferMemory vkBindBufferMemory = nullptr;
    PFN_vkAllocateMemory vkAllocateMemory = nullptr;
    PFN_vkFreeMemory vkFreeMemory = nullptr;
    PFN_vkMapMemory vkMapMemory = nullptr;
    PFN_vkUnmapMemory vkUnmapMemory = nullptr;
    PFN_vkCmdPipelineBarrier vkCmdPipelineBarrier = nullptr;
    PFN_vkCmdCopyBufferToImage vkCmdCopyBufferToImage = nullptr;
    PFN_vkCmdCopyImageToBuffer vkCmdCopyImageToBuffer = nullptr;
  };

  class VulkanContext {
  public:
    VulkanContext() = default;
    ~VulkanContext();

    VulkanContext(const VulkanContext&) = delete;
    VulkanContext& operator=(const VulkanContext&) = delete;

    bool initialize(uint32_t width,
                    uint32_t height,
                    bool needDepth,
                    bool needMotion,
                    std::string& error);

    const VulkanApi& api() const { return m_api; }
    VkInstance instance() const { return m_instance; }
    VkPhysicalDevice physicalDevice() const { return m_physicalDevice; }
    VkDevice device() const { return m_device; }
    VkCommandBuffer commandBuffer() const { return m_commandBuffer; }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }

    // An image plus the metadata NVSDK_NGX_Resource_VK wants. Populated for the optional inputs
    // only when they were requested; `image` is VK_NULL_HANDLE otherwise, which is how the NGX
    // layer decides whether to bind them.
    struct Image {
      VkImage image = VK_NULL_HANDLE;
      VkDeviceMemory memory = VK_NULL_HANDLE;
      VkImageView view = VK_NULL_HANDLE;
      VkFormat format = VK_FORMAT_UNDEFINED;
      uint32_t width = 0;
      uint32_t height = 0;
      // Every image here lives its whole life in VK_IMAGE_LAYOUT_GENERAL - see the note on
      // toGeneral() in the .cpp. This tracks only whether the one-off UNDEFINED -> GENERAL
      // transition has been recorded yet.
      bool initialized = false;
      bool committedInitialized = false;
    };

    const Image& colorImage() const { return m_color; }
    const Image& outputImage() const { return m_output; }
    const Image& depthImage() const { return m_depth; }
    const Image& motionImage() const { return m_motion; }

    // Vulkan buffer-image copies address rows in texels and carry no 256-byte alignment rule, so
    // unlike D3D12 these pitches are exactly width * bytesPerTexel. At 3840 wide both backends
    // land on the same number anyway (30720 is already 256-aligned), which is one less thing
    // between the two outputs when comparing them bit for bit.
    uint32_t stagingRowPitch() const { return m_rowPitch; }
    uint32_t depthRowPitch() const { return m_depthRowPitch; }
    uint32_t motionRowPitch() const { return m_motionRowPitch; }

    bool begin(std::string& error);
    void recordPreEvaluate(bool uploadMotion);
    void recordPostEvaluate();
    bool endAndWait(std::string& error);

    // Host-visible staging memory is mapped once at initialize and stays mapped: it is the same
    // allocation every frame, and a vkMapMemory per frame buys nothing but a driver round trip.
    // These keep the D3D12 map/unmap names so the frame loop reads the same either way.
    uint8_t* mapUpload(std::string& error);
    void unmapUpload();
    uint8_t* mapDepthUpload(std::string& error);
    void unmapDepthUpload();
    uint8_t* mapMotionUpload(std::string& error);
    void unmapMotionUpload();
    const uint8_t* mapReadback(std::string& error);
    void unmapReadback();

  private:
    struct Buffer {
      VkBuffer buffer = VK_NULL_HANDLE;
      VkDeviceMemory memory = VK_NULL_HANDLE;
      VkDeviceSize size = 0;
      uint8_t* mapped = nullptr;
    };

    bool loadLoader(std::string& error);
    bool createInstance(std::string& error);
    bool pickPhysicalDevice(std::string& error);
    bool createDevice(std::string& error);
    bool createCommandObjects(std::string& error);
    bool createResources(std::string& error);

    bool createImage(Image& out, VkFormat format, const char* label, std::string& error);
    bool createBuffer(Buffer& out,
                      VkDeviceSize size,
                      VkBufferUsageFlags usage,
                      VkMemoryPropertyFlags required,
                      VkMemoryPropertyFlags forbidden,
                      const char* label,
                      std::string& error);
    bool findMemoryType(uint32_t typeBits,
                        VkMemoryPropertyFlags required,
                        VkMemoryPropertyFlags forbidden,
                        uint32_t& outType) const;
    void destroyImage(Image& image);
    void destroyBuffer(Buffer& buffer);

    void toGeneral(Image& image);
    void memoryBarrier(Image& image,
                       VkPipelineStageFlags srcStage,
                       VkAccessFlags srcAccess,
                       VkPipelineStageFlags dstStage,
                       VkAccessFlags dstAccess);
    void copyBufferToImage(const Buffer& buffer, Image& image, uint32_t rowPitchTexels);

    void* m_loader = nullptr;
    VulkanApi m_api = {};

    VkInstance m_instance = VK_NULL_HANDLE;
    VkPhysicalDevice m_physicalDevice = VK_NULL_HANDLE;
    VkDevice m_device = VK_NULL_HANDLE;
    VkQueue m_queue = VK_NULL_HANDLE;
    uint32_t m_queueFamily = 0;
    VkPhysicalDeviceMemoryProperties m_memoryProperties = {};

    VkCommandPool m_commandPool = VK_NULL_HANDLE;
    VkCommandBuffer m_commandBuffer = VK_NULL_HANDLE;
    VkFence m_fence = VK_NULL_HANDLE;
    // A frame that fails partway through returns without submitting, leaving the buffer open.
    // The next begin() has to know that so it can roll the tracked state back.
    bool m_recording = false;

    Image m_color;
    Image m_output;
    Image m_depth;
    Image m_motion;

    Buffer m_upload;
    Buffer m_depthUpload;
    Buffer m_motionUpload;
    Buffer m_readback;

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_rowPitch = 0;
    uint32_t m_depthRowPitch = 0;
    uint32_t m_motionRowPitch = 0;
    bool m_needDepth = false;
    bool m_needMotion = false;
  };

} // namespace vsdlssnr
