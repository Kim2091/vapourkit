#pragma once

#include <d3d12.h>
#include <d3d12video.h>
#include <dxgi1_4.h>
#include <wrl/client.h>

#include <array>
#include <cstdint>
#include <string>

namespace vsdlssnr {

  using Microsoft::WRL::ComPtr;

  // A minimal single-queue D3D12 host for one NGX feature.
  //
  // This is the default backend. A Vulkan equivalent lives in vulkan_ctx.h behind the opaque
  // interface in vulkan_backend.h; the two produce bitwise-identical output and measured level
  // on an RTX 5080 Laptop, so D3D12 keeps the default on the strength of being the verified path
  // rather than the faster one. D3D12 also carries none of the Vulkan feature's device-extension
  // requirements (VK_NVX_binary_import, VK_NVX_image_view_handle, VK_KHR_buffer_device_address,
  // VK_KHR_push_descriptor), and automatic motion exists only here - it is D3D12 Video.
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

    // Depth and motion are optional for DLSS-NR. Motion storage is also used by the optional
    // fixed-function D3D12 Video estimator, which is deliberately kept separate from the
    // caller-supplied motion interface.
    // wantPipeline allocates a second colour upload and readback buffer so one frame can be
    // packed and another unpacked while a third is on the GPU. The command allocator and list
    // stay single: they are only ever reset after a wait, so nothing in flight can see them.
    bool initialize(uint32_t width,
                    uint32_t height,
                    bool needDepth,
                    bool needMotion,
                    bool wantAutoMotion,
                    bool wantPipeline,
                    std::string& error);

    static constexpr uint32_t kSlots = 2;
    uint32_t slotCount() const { return m_slotCount; }

