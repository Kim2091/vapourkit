#include "d3d12_ctx.h"

#include "log.h"

#include <sstream>

namespace vsdlssnr {

  namespace {

    // The colour format the Remix integration stages DLSS-NR through. Deliberately a plain
    // float format rather than an _SRGB-typed one: the model wants sRGB-ENCODED VALUES, and an
    // _SRGB view would have the hardware linearise them on read, which is exactly the
    // double-transfer bug the Remix port hit from the other direction.
    constexpr DXGI_FORMAT kColorFormat = DXGI_FORMAT_R16G16B16A16_FLOAT;

    constexpr uint32_t kBytesPerPixel = 8; // 4 channels * 16-bit float

    std::string hrToString(const char* what, HRESULT hr) {
      std::ostringstream os;
      os << what << " failed (hr=0x" << std::hex << static_cast<unsigned>(hr) << ")";
      return os.str();
    }

    D3D12_HEAP_PROPERTIES heapProps(D3D12_HEAP_TYPE type) {
      D3D12_HEAP_PROPERTIES props = {};
      props.Type = type;
      props.CPUPageProperty = D3D12_CPU_PAGE_PROPERTY_UNKNOWN;
      props.MemoryPoolPreference = D3D12_MEMORY_POOL_UNKNOWN;
      props.CreationNodeMask = 1;
      props.VisibleNodeMask = 1;
      return props;
    }

  } // namespace

  D3D12Context::~D3D12Context() {
    // The NGX feature is released by its owner before this runs, but a queued frame may still
    // be in flight; tearing down the heaps under it would fault in the driver.
    if (m_queue && m_fence && m_fenceEvent) {
      const uint64_t value = ++m_fenceValue;
      if (SUCCEEDED(m_queue->Signal(m_fence.Get(), value)) &&
          m_fence->GetCompletedValue() < value &&
          SUCCEEDED(m_fence->SetEventOnCompletion(value, m_fenceEvent))) {
        WaitForSingleObject(m_fenceEvent, 5000);
      }
    }

    if (m_fenceEvent) {
      CloseHandle(m_fenceEvent);
      m_fenceEvent = nullptr;
    }
  }

  bool D3D12Context::initialize(uint32_t width, uint32_t height, std::string& error) {
    m_width = width;
    m_height = height;

    return createDevice(error) && createQueueAndList(error) && createResources(error);
  }

  bool D3D12Context::createDevice(std::string& error) {
    ComPtr<IDXGIFactory4> factory;
    HRESULT hr = CreateDXGIFactory2(0, IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
      error = hrToString("CreateDXGIFactory2", hr);
      return false;
    }

    // The snippet rejects anything below Blackwell, so an adapter that is not NVIDIA cannot
    // possibly run it. Picking explicitly rather than taking the default also keeps this off an
    // integrated GPU on a laptop, which is where the default frequently lands.
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; ++i) {
      DXGI_ADAPTER_DESC1 desc = {};
      if (FAILED(adapter->GetDesc1(&desc))) {
        continue;
      }

      if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) {
        continue;
      }

      constexpr UINT kVendorNvidia = 0x10DE;
      if (desc.VendorId != kVendorNvidia) {
        continue;
      }

