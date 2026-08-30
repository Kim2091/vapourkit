#pragma once

#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>

namespace vsdlssnr {

  using Microsoft::WRL::ComPtr;

  // A minimal single-queue D3D12 host for one NGX feature.
  //
  // D3D12 rather than Vulkan on purpose: nvngx_dlssnr.dll exports the D3D12 NGX entry points
  // alongside the Vulkan ones, and the D3D12 path carries none of the Vulkan feature's
  // device-extension requirements (VK_NVX_binary_import, VK_NVX_image_view_handle,
  // VK_EXT_buffer_device_address, VK_KHR_push_descriptor). For a plugin that owns its own
  // device and renders nothing, that is all cost with no benefit.
  //
  // Everything is sized once at Create time and reused for every frame: the textures, the
  // upload buffer and the readback buffer. A clip cannot change resolution mid-stream, so
  // there is nothing to resize.
  class D3D12Context {
  public:
    D3D12Context() = default;
    ~D3D12Context();

    D3D12Context(const D3D12Context&) = delete;
    D3D12Context& operator=(const D3D12Context&) = delete;

    bool initialize(uint32_t width, uint32_t height, std::string& error);

    ID3D12Device* device() const { return m_device.Get(); }
    ID3D12GraphicsCommandList* commandList() const { return m_commandList.Get(); }
    ID3D12Resource* colorTexture() const { return m_colorTexture.Get(); }
    ID3D12Resource* outputTexture() const { return m_outputTexture.Get(); }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }

    // Bytes per row in the staging buffers. D3D12 requires copy footprints to be a multiple of
    // D3D12_TEXTURE_DATA_PITCH_ALIGNMENT, so this is generally wider than width * 8.
    uint32_t stagingRowPitch() const { return m_rowPitch; }

    // Opens the command list for recording. Every frame starts here.
    bool begin(std::string& error);

    // Records upload -> colour texture, and leaves colour readable and output writable for the
    // NGX evaluation the caller records next.
    void recordPreEvaluate();

    // Records output -> readback. Call after the NGX evaluation has been recorded.
    void recordPostEvaluate();

    // Closes, submits and blocks until the GPU is done. Blocking is correct here: VapourSynth
    // has already given this filter a worker thread and expects a finished frame back from it,
    // so there is nothing else for this thread to do.
    bool endAndWait(std::string& error);

    // Staging access. The upload buffer is write-combined; write it front to back and never
    // read it back.
    uint8_t* mapUpload(std::string& error);
    void unmapUpload();
    const uint8_t* mapReadback(std::string& error);
    void unmapReadback();

  private:
    bool createDevice(std::string& error);
    bool createQueueAndList(std::string& error);
    bool createResources(std::string& error);

    void transition(ID3D12Resource* resource,
                    D3D12_RESOURCE_STATES& tracked,
                    D3D12_RESOURCE_STATES after);

    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_queue;
    ComPtr<ID3D12CommandAllocator> m_allocator;
    ComPtr<ID3D12GraphicsCommandList> m_commandList;
    ComPtr<ID3D12Fence> m_fence;
    HANDLE m_fenceEvent = nullptr;
    uint64_t m_fenceValue = 0;

    ComPtr<ID3D12Resource> m_colorTexture;
    ComPtr<ID3D12Resource> m_outputTexture;
    ComPtr<ID3D12Resource> m_uploadBuffer;
    ComPtr<ID3D12Resource> m_readbackBuffer;

    // Tracked states are speculative while a list is open: the transitions have been recorded
    // but not executed. The committed pair is what the GPU has actually seen, so an abandoned
    // list can roll back to it rather than leaving the tracker describing a frame that never ran.
    D3D12_RESOURCE_STATES m_colorState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_outputState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedColorState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedOutputState = D3D12_RESOURCE_STATE_COMMON;

    // A frame that fails partway through returns without submitting, leaving the list open.
    // Reset must not be called on an open list, so the next begin() closes it first.
    bool m_listOpen = false;

    D3D12_PLACED_SUBRESOURCE_FOOTPRINT m_footprint = {};

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_rowPitch = 0;
    uint64_t m_stagingBytes = 0;
  };

} // namespace vsdlssnr