    ID3D12Device* device() const { return m_device.Get(); }
    ID3D12GraphicsCommandList* commandList() const { return m_commandList.Get(); }
    ID3D12Resource* colorTexture() const { return m_colorTexture.Get(); }
    ID3D12Resource* outputTexture() const { return m_outputTexture.Get(); }
    ID3D12Resource* depthTexture() const { return m_depthTexture.Get(); }
    ID3D12Resource* motionTexture() const { return m_motionTexture.Get(); }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }

    // Bytes per row in the staging buffers. D3D12 requires copy footprints to be a multiple of
    // D3D12_TEXTURE_DATA_PITCH_ALIGNMENT, so this is generally wider than width * 8.
    uint32_t stagingRowPitch() const { return m_rowPitch; }
    uint32_t depthRowPitch() const { return m_depthRowPitch; }
    uint32_t motionRowPitch() const { return m_motionRowPitch; }
    bool autoMotionAvailable() const { return m_autoMotionAvailable; }
    uint32_t autoMotionLumaRowPitch() const { return m_autoInputFootprints[0].Footprint.RowPitch; }
    uint32_t autoMotionChromaRowPitch() const { return m_autoInputFootprints[1].Footprint.RowPitch; }
    uint64_t autoMotionChromaOffset() const { return m_autoInputFootprints[1].Offset; }
    uint32_t autoMotionInputWidth() const { return m_autoInputWidth; }
    uint32_t autoMotionInputHeight() const { return m_autoInputHeight; }
    uint32_t autoMotionScale() const { return m_autoMotionScale; }

    // Opens the command list for recording. Every frame starts here.
    bool begin(std::string& error);

    // Records upload -> input textures, and leaves them readable and output writable for the
    // NGX evaluation the caller records next. Optional textures are copied only when allocated.
    void recordPreEvaluate(bool uploadMotion, uint32_t slot = 0);

    // Records output -> readback. Call after the NGX evaluation has been recorded.
    void recordPostEvaluate(uint32_t slot = 0);

    // Automatic motion runs in a tiny, fixed-function D3D12 Video pass before the normal NGX
    // evaluation. The caller writes one NV12 luma frame, then this estimates current ->
    // previous flow when a consecutive predecessor exists. A compute pass expands the resolved
    // block-grid S16 vectors into DLSS-NR's RG16F texture without a CPU round trip.
    bool beginAutoMotion(std::string& error);
    uint8_t* mapAutoMotionUpload(std::string& error);
    void unmapAutoMotionUpload();
    void recordAutoMotionInput(bool estimateThisFrame);
    bool endAutoMotionInputAndGenerate(bool hasPrevious, std::string& error);
    void recordAutoMotionExpand();

    // GPU-side timing. Off unless enabled: a timestamp query heap plus a ResolveQueryData per
    // frame is cheap but not free, and the numbers are only interesting while profiling.
    //
    // Wall-clock around the whole submit-and-wait is one opaque number covering the PCIe
    // copies, the network and the fence. These split it: the queue's own timestamps say what
    // the GPU actually spent on each stage, and GetClockCalibration says how long the work sat
    // in the queue before the GPU picked it up.
    void setProfiling(bool enabled);
    struct GpuTimings {
      double uploadMs = 0.0;    // upload buffer -> input textures
      double evaluateMs = 0.0;  // NGX EvaluateFeature
      double readbackMs = 0.0;  // output texture -> readback buffer
      double totalMs = 0.0;     // first to last timestamp
      double submitMs = 0.0;    // CPU: Close + ExecuteCommandLists + Signal
      // Wall clock from the Signal to the fence being observed complete. On the serial path
      // that is the same thing as time spent blocked; on the pipelined path the caller does a
      // frame's worth of CPU work in between, so it is elapsed time and not idle time. The
      // blocked figure is the "gpu+wait" phase in the profile line.
      double waitMs = 0.0;
      double latencyMs = 0.0;   // submit -> the GPU reaching the first timestamp
      bool valid = false;
    };
    const GpuTimings& lastGpuTimings() const { return m_gpuTimings; }

    // Closes, submits and blocks until the GPU is done. Blocking is correct here: VapourSynth
    // has already given this filter a worker thread and expects a finished frame back from it,
    // so there is nothing else for this thread to do.
    bool endAndWait(std::string& error);

    // The same thing split in two, for the pipelined path: submit() returns as soon as the work
    // is queued, and wait() blocks on the fence that submit() signalled. Only one submission may
    // be outstanding - the shared command allocator is reset by the next begin(), which is
    // therefore only legal after wait().
    bool submit(std::string& error);
    bool wait(std::string& error);

    // Signals a fresh fence value and blocks on it, so everything previously submitted is known
    // to be finished. The pipelined path uses this on any error: it may be holding a submission
    // it can no longer account for, and the next begin() resets the shared command allocator.
    bool drain(std::string& error);

    // Staging access. The upload buffer is write-combined; write it front to back and never
    // read it back.
    uint8_t* mapUpload(uint32_t slot, std::string& error);
    void unmapUpload(uint32_t slot);
    uint8_t* mapDepthUpload(std::string& error);
    void unmapDepthUpload();
    uint8_t* mapMotionUpload(std::string& error);
    void unmapMotionUpload();
    const uint8_t* mapReadback(uint32_t slot, std::string& error);
    void unmapReadback(uint32_t slot);

    // Diagnostics: copies the motion texture back so the caller can look at the estimated field
    // directly. Without this the only evidence that estimation works is that nothing crashed,
    // which a static test clip produces just as happily with an all-zero field.
    //
    // The readback buffer is allocated on first use rather than with the rest: it is the same
    // size as the motion upload buffer, which is pure waste for the normal path that never
    // reads motion back.
    bool ensureMotionReadback(std::string& error);
    void recordMotionReadback();
    const uint8_t* mapMotionReadback(std::string& error);
    void unmapMotionReadback();

  private:
    bool createDevice(std::string& error);
    void markTimestamp(uint32_t index);
    void resolveTimestamps();

    bool createQueueAndList(std::string& error);
    bool createResources(std::string& error);
    bool createAutoMotionResources(std::string& error);
    bool createAutoMotionExpandPipeline(std::string& error);
    bool createUploadResource(const D3D12_RESOURCE_DESC& textureDesc,
                              ComPtr<ID3D12Resource>& uploadBuffer,
                              D3D12_PLACED_SUBRESOURCE_FOOTPRINT& footprint,
                              uint32_t& rowPitch,
                              uint64_t& bytes,
                              const char* label,
                              std::string& error);
    void copyUploadToTexture(ID3D12Resource* upload,
                             const D3D12_PLACED_SUBRESOURCE_FOOTPRINT& footprint,
                             ID3D12Resource* texture,
                             D3D12_RESOURCE_STATES& textureState);
    uint8_t* mapUploadResource(ID3D12Resource* upload,
                               const char* label,
                               std::string& error);
    void unmapUploadResource(ID3D12Resource* upload, uint64_t bytes);

    void transition(ID3D12Resource* resource,
                    D3D12_RESOURCE_STATES& tracked,
                    D3D12_RESOURCE_STATES after);
    void transitionOn(ID3D12GraphicsCommandList* commandList,
                      ID3D12Resource* resource,
                      D3D12_RESOURCE_STATES& tracked,
                      D3D12_RESOURCE_STATES after);
    bool waitForQueue(ID3D12CommandQueue* queue,
                      ID3D12Fence* fence,
                      HANDLE event,
                      uint64_t& fenceValue,
                      const char* label,
                      std::string& error);

    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_queue;
    ComPtr<ID3D12CommandAllocator> m_allocator;
    ComPtr<ID3D12GraphicsCommandList> m_commandList;
    ComPtr<ID3D12Fence> m_fence;
    HANDLE m_fenceEvent = nullptr;
    uint64_t m_fenceValue = 0;

    ComPtr<ID3D12QueryHeap> m_timestampHeap;
    ComPtr<ID3D12Resource> m_timestampReadback;
    uint64_t m_timestampFrequency = 0;
    uint32_t m_marks = 0;
    // Carried from submit() to wait(), which is where the frame's numbers are finished.
    bool m_timingThisFrame = false;
    uint64_t m_pendingFenceValue = 0;
    LARGE_INTEGER m_qpcFrequency = {};
    LARGE_INTEGER m_submitStart = {};
    LARGE_INTEGER m_waitStart = {};
    uint64_t m_calibratedGpu = 0;
    uint64_t m_calibratedCpu = 0;
    GpuTimings m_gpuTimings;
    bool m_profiling = false;

    ComPtr<ID3D12CommandAllocator> m_autoAllocator;
    ComPtr<ID3D12GraphicsCommandList> m_autoCommandList;

    ComPtr<ID3D12VideoDevice1> m_videoDevice;
    ComPtr<ID3D12CommandQueue> m_videoQueue;
    ComPtr<ID3D12CommandAllocator> m_videoAllocator;
    ComPtr<ID3D12VideoEncodeCommandList> m_videoCommandList;
    ComPtr<ID3D12Fence> m_videoFence;
    HANDLE m_videoFenceEvent = nullptr;
    uint64_t m_videoFenceValue = 0;
    ComPtr<ID3D12VideoMotionEstimator> m_motionEstimator;
    ComPtr<ID3D12VideoMotionVectorHeap> m_motionVectorHeap;
    ComPtr<ID3D12DescriptorHeap> m_autoMotionDescriptorHeap;
    ComPtr<ID3D12RootSignature> m_autoMotionRootSignature;
    ComPtr<ID3D12PipelineState> m_autoMotionPipelineState;
    uint32_t m_autoMotionDescriptorSize = 0;

    ComPtr<ID3D12Resource> m_colorTexture;
    ComPtr<ID3D12Resource> m_outputTexture;
    ComPtr<ID3D12Resource> m_depthTexture;
    ComPtr<ID3D12Resource> m_motionTexture;
    // Allocated lazily by ensureMotionReadback; null on the normal path.
    ComPtr<ID3D12Resource> m_motionReadbackBuffer;
    std::array<ComPtr<ID3D12Resource>, kSlots> m_uploadBuffers;
    std::array<ComPtr<ID3D12Resource>, kSlots> m_readbackBuffers;
    ComPtr<ID3D12Resource> m_depthUploadBuffer;
    ComPtr<ID3D12Resource> m_motionUploadBuffer;
    ComPtr<ID3D12Resource> m_autoInputUploadBuffer;
    std::array<ComPtr<ID3D12Resource>, 2> m_autoInputTextures;
    ComPtr<ID3D12Resource> m_autoVectorTexture;

    // Tracked states are speculative while a list is open: the transitions have been recorded
    // but not executed. The committed pair is what the GPU has actually seen, so an abandoned
    // list can roll back to it rather than leaving the tracker describing a frame that never ran.
    D3D12_RESOURCE_STATES m_colorState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_outputState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_depthState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_motionState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedColorState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedOutputState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedDepthState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedMotionState = D3D12_RESOURCE_STATE_COMMON;
    std::array<D3D12_RESOURCE_STATES, 2> m_autoInputStates = {
      D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COMMON
    };
    std::array<D3D12_RESOURCE_STATES, 2> m_committedAutoInputStates = {
      D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_COMMON
    };
    D3D12_RESOURCE_STATES m_autoVectorState = D3D12_RESOURCE_STATE_COMMON;
    D3D12_RESOURCE_STATES m_committedAutoVectorState = D3D12_RESOURCE_STATE_COMMON;

    // A frame that fails partway through returns without submitting, leaving the list open.
    // Reset must not be called on an open list, so the next begin() closes it first.
    bool m_listOpen = false;
    bool m_autoListOpen = false;

    D3D12_PLACED_SUBRESOURCE_FOOTPRINT m_footprint = {};
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT m_depthFootprint = {};
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT m_motionFootprint = {};
    std::array<D3D12_PLACED_SUBRESOURCE_FOOTPRINT, 2> m_autoInputFootprints = {};

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_rowPitch = 0;
    uint32_t m_depthRowPitch = 0;
    uint32_t m_motionRowPitch = 0;
    uint64_t m_stagingBytes = 0;
    uint64_t m_depthUploadBytes = 0;
    uint64_t m_motionUploadBytes = 0;
    uint64_t m_autoInputUploadBytes = 0;
    uint32_t m_autoInputWidth = 0;
    uint32_t m_autoInputHeight = 0;
    uint32_t m_autoMotionScale = 1;
    uint32_t m_autoInputSlot = 0;
    uint32_t m_slotCount = 1;
    bool m_needDepth = false;
    bool m_needMotion = false;
    bool m_wantAutoMotion = false;
    bool m_autoMotionAvailable = false;
  };

} // namespace vsdlssnr