      if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_12_0, IID_PPV_ARGS(&m_device)))) {
        char name[128] = {};
        WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof(name) - 1, nullptr, nullptr);
        logInfo(std::string("Using adapter: ") + name);
        return true;
      }
    }

    error = "No NVIDIA D3D12 adapter was found. DLSS-NR requires a Blackwell (RTX 50-series) GPU.";
    return false;
  }

  bool D3D12Context::createQueueAndList(std::string& error) {
    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    queueDesc.Flags = D3D12_COMMAND_QUEUE_FLAG_NONE;
    queueDesc.NodeMask = 1;

    HRESULT hr = m_device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&m_queue));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandQueue", hr);
      return false;
    }

    hr = m_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&m_allocator));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandAllocator", hr);
      return false;
    }

    hr = m_device->CreateCommandList(1, D3D12_COMMAND_LIST_TYPE_DIRECT, m_allocator.Get(), nullptr,
                                     IID_PPV_ARGS(&m_commandList));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandList", hr);
      return false;
    }

    // Created open; the frame loop expects to find it closed and reset it first.
    m_commandList->Close();

    hr = m_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_fence));
    if (FAILED(hr)) {
      error = hrToString("CreateFence", hr);
      return false;
    }

    m_fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (m_fenceEvent == nullptr) {
      error = "CreateEventW failed";
      return false;
    }

    return true;
  }

  bool D3D12Context::createResources(std::string& error) {
    D3D12_RESOURCE_DESC texDesc = {};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Alignment = 0;
    texDesc.Width = m_width;
    texDesc.Height = m_height;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = 1;
    texDesc.Format = kColorFormat;
    texDesc.SampleDesc.Count = 1;
    texDesc.SampleDesc.Quality = 0;
    texDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    // Both get UAV capability. The output needs it because NGX writes it through a UAV; the
    // colour input does not, but a format that can be bound either way costs nothing here and
    // removes one way for a state mismatch to become a driver-side surprise.
    texDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS;

    const D3D12_HEAP_PROPERTIES defaultHeap = heapProps(D3D12_HEAP_TYPE_DEFAULT);

    HRESULT hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &texDesc,
                                                   D3D12_RESOURCE_STATE_COMMON, nullptr,
                                                   IID_PPV_ARGS(&m_colorTexture));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (colour)", hr);
      return false;
    }

    hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &texDesc,
                                          D3D12_RESOURCE_STATE_COMMON, nullptr,
                                          IID_PPV_ARGS(&m_outputTexture));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (output)", hr);
      return false;
    }

    UINT numRows = 0;
    UINT64 rowSizeBytes = 0;
    m_device->GetCopyableFootprints(&texDesc, 0, 1, 0, &m_footprint, &numRows, &rowSizeBytes,
                                    &m_stagingBytes);
    m_rowPitch = m_footprint.Footprint.RowPitch;

    if (m_rowPitch < m_width * kBytesPerPixel) {
      error = "GetCopyableFootprints returned a row pitch narrower than one row of pixels";
      return false;
    }

    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Alignment = 0;
    bufferDesc.Width = m_stagingBytes;
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    bufferDesc.Flags = D3D12_RESOURCE_FLAG_NONE;

    const D3D12_HEAP_PROPERTIES uploadHeap = heapProps(D3D12_HEAP_TYPE_UPLOAD);
    hr = m_device->CreateCommittedResource(&uploadHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                                          D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
                                          IID_PPV_ARGS(&m_uploadBuffer));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (upload)", hr);
      return false;
    }

    const D3D12_HEAP_PROPERTIES readbackHeap = heapProps(D3D12_HEAP_TYPE_READBACK);
    hr = m_device->CreateCommittedResource(&readbackHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                                          D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                          IID_PPV_ARGS(&m_readbackBuffer));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (readback)", hr);
      return false;
    }

    return true;
  }

  void D3D12Context::transition(ID3D12Resource* resource,
                                D3D12_RESOURCE_STATES& tracked,
                                D3D12_RESOURCE_STATES after) {
    if (tracked == after) {
      return;
    }

    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Flags = D3D12_RESOURCE_BARRIER_FLAG_NONE;
    barrier.Transition.pResource = resource;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = tracked;
    barrier.Transition.StateAfter = after;

    m_commandList->ResourceBarrier(1, &barrier);
    tracked = after;
  }

  bool D3D12Context::begin(std::string& error) {
    // A previous frame that failed after begin() left the list open with transitions recorded
    // but never submitted. Close it and roll the tracker back to what the GPU actually saw,
    // otherwise the next barrier declares a StateBefore the resource was never in.
    if (m_listOpen) {
      m_commandList->Close();
      m_listOpen = false;
      m_colorState = m_committedColorState;
      m_outputState = m_committedOutputState;
    }

    HRESULT hr = m_allocator->Reset();
    if (FAILED(hr)) {
      error = hrToString("CommandAllocator::Reset", hr);
      return false;
    }

    hr = m_commandList->Reset(m_allocator.Get(), nullptr);
    if (FAILED(hr)) {
      error = hrToString("CommandList::Reset", hr);
      return false;
    }

    m_listOpen = true;
    return true;
  }

  void D3D12Context::recordPreEvaluate() {
    transition(m_colorTexture.Get(), m_colorState, D3D12_RESOURCE_STATE_COPY_DEST);

    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = m_colorTexture.Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dst.SubresourceIndex = 0;

    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = m_uploadBuffer.Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    src.PlacedFootprint = m_footprint;

    m_commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);

    // The Remix integration binds colour read-only and output as a UAV; mirror that split.
    transition(m_colorTexture.Get(), m_colorState, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    transition(m_outputTexture.Get(), m_outputState, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
  }

  void D3D12Context::recordPostEvaluate() {
    transition(m_outputTexture.Get(), m_outputState, D3D12_RESOURCE_STATE_COPY_SOURCE);

    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = m_readbackBuffer.Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    dst.PlacedFootprint = m_footprint;

    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = m_outputTexture.Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    src.SubresourceIndex = 0;

    m_commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
  }

  bool D3D12Context::endAndWait(std::string& error) {
    HRESULT hr = m_commandList->Close();
    m_listOpen = false;

    if (FAILED(hr)) {
      // Nothing was submitted, so the recorded transitions never happened.
      m_colorState = m_committedColorState;
      m_outputState = m_committedOutputState;
      error = hrToString("CommandList::Close", hr);
      return false;
    }

    ID3D12CommandList* lists[] = { m_commandList.Get() };
    m_queue->ExecuteCommandLists(1, lists);

    // Submitted: the recorded transitions are now what the GPU will have seen.
    m_committedColorState = m_colorState;
    m_committedOutputState = m_outputState;

    const uint64_t value = ++m_fenceValue;
    hr = m_queue->Signal(m_fence.Get(), value);
    if (FAILED(hr)) {
      error = hrToString("CommandQueue::Signal", hr);
      return false;
    }

    if (m_fence->GetCompletedValue() < value) {
      hr = m_fence->SetEventOnCompletion(value, m_fenceEvent);
      if (FAILED(hr)) {
        error = hrToString("Fence::SetEventOnCompletion", hr);
        return false;
      }

      // A generous but finite wait. An indefinite one turns a driver-side hang into a frozen
      // encode with no diagnostic, which is materially worse to debug than a failed frame.
      if (WaitForSingleObject(m_fenceEvent, 30000) != WAIT_OBJECT_0) {
        error = "Timed out waiting for the GPU to finish a Neural Uplift evaluation";
        return false;
      }
    }

    return true;
  }

  uint8_t* D3D12Context::mapUpload(std::string& error) {
    void* mapped = nullptr;
    // Null read range: the CPU will not read what it wrote, and saying so lets the driver skip
    // making the write-combined range coherent for reads.
    const D3D12_RANGE noRead = { 0, 0 };
    const HRESULT hr = m_uploadBuffer->Map(0, &noRead, &mapped);
    if (FAILED(hr)) {
      error = hrToString("Upload buffer Map", hr);
      return nullptr;
    }
    return static_cast<uint8_t*>(mapped);
  }

  void D3D12Context::unmapUpload() {
    // Null written range would mean "wrote nothing"; the whole buffer was written.
    const D3D12_RANGE written = { 0, static_cast<SIZE_T>(m_stagingBytes) };
    m_uploadBuffer->Unmap(0, &written);
  }

  const uint8_t* D3D12Context::mapReadback(std::string& error) {
    void* mapped = nullptr;
    const D3D12_RANGE readAll = { 0, static_cast<SIZE_T>(m_stagingBytes) };
    const HRESULT hr = m_readbackBuffer->Map(0, &readAll, &mapped);
    if (FAILED(hr)) {
      error = hrToString("Readback buffer Map", hr);
      return nullptr;
    }
    return static_cast<const uint8_t*>(mapped);
  }

  void D3D12Context::unmapReadback() {
    const D3D12_RANGE wroteNothing = { 0, 0 };
    m_readbackBuffer->Unmap(0, &wroteNothing);
  }

} // namespace vsdlssnr
