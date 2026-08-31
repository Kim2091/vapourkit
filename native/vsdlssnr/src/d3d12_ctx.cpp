#include "d3d12_ctx.h"

#include "log.h"

#include <d3dcompiler.h>

#include <algorithm>
#include <cstring>
#include <sstream>

namespace vsdlssnr {

  namespace {

    // The colour format the Remix integration stages DLSS-NR through. Deliberately a plain
    // float format rather than an _SRGB-typed one: the model wants sRGB-ENCODED VALUES, and an
    // _SRGB view would have the hardware linearise them on read, which is exactly the
    // double-transfer bug the Remix port hit from the other direction.
    constexpr DXGI_FORMAT kColorFormat = DXGI_FORMAT_R16G16B16A16_FLOAT;
    constexpr DXGI_FORMAT kDepthFormat = DXGI_FORMAT_R32_FLOAT;
    constexpr DXGI_FORMAT kMotionFormat = DXGI_FORMAT_R16G16_FLOAT;

    // Four GPU timestamps per frame: list start, uploads done, evaluation done, readback done.
    constexpr uint32_t kTimestampCount = 4;

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

    // Normally the direct queue has already waited for every submitted video operation before
    // it reaches its own fence. Keep an independent drain here too so an error between video
    // submission and that wait cannot tear resources out from beneath the video engine.
    if (m_videoQueue && m_videoFence && m_videoFenceEvent) {
      const uint64_t value = ++m_videoFenceValue;
      if (SUCCEEDED(m_videoQueue->Signal(m_videoFence.Get(), value)) &&
          m_videoFence->GetCompletedValue() < value &&
          SUCCEEDED(m_videoFence->SetEventOnCompletion(value, m_videoFenceEvent))) {
        WaitForSingleObject(m_videoFenceEvent, 5000);
      }
    }
    if (m_videoFenceEvent) {
      CloseHandle(m_videoFenceEvent);
      m_videoFenceEvent = nullptr;
    }
  }

  bool D3D12Context::initialize(uint32_t width,
                                uint32_t height,
                                bool needDepth,
                                bool needMotion,
                                bool wantAutoMotion,
                                bool wantPipeline,
                                std::string& error) {
    m_width = width;
    m_height = height;
    m_needDepth = needDepth;
    m_needMotion = needMotion;
    m_wantAutoMotion = wantAutoMotion;
    m_slotCount = wantPipeline ? kSlots : 1u;

    return createDevice(error) && createQueueAndList(error) && createResources(error) &&
           createAutoMotionResources(error);
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

  bool D3D12Context::createUploadResource(const D3D12_RESOURCE_DESC& textureDesc,
                                           ComPtr<ID3D12Resource>& uploadBuffer,
                                           D3D12_PLACED_SUBRESOURCE_FOOTPRINT& footprint,
                                           uint32_t& rowPitch,
                                           uint64_t& bytes,
                                           const char* label,
                                           std::string& error) {
    UINT numRows = 0;
    UINT64 rowSizeBytes = 0;
    m_device->GetCopyableFootprints(&textureDesc, 0, 1, 0, &footprint, &numRows, &rowSizeBytes,
                                    &bytes);
    rowPitch = footprint.Footprint.RowPitch;
    if (numRows != m_height || rowPitch < rowSizeBytes) {
      error = std::string("GetCopyableFootprints returned an invalid ") + label + " footprint";
      return false;
    }

    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Width = bytes;
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    const D3D12_HEAP_PROPERTIES uploadHeap = heapProps(D3D12_HEAP_TYPE_UPLOAD);
    const HRESULT hr = m_device->CreateCommittedResource(
      &uploadHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
      IID_PPV_ARGS(&uploadBuffer));
    if (FAILED(hr)) {
      error = hrToString((std::string("CreateCommittedResource (") + label + " upload)").c_str(), hr);
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

    for (uint32_t slot = 0; slot < m_slotCount; ++slot) {
      if (!createUploadResource(texDesc, m_uploadBuffers[slot], m_footprint, m_rowPitch,
                                m_stagingBytes, "colour", error)) {
        return false;
      }
    }

    // Inputs are sampled by NGX only. Keep depth at full precision and store motion as half
    // floats: values are signed pixels and half has ample dynamic range while halving traffic.
    D3D12_RESOURCE_DESC inputDesc = texDesc;
    inputDesc.Flags = D3D12_RESOURCE_FLAG_NONE;

    if (m_needDepth) {
      inputDesc.Format = kDepthFormat;
      hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &inputDesc,
                                             D3D12_RESOURCE_STATE_COMMON, nullptr,
                                             IID_PPV_ARGS(&m_depthTexture));
      if (FAILED(hr)) {
        error = hrToString("CreateCommittedResource (depth)", hr);
        return false;
      }
      if (!createUploadResource(inputDesc, m_depthUploadBuffer, m_depthFootprint,
                                m_depthRowPitch, m_depthUploadBytes, "depth", error)) {
        return false;
      }
    }

    if (m_needMotion) {
      D3D12_RESOURCE_DESC motionDesc = inputDesc;
      motionDesc.Format = kMotionFormat;
      // Automatic motion is expanded into this texture by a tiny compute pass. External motion
      // keeps the same resource layout but never uses its UAV capability.
      motionDesc.Flags = m_wantAutoMotion ? D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS
                                          : D3D12_RESOURCE_FLAG_NONE;
      hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &motionDesc,
                                             D3D12_RESOURCE_STATE_COMMON, nullptr,
                                             IID_PPV_ARGS(&m_motionTexture));
      if (FAILED(hr)) {
        error = hrToString("CreateCommittedResource (motion)", hr);
        return false;
      }
      if (!createUploadResource(motionDesc, m_motionUploadBuffer, m_motionFootprint,
                                m_motionRowPitch, m_motionUploadBytes, "motion", error)) {
        return false;
      }
    }

    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Width = m_stagingBytes;
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    const D3D12_HEAP_PROPERTIES readbackHeap = heapProps(D3D12_HEAP_TYPE_READBACK);
    for (uint32_t slot = 0; slot < m_slotCount; ++slot) {
      hr = m_device->CreateCommittedResource(&readbackHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                                             D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                             IID_PPV_ARGS(&m_readbackBuffers[slot]));
      if (FAILED(hr)) {
        error = hrToString("CreateCommittedResource (readback)", hr);
        return false;
      }
    }

    return true;
  }

  bool D3D12Context::createAutoMotionResources(std::string& error) {
    if (!m_wantAutoMotion) {
      return true;
    }

    // Motion estimation accepts NV12 only. NV12 is 4:2:0, so odd dimensions have no exact
    // representation. Do not silently pad and then hand vectors from the padded image to NGX.
    if ((m_width & 1u) != 0 || (m_height & 1u) != 0) {
      logInfo("Automatic motion disabled: D3D12 Video requires even NV12 dimensions");
      return true;
    }

    // A half-resolution luma search cuts the video-engine work and NV12 traffic to one quarter.
    // The compute pass expands its 16x16 cells as 32x32 source cells and doubles displacement
    // back into full-resolution pixels. Keep 1:1 for dimensions that cannot make an even NV12
    // half-resolution texture.
    m_autoMotionScale = ((m_width & 3u) == 0 && (m_height & 3u) == 0) ? 2u : 1u;
    m_autoInputWidth = m_width / m_autoMotionScale;
    m_autoInputHeight = m_height / m_autoMotionScale;

    HRESULT hr = m_device.As(&m_videoDevice);
    if (FAILED(hr)) {
      logInfo("Automatic motion disabled: ID3D12VideoDevice1 is unavailable");
      return true;
    }

    D3D12_FEATURE_DATA_VIDEO_MOTION_ESTIMATOR support = {};
    support.NodeIndex = 0;
    support.InputFormat = DXGI_FORMAT_NV12;
    hr = m_videoDevice->CheckFeatureSupport(D3D12_FEATURE_VIDEO_MOTION_ESTIMATOR, &support,
                                            sizeof(support));
    const auto requiredBlock = D3D12_VIDEO_MOTION_ESTIMATOR_SEARCH_BLOCK_SIZE_FLAG_16X16;
    const auto requiredPrecision = D3D12_VIDEO_MOTION_ESTIMATOR_VECTOR_PRECISION_FLAG_QUARTER_PEL;
    if (FAILED(hr) || (support.BlockSizeFlags & requiredBlock) == 0 ||
        (support.PrecisionFlags & requiredPrecision) == 0) {
      logInfo("Automatic motion disabled: this driver does not expose a compatible D3D12 Video "
              "motion estimator");
      m_videoDevice.Reset();
      return true;
    }

    const auto sizeSupported = [&support](uint32_t width, uint32_t height) {
      return width >= support.SizeRange.MinWidth && width <= support.SizeRange.MaxWidth &&
             height >= support.SizeRange.MinHeight && height <= support.SizeRange.MaxHeight;
    };
    if (!sizeSupported(m_autoInputWidth, m_autoInputHeight)) {
      // Some drivers support the source dimensions but impose a larger minimum size than the
      // half-resolution image. Retain automatic motion at 1:1 in that case instead of needlessly
      // degrading to colour-only.
      if (m_autoMotionScale == 2 && sizeSupported(m_width, m_height)) {
        m_autoMotionScale = 1;
        m_autoInputWidth = m_width;
        m_autoInputHeight = m_height;
        logInfo("Automatic motion: half-resolution input is unsupported; using 1:1 estimation");
      } else {
        logInfo("Automatic motion disabled: this driver does not support the clip size");
        m_videoDevice.Reset();
        return true;
      }
    }

    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE;
    queueDesc.NodeMask = 1;
    hr = m_device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&m_videoQueue));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandQueue (video encode)", hr);
      return false;
    }
    hr = m_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE,
                                          IID_PPV_ARGS(&m_videoAllocator));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandAllocator (video encode)", hr);
      return false;
    }
    hr = m_device->CreateCommandList(1, D3D12_COMMAND_LIST_TYPE_VIDEO_ENCODE,
                                     m_videoAllocator.Get(), nullptr,
                                     IID_PPV_ARGS(&m_videoCommandList));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandList (video encode)", hr);
      return false;
    }
    m_videoCommandList->Close();
    hr = m_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_videoFence));
    if (FAILED(hr)) {
      error = hrToString("CreateFence (video encode)", hr);
      return false;
    }
    m_videoFenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!m_videoFenceEvent) {
      error = "CreateEventW (video encode) failed";
      return false;
    }

    // The NV12 upload has its own direct allocator, keeping the normal direct allocator free
    // for the eventual compute expansion and NGX evaluation.
    hr = m_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                          IID_PPV_ARGS(&m_autoAllocator));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandAllocator (automatic motion upload)", hr);
      return false;
    }
    hr = m_device->CreateCommandList(1, D3D12_COMMAND_LIST_TYPE_DIRECT, m_autoAllocator.Get(),
                                     nullptr, IID_PPV_ARGS(&m_autoCommandList));
    if (FAILED(hr)) {
      error = hrToString("CreateCommandList (automatic motion upload)", hr);
      return false;
    }
    m_autoCommandList->Close();

    D3D12_VIDEO_SIZE_RANGE sizeRange = {};
    sizeRange.MaxWidth = m_autoInputWidth;
    sizeRange.MaxHeight = m_autoInputHeight;
    sizeRange.MinWidth = m_autoInputWidth;
    sizeRange.MinHeight = m_autoInputHeight;
    D3D12_VIDEO_MOTION_ESTIMATOR_DESC estimatorDesc = {};
    estimatorDesc.NodeMask = 1;
    estimatorDesc.InputFormat = DXGI_FORMAT_NV12;
    estimatorDesc.BlockSize = D3D12_VIDEO_MOTION_ESTIMATOR_SEARCH_BLOCK_SIZE_16X16;
    estimatorDesc.Precision = D3D12_VIDEO_MOTION_ESTIMATOR_VECTOR_PRECISION_QUARTER_PEL;
    estimatorDesc.SizeRange = sizeRange;
    hr = m_videoDevice->CreateVideoMotionEstimator(&estimatorDesc, nullptr,
                                                    IID_PPV_ARGS(&m_motionEstimator));
    if (FAILED(hr)) {
      error = hrToString("CreateVideoMotionEstimator", hr);
      return false;
    }

    D3D12_VIDEO_MOTION_VECTOR_HEAP_DESC heapDesc = {};
    heapDesc.NodeMask = 1;
    heapDesc.InputFormat = DXGI_FORMAT_NV12;
    heapDesc.BlockSize = estimatorDesc.BlockSize;
    heapDesc.Precision = estimatorDesc.Precision;
    heapDesc.SizeRange = sizeRange;
    hr = m_videoDevice->CreateVideoMotionVectorHeap(&heapDesc, nullptr,
                                                     IID_PPV_ARGS(&m_motionVectorHeap));
    if (FAILED(hr)) {
      error = hrToString("CreateVideoMotionVectorHeap", hr);
      return false;
    }

    const D3D12_HEAP_PROPERTIES defaultHeap = heapProps(D3D12_HEAP_TYPE_DEFAULT);
    D3D12_RESOURCE_DESC inputDesc = {};
    inputDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    inputDesc.Width = m_autoInputWidth;
    inputDesc.Height = m_autoInputHeight;
    inputDesc.DepthOrArraySize = 1;
    inputDesc.MipLevels = 1;
    inputDesc.Format = DXGI_FORMAT_NV12;
    inputDesc.SampleDesc.Count = 1;
    inputDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    inputDesc.Flags = D3D12_RESOURCE_FLAG_NONE;
    for (auto& texture : m_autoInputTextures) {
      hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &inputDesc,
                                             D3D12_RESOURCE_STATE_COMMON, nullptr,
                                             IID_PPV_ARGS(&texture));
      if (FAILED(hr)) {
        error = hrToString("CreateCommittedResource (automatic motion NV12)", hr);
        return false;
      }
    }

    // An NV12 D3D12 resource has two plane subresources. Get their independent footprints so
    // the upload preserves the exact row alignment the driver selected for both Y and UV.
    UINT rows[2] = {};
    UINT64 rowSizes[2] = {};
    m_device->GetCopyableFootprints(&inputDesc, 0, 2, 0, m_autoInputFootprints.data(), rows,
                                    rowSizes, &m_autoInputUploadBytes);
    if (rows[0] != m_autoInputHeight || rows[1] != m_autoInputHeight / 2 ||
        m_autoInputFootprints[0].Footprint.RowPitch < rowSizes[0] ||
        m_autoInputFootprints[1].Footprint.RowPitch < rowSizes[1]) {
      error = "GetCopyableFootprints returned an invalid NV12 motion footprint";
      return false;
    }

    D3D12_RESOURCE_DESC uploadDesc = {};
    uploadDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    uploadDesc.Width = m_autoInputUploadBytes;
    uploadDesc.Height = 1;
    uploadDesc.DepthOrArraySize = 1;
    uploadDesc.MipLevels = 1;
    uploadDesc.Format = DXGI_FORMAT_UNKNOWN;
    uploadDesc.SampleDesc.Count = 1;
    uploadDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    const D3D12_HEAP_PROPERTIES uploadHeap = heapProps(D3D12_HEAP_TYPE_UPLOAD);
    hr = m_device->CreateCommittedResource(&uploadHeap, D3D12_HEAP_FLAG_NONE, &uploadDesc,
                                           D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
                                           IID_PPV_ARGS(&m_autoInputUploadBuffer));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (automatic motion upload)", hr);
      return false;
    }

    const uint32_t vectorWidth = (m_autoInputWidth + 15) / 16;
    const uint32_t vectorHeight = (m_autoInputHeight + 15) / 16;
    D3D12_RESOURCE_DESC vectorDesc = {};
    vectorDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    vectorDesc.Width = vectorWidth;
    vectorDesc.Height = vectorHeight;
    vectorDesc.DepthOrArraySize = 1;
    vectorDesc.MipLevels = 1;
    vectorDesc.Format = DXGI_FORMAT_R16G16_SINT;
    vectorDesc.SampleDesc.Count = 1;
    vectorDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    vectorDesc.Flags = D3D12_RESOURCE_FLAG_NONE;
    hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE, &vectorDesc,
                                           D3D12_RESOURCE_STATE_COMMON, nullptr,
                                           IID_PPV_ARGS(&m_autoVectorTexture));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (automatic motion vectors)", hr);
      return false;
    }

    if (!createAutoMotionExpandPipeline(error)) {
      logInfo("Automatic motion disabled: " + error);
      error.clear();
      return true;
    }

    m_autoMotionAvailable = true;
    logInfo("Automatic motion enabled: D3D12 Video fixed-function estimator (NV12, 16x16, "
            "quarter-pixel)");
    return true;
  }

  bool D3D12Context::createAutoMotionExpandPipeline(std::string& error) {
    // The resolved video-engine grid is R16G16_SINT in quarter-pixel units. This shader keeps
    // it on the GPU and writes the full-resolution RG16F texture that DLSS-NR consumes.
    static constexpr char kExpandShader[] = R"(
Texture2D<int2> sourceVectors : register(t0);
RWTexture2D<float2> outputMotion : register(u0);

[numthreads(16, 16, 1)]
void main(uint3 dispatchId : SV_DispatchThreadID) {
  uint width, height;
  outputMotion.GetDimensions(width, height);
  if (dispatchId.x >= width || dispatchId.y >= height) {
    return;
  }
  const int2 vectorQuarterPixels =
    sourceVectors.Load(int3(dispatchId.xy / (16 * AUTO_MOTION_SCALE), 0));
  outputMotion[dispatchId.xy] = float2(vectorQuarterPixels) * (0.25 * AUTO_MOTION_SCALE);
}
)";

    D3D12_FEATURE_DATA_FORMAT_SUPPORT formatSupport = {};
    formatSupport.Format = kMotionFormat;
    HRESULT hr = m_device->CheckFeatureSupport(D3D12_FEATURE_FORMAT_SUPPORT, &formatSupport,
                                               sizeof(formatSupport));
    if (FAILED(hr) ||
        (formatSupport.Support1 & D3D12_FORMAT_SUPPORT1_TYPED_UNORDERED_ACCESS_VIEW) == 0 ||
        (formatSupport.Support2 & D3D12_FORMAT_SUPPORT2_UAV_TYPED_STORE) == 0) {
      error = "R16G16_FLOAT typed UAV stores are unavailable for automatic motion";
      return false;
    }

    ComPtr<ID3DBlob> shader;
    ComPtr<ID3DBlob> shaderErrors;
    const char* scaleString = m_autoMotionScale == 2 ? "2" : "1";
    const D3D_SHADER_MACRO shaderMacros[] = { { "AUTO_MOTION_SCALE", scaleString },
                                               { nullptr, nullptr } };
    hr = D3DCompile(kExpandShader, sizeof(kExpandShader) - 1, "vsdlssnr_auto_motion.hlsl",
                    shaderMacros, nullptr, "main", "cs_5_0", D3DCOMPILE_ENABLE_STRICTNESS,
                    0, &shader, &shaderErrors);
    if (FAILED(hr)) {
      const char* text = shaderErrors ? static_cast<const char*>(shaderErrors->GetBufferPointer())
                                      : "no compiler diagnostic";
      error = "Failed to compile the automatic-motion expansion shader: " + std::string(text);
      return false;
    }

    D3D12_DESCRIPTOR_RANGE ranges[2] = {};
    ranges[0].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    ranges[0].NumDescriptors = 1;
    ranges[0].BaseShaderRegister = 0;
    ranges[0].RegisterSpace = 0;
    ranges[0].OffsetInDescriptorsFromTableStart = 0;
    ranges[1].RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_UAV;
    ranges[1].NumDescriptors = 1;
    ranges[1].BaseShaderRegister = 0;
    ranges[1].RegisterSpace = 0;
    ranges[1].OffsetInDescriptorsFromTableStart = 0;

    D3D12_ROOT_PARAMETER rootParameters[2] = {};
    for (UINT i = 0; i < 2; ++i) {
      rootParameters[i].ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
      rootParameters[i].DescriptorTable.NumDescriptorRanges = 1;
      rootParameters[i].DescriptorTable.pDescriptorRanges = &ranges[i];
      rootParameters[i].ShaderVisibility = D3D12_SHADER_VISIBILITY_ALL;
    }
    D3D12_ROOT_SIGNATURE_DESC rootDesc = {};
    rootDesc.NumParameters = 2;
    rootDesc.pParameters = rootParameters;
    rootDesc.Flags = D3D12_ROOT_SIGNATURE_FLAG_NONE;
    ComPtr<ID3DBlob> serializedRoot;
    ComPtr<ID3DBlob> rootErrors;
    hr = D3D12SerializeRootSignature(&rootDesc, D3D_ROOT_SIGNATURE_VERSION_1, &serializedRoot,
                                     &rootErrors);
    if (FAILED(hr)) {
      const char* text = rootErrors ? static_cast<const char*>(rootErrors->GetBufferPointer())
                                    : "no serializer diagnostic";
      error = "Failed to serialize the automatic-motion root signature: " + std::string(text);
      return false;
    }
    hr = m_device->CreateRootSignature(0, serializedRoot->GetBufferPointer(),
                                       serializedRoot->GetBufferSize(),
                                       IID_PPV_ARGS(&m_autoMotionRootSignature));
    if (FAILED(hr)) {
      error = hrToString("CreateRootSignature (automatic motion)", hr);
      return false;
    }

    D3D12_COMPUTE_PIPELINE_STATE_DESC pipelineDesc = {};
    pipelineDesc.pRootSignature = m_autoMotionRootSignature.Get();
    pipelineDesc.CS.pShaderBytecode = shader->GetBufferPointer();
    pipelineDesc.CS.BytecodeLength = shader->GetBufferSize();
    hr = m_device->CreateComputePipelineState(&pipelineDesc,
                                              IID_PPV_ARGS(&m_autoMotionPipelineState));
    if (FAILED(hr)) {
      error = hrToString("CreateComputePipelineState (automatic motion)", hr);
      return false;
    }

    D3D12_DESCRIPTOR_HEAP_DESC heapDesc = {};
    heapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heapDesc.NumDescriptors = 2;
    heapDesc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    hr = m_device->CreateDescriptorHeap(&heapDesc, IID_PPV_ARGS(&m_autoMotionDescriptorHeap));
    if (FAILED(hr)) {
      error = hrToString("CreateDescriptorHeap (automatic motion)", hr);
      return false;
    }
    m_autoMotionDescriptorSize =
      m_device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = DXGI_FORMAT_R16G16_SINT;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    D3D12_CPU_DESCRIPTOR_HANDLE handle =
      m_autoMotionDescriptorHeap->GetCPUDescriptorHandleForHeapStart();
    m_device->CreateShaderResourceView(m_autoVectorTexture.Get(), &srvDesc, handle);

    D3D12_UNORDERED_ACCESS_VIEW_DESC uavDesc = {};
    uavDesc.Format = kMotionFormat;
    uavDesc.ViewDimension = D3D12_UAV_DIMENSION_TEXTURE2D;
    handle.ptr += m_autoMotionDescriptorSize;
    m_device->CreateUnorderedAccessView(m_motionTexture.Get(), nullptr, &uavDesc, handle);
    return true;
  }

  void D3D12Context::transition(ID3D12Resource* resource,
                                D3D12_RESOURCE_STATES& tracked,
                                D3D12_RESOURCE_STATES after) {
    transitionOn(m_commandList.Get(), resource, tracked, after);
  }

  void D3D12Context::transitionOn(ID3D12GraphicsCommandList* commandList,
                                  ID3D12Resource* resource,
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

    commandList->ResourceBarrier(1, &barrier);
    tracked = after;
  }

  void D3D12Context::setProfiling(bool enabled) {
    if (!enabled) {
      m_profiling = false;
      return;
    }
    if (m_profiling) {
      return;
    }
    if (m_timestampHeap) {
      m_profiling = true;
      return;
    }

    D3D12_QUERY_HEAP_DESC heapDesc = {};
    heapDesc.Type = D3D12_QUERY_HEAP_TYPE_TIMESTAMP;
    heapDesc.Count = kTimestampCount;
    heapDesc.NodeMask = 1;
    HRESULT hr = m_device->CreateQueryHeap(&heapDesc, IID_PPV_ARGS(&m_timestampHeap));
    if (FAILED(hr)) {
      logWarn(hrToString("CreateQueryHeap (timestamps)", hr) + "; GPU timing is unavailable");
      return;
    }

    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Width = kTimestampCount * sizeof(uint64_t);
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    const D3D12_HEAP_PROPERTIES readbackHeap = heapProps(D3D12_HEAP_TYPE_READBACK);
    hr = m_device->CreateCommittedResource(&readbackHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                                           D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
                                           IID_PPV_ARGS(&m_timestampReadback));
    if (FAILED(hr)) {
      m_timestampHeap.Reset();
      logWarn(hrToString("CreateCommittedResource (timestamp readback)", hr) +
              "; GPU timing is unavailable");
      return;
    }

    hr = m_queue->GetTimestampFrequency(&m_timestampFrequency);
    if (FAILED(hr) || m_timestampFrequency == 0) {
      m_timestampHeap.Reset();
      m_timestampReadback.Reset();
      logWarn("GetTimestampFrequency failed; GPU timing is unavailable");
      return;
    }

    m_profiling = true;
  }

  void D3D12Context::markTimestamp(uint32_t index) {
    if (!m_profiling || !m_timestampHeap || !m_listOpen || index >= kTimestampCount) {
      return;
    }
    m_commandList->EndQuery(m_timestampHeap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, index);
    if (index + 1 > m_marks) {
      m_marks = index + 1;
    }
  }

  void D3D12Context::resolveTimestamps() {
    if (!m_profiling || !m_timestampHeap || m_marks != kTimestampCount) {
      return;
    }
    m_commandList->ResolveQueryData(m_timestampHeap.Get(), D3D12_QUERY_TYPE_TIMESTAMP, 0,
                                    kTimestampCount, m_timestampReadback.Get(), 0);
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
      m_depthState = m_committedDepthState;
      m_motionState = m_committedMotionState;
      m_autoInputStates = m_committedAutoInputStates;
      m_autoVectorState = m_committedAutoVectorState;
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
    m_marks = 0;
    m_gpuTimings = GpuTimings();
    markTimestamp(0);
    return true;
  }

  bool D3D12Context::beginAutoMotion(std::string& error) {
    if (!m_autoMotionAvailable) {
      return true;
    }
    if (m_autoListOpen) {
      m_autoCommandList->Close();
      m_autoListOpen = false;
      m_autoInputStates = m_committedAutoInputStates;
      m_autoVectorState = m_committedAutoVectorState;
    }

    HRESULT hr = m_autoAllocator->Reset();
    if (FAILED(hr)) {
      error = hrToString("Automatic motion CommandAllocator::Reset", hr);
      return false;
    }
    hr = m_autoCommandList->Reset(m_autoAllocator.Get(), nullptr);
    if (FAILED(hr)) {
      error = hrToString("Automatic motion CommandList::Reset", hr);
      return false;
    }
    m_autoListOpen = true;
    return true;
  }

  void D3D12Context::copyUploadToTexture(ID3D12Resource* upload,
                                          const D3D12_PLACED_SUBRESOURCE_FOOTPRINT& footprint,
                                          ID3D12Resource* texture,
                                          D3D12_RESOURCE_STATES& textureState) {
    transition(texture, textureState, D3D12_RESOURCE_STATE_COPY_DEST);
    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = texture;
    dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dst.SubresourceIndex = 0;

    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = upload;
    src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    src.PlacedFootprint = footprint;

    m_commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    transition(texture, textureState, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
  }

  void D3D12Context::recordPreEvaluate(bool uploadMotion, uint32_t slot) {
    // Two evaluations can now be in the queue at once, and NGX keeps its temporal history in
    // resources this code never names. Submissions execute in order, but D3D12 lets the driver
    // overlap work across command lists unless a barrier says otherwise; a global UAV barrier
    // at the head of every frame makes the previous evaluation's writes visible to this one.
    D3D12_RESOURCE_BARRIER flushUav = {};
    flushUav.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    flushUav.UAV.pResource = nullptr;
    m_commandList->ResourceBarrier(1, &flushUav);

    copyUploadToTexture(m_uploadBuffers[slot].Get(), m_footprint, m_colorTexture.Get(),
                        m_colorState);
    if (m_needDepth) {
      copyUploadToTexture(m_depthUploadBuffer.Get(), m_depthFootprint, m_depthTexture.Get(),
                          m_depthState);
    }
    if (m_needMotion && uploadMotion) {
      copyUploadToTexture(m_motionUploadBuffer.Get(), m_motionFootprint, m_motionTexture.Get(),
                          m_motionState);
    }

    // The Remix integration binds colour read-only and output as a UAV; mirror that split.
    transition(m_outputTexture.Get(), m_outputState, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);
    markTimestamp(1);
  }

  void D3D12Context::recordPostEvaluate(uint32_t slot) {
    markTimestamp(2);
    transition(m_outputTexture.Get(), m_outputState, D3D12_RESOURCE_STATE_COPY_SOURCE);

    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = m_readbackBuffers[slot].Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    dst.PlacedFootprint = m_footprint;

    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = m_outputTexture.Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    src.SubresourceIndex = 0;

    m_commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    markTimestamp(3);
  }

  void D3D12Context::recordAutoMotionInput(bool estimateThisFrame) {
    if (!m_autoMotionAvailable) {
      return;
    }

    ID3D12Resource* input = m_autoInputTextures[m_autoInputSlot].Get();
    D3D12_RESOURCE_STATES& inputState = m_autoInputStates[m_autoInputSlot];
    transitionOn(m_autoCommandList.Get(), input, inputState, D3D12_RESOURCE_STATE_COPY_DEST);
    for (UINT plane = 0; plane < 2; ++plane) {
      D3D12_TEXTURE_COPY_LOCATION dst = {};
      dst.pResource = input;
      dst.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
      dst.SubresourceIndex = plane;

      D3D12_TEXTURE_COPY_LOCATION src = {};
      src.pResource = m_autoInputUploadBuffer.Get();
      src.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
      src.PlacedFootprint = m_autoInputFootprints[plane];
      m_autoCommandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
    }
    // D3D12 Video owns the VIDEO_ENCODE_* transitions; recording those on a direct command
    // list makes the list invalid on NVIDIA's runtime. Finish the upload in COMMON, which is
    // the agreed hand-off state between the two queues.
    transitionOn(m_autoCommandList.Get(), input, inputState, D3D12_RESOURCE_STATE_COMMON);
    if (estimateThisFrame) {
      // The preceding GPU expansion returns this grid to COMMON. Normalize the tracked state
      // before the video list transitions it to VIDEO_ENCODE_WRITE for its next resolve.
      transitionOn(m_autoCommandList.Get(), m_autoVectorTexture.Get(), m_autoVectorState,
                   D3D12_RESOURCE_STATE_COMMON);
    }
  }

  void D3D12Context::recordAutoMotionExpand() {
    if (!m_autoMotionAvailable) {
      return;
    }

    transition(m_autoVectorTexture.Get(), m_autoVectorState,
               D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    transition(m_motionTexture.Get(), m_motionState, D3D12_RESOURCE_STATE_UNORDERED_ACCESS);

    ID3D12DescriptorHeap* heaps[] = { m_autoMotionDescriptorHeap.Get() };
    m_commandList->SetDescriptorHeaps(1, heaps);
    m_commandList->SetComputeRootSignature(m_autoMotionRootSignature.Get());
    m_commandList->SetPipelineState(m_autoMotionPipelineState.Get());
    D3D12_GPU_DESCRIPTOR_HANDLE sourceHandle =
      m_autoMotionDescriptorHeap->GetGPUDescriptorHandleForHeapStart();
    D3D12_GPU_DESCRIPTOR_HANDLE outputHandle = sourceHandle;
    outputHandle.ptr += m_autoMotionDescriptorSize;
    m_commandList->SetComputeRootDescriptorTable(0, sourceHandle);
    m_commandList->SetComputeRootDescriptorTable(1, outputHandle);
    m_commandList->Dispatch((m_width + 15) / 16, (m_height + 15) / 16, 1);

    D3D12_RESOURCE_BARRIER uavBarrier = {};
    uavBarrier.Type = D3D12_RESOURCE_BARRIER_TYPE_UAV;
    uavBarrier.UAV.pResource = m_motionTexture.Get();
    m_commandList->ResourceBarrier(1, &uavBarrier);
    transition(m_motionTexture.Get(), m_motionState, D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);
    transition(m_autoVectorTexture.Get(), m_autoVectorState, D3D12_RESOURCE_STATE_COMMON);
  }

  bool D3D12Context::endAutoMotionInputAndGenerate(bool hasPrevious, std::string& error) {
    if (!m_autoMotionAvailable) {
      return true;
    }

    HRESULT hr = m_autoCommandList->Close();
    m_autoListOpen = false;
    if (FAILED(hr)) {
      m_autoInputStates = m_committedAutoInputStates;
      m_autoVectorState = m_committedAutoVectorState;
      error = hrToString("Automatic motion CommandList::Close", hr);
      return false;
    }
    ID3D12CommandList* uploadLists[] = { m_autoCommandList.Get() };
    m_queue->ExecuteCommandLists(1, uploadLists);
    m_committedAutoInputStates = m_autoInputStates;
    m_committedAutoVectorState = m_autoVectorState;

    // The NV12 copy is small, but it must be visibly complete before the video engine consumes
    // it. Waiting here avoids the driver deadlock seen when a motion-estimation heap is recycled
    // through only cross-engine waits; the dense vector expansion remains entirely on the GPU.
    if (!waitForQueue(m_queue.Get(), m_fence.Get(), m_fenceEvent, m_fenceValue,
                      "automatic motion NV12 upload", error)) {
      return false;
    }
    const uint64_t uploadValue = m_fenceValue;

    if (!hasPrevious) {
      // Seed the ping-pong history after a seek or at frame zero. No motion resource is bound
      // for this frame, which matches the DLSS-NR Reset we send for the same discontinuity.
      m_autoInputSlot ^= 1u;
      return true;
    }

    hr = m_videoQueue->Wait(m_fence.Get(), uploadValue);
    if (FAILED(hr)) {
      error = hrToString("Video motion queue Wait for NV12 upload", hr);
      return false;
    }

    hr = m_videoAllocator->Reset();
    if (FAILED(hr)) {
      error = hrToString("Video motion CommandAllocator::Reset", hr);
      return false;
    }
    hr = m_videoCommandList->Reset(m_videoAllocator.Get());
    if (FAILED(hr)) {
      error = hrToString("Video motion CommandList::Reset", hr);
      return false;
    }

    // These states belong to the video-encode command list. Keep the resources in COMMON at
    // the queue boundary so the direct queue can upload/read them without a cross-queue state
    // mismatch. D3D12 permits the required COMMON promotions on either queue.
    D3D12_RESOURCE_BARRIER toVideo[3] = {};
    const auto setTransition = [](D3D12_RESOURCE_BARRIER& barrier, ID3D12Resource* resource,
                                  D3D12_RESOURCE_STATES before, D3D12_RESOURCE_STATES after) {
      barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      barrier.Transition.pResource = resource;
      barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      barrier.Transition.StateBefore = before;
      barrier.Transition.StateAfter = after;
    };
    setTransition(toVideo[0], m_autoInputTextures[m_autoInputSlot].Get(),
                  D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ);
    setTransition(toVideo[1], m_autoInputTextures[m_autoInputSlot ^ 1u].Get(),
                  D3D12_RESOURCE_STATE_COMMON, D3D12_RESOURCE_STATE_VIDEO_ENCODE_READ);
    setTransition(toVideo[2], m_autoVectorTexture.Get(), D3D12_RESOURCE_STATE_COMMON,
                  D3D12_RESOURCE_STATE_VIDEO_ENCODE_WRITE);
    m_videoCommandList->ResourceBarrier(3, toVideo);

    D3D12_VIDEO_MOTION_ESTIMATOR_OUTPUT estimateOutput = {};
    estimateOutput.pMotionVectorHeap = m_motionVectorHeap.Get();
    D3D12_VIDEO_MOTION_ESTIMATOR_INPUT estimateInput = {};
    // D3D12 Video calls these input and reference. Passing the just-uploaded frame as input
    // and its predecessor as reference yields current -> previous displacement, which is the
    // direction DLSS temporal reprojection consumes.
    estimateInput.pInputTexture2D = m_autoInputTextures[m_autoInputSlot].Get();
    estimateInput.InputSubresourceIndex = 0;
    estimateInput.pReferenceTexture2D = m_autoInputTextures[m_autoInputSlot ^ 1u].Get();
    estimateInput.ReferenceSubresourceIndex = 0;
    estimateInput.pHintMotionVectorHeap = nullptr;
    m_videoCommandList->EstimateMotion(m_motionEstimator.Get(), &estimateOutput, &estimateInput);

    D3D12_RESOLVE_VIDEO_MOTION_VECTOR_HEAP_OUTPUT resolveOutput = {};
    resolveOutput.pMotionVectorTexture2D = m_autoVectorTexture.Get();
    resolveOutput.MotionVectorCoordinate = {};
    D3D12_RESOLVE_VIDEO_MOTION_VECTOR_HEAP_INPUT resolveInput = {};
    resolveInput.pMotionVectorHeap = m_motionVectorHeap.Get();
    resolveInput.PixelWidth = m_autoInputWidth;
    resolveInput.PixelHeight = m_autoInputHeight;
    m_videoCommandList->ResolveMotionVectorHeap(&resolveOutput, &resolveInput);

    D3D12_RESOURCE_BARRIER fromVideo[3] = {};
    for (UINT i = 0; i < 3; ++i) {
      fromVideo[i] = toVideo[i];
      std::swap(fromVideo[i].Transition.StateBefore, fromVideo[i].Transition.StateAfter);
    }
    m_videoCommandList->ResourceBarrier(3, fromVideo);

    hr = m_videoCommandList->Close();
    if (FAILED(hr)) {
      error = hrToString("Video motion CommandList::Close", hr);
      return false;
    }
    ID3D12CommandList* videoLists[] = { m_videoCommandList.Get() };
    m_videoQueue->ExecuteCommandLists(1, videoLists);
    // NVIDIA's video engine does not reliably recycle an estimation heap through a queued
    // cross-engine wait. Complete this tiny fixed-function pass before the next frame reuses
    // the heap. The expensive part - expanding the dense field - is still GPU-only and records
    // with the normal NGX command list below.
    if (!waitForQueue(m_videoQueue.Get(), m_videoFence.Get(), m_videoFenceEvent,
                      m_videoFenceValue, "video motion estimation", error)) {
      return false;
    }
    // The fence is already complete at this point, so this does not stall the direct queue. It
    // does establish the explicit cross-queue dependency D3D12 Video needs before the direct
    // queue samples the resolved grid and the next frame recycles the motion-vector heap.
    hr = m_queue->Wait(m_videoFence.Get(), m_videoFenceValue);
    if (FAILED(hr)) {
      error = hrToString("Direct queue Wait for completed video motion", hr);
      return false;
    }

    m_autoInputSlot ^= 1u;
    return true;
  }

  bool D3D12Context::endAndWait(std::string& error) {
    return submit(error) && wait(error);
  }

  bool D3D12Context::submit(std::string& error) {
    resolveTimestamps();

    HRESULT hr = m_commandList->Close();
    m_listOpen = false;

    if (FAILED(hr)) {
      // Nothing was submitted, so the recorded transitions never happened.
      m_colorState = m_committedColorState;
      m_outputState = m_committedOutputState;
      m_depthState = m_committedDepthState;
      m_motionState = m_committedMotionState;
      m_autoInputStates = m_committedAutoInputStates;
      m_autoVectorState = m_committedAutoVectorState;
      error = hrToString("CommandList::Close", hr);
      return false;
    }

    m_timingThisFrame = m_profiling && m_timestampHeap && m_marks == kTimestampCount;
    if (m_timingThisFrame) {
      QueryPerformanceFrequency(&m_qpcFrequency);
      QueryPerformanceCounter(&m_submitStart);
      if (FAILED(m_queue->GetClockCalibration(&m_calibratedGpu, &m_calibratedCpu))) {
        m_calibratedGpu = 0;
      }
    }

    ID3D12CommandList* lists[] = { m_commandList.Get() };
    m_queue->ExecuteCommandLists(1, lists);

    // Submitted: the recorded transitions are now what the GPU will have seen.
    m_committedColorState = m_colorState;
    m_committedOutputState = m_outputState;
    m_committedDepthState = m_depthState;
    m_committedMotionState = m_motionState;
    m_committedAutoInputStates = m_autoInputStates;
    m_committedAutoVectorState = m_autoVectorState;

    m_pendingFenceValue = ++m_fenceValue;
    hr = m_queue->Signal(m_fence.Get(), m_pendingFenceValue);
    if (FAILED(hr)) {
      error = hrToString("Neural Uplift evaluation queue Signal", hr);
      return false;
    }

    if (m_timingThisFrame) {
      QueryPerformanceCounter(&m_waitStart);
    }
    return true;
  }

  bool D3D12Context::wait(std::string& error) {
    if (m_fence->GetCompletedValue() < m_pendingFenceValue) {
      HRESULT hr = m_fence->SetEventOnCompletion(m_pendingFenceValue, m_fenceEvent);
      if (FAILED(hr)) {
        error = hrToString("Neural Uplift evaluation fence SetEventOnCompletion", hr);
        return false;
      }
      // A generous but finite wait. An indefinite one turns a driver-side hang into a frozen
      // encode with no diagnostic, which is materially worse to debug than a failed frame.
      if (WaitForSingleObject(m_fenceEvent, 30000) != WAIT_OBJECT_0) {
        error = "Timed out waiting for the GPU to finish the Neural Uplift evaluation";
        return false;
      }
    }

    if (!m_timingThisFrame) {
      return true;
    }
    m_timingThisFrame = false;

    LARGE_INTEGER waitEnd = {};
    QueryPerformanceCounter(&waitEnd);
    const double qpcToMs = m_qpcFrequency.QuadPart
                             ? 1000.0 / static_cast<double>(m_qpcFrequency.QuadPart)
                             : 0.0;
    m_gpuTimings.submitMs =
      static_cast<double>(m_waitStart.QuadPart - m_submitStart.QuadPart) * qpcToMs;
    m_gpuTimings.waitMs =
      static_cast<double>(waitEnd.QuadPart - m_waitStart.QuadPart) * qpcToMs;

    void* mapped = nullptr;
    const D3D12_RANGE readAll = { 0, kTimestampCount * sizeof(uint64_t) };
    if (SUCCEEDED(m_timestampReadback->Map(0, &readAll, &mapped)) && mapped != nullptr) {
      uint64_t ticks[kTimestampCount] = {};
      std::memcpy(ticks, mapped, sizeof(ticks));
      const D3D12_RANGE wroteNothing = { 0, 0 };
      m_timestampReadback->Unmap(0, &wroteNothing);

      const double toMs = 1000.0 / static_cast<double>(m_timestampFrequency);
      m_gpuTimings.uploadMs = static_cast<double>(ticks[1] - ticks[0]) * toMs;
      m_gpuTimings.evaluateMs = static_cast<double>(ticks[2] - ticks[1]) * toMs;
      m_gpuTimings.readbackMs = static_cast<double>(ticks[3] - ticks[2]) * toMs;
      m_gpuTimings.totalMs = static_cast<double>(ticks[3] - ticks[0]) * toMs;

      // How long the submission sat before the GPU reached the first timestamp. The
      // calibration pair was sampled just before ExecuteCommandLists, so converting the GPU
      // tick into QPC and differencing against that sample is a direct read of queue latency.
      if (m_calibratedGpu != 0 && qpcToMs != 0.0) {
        const double gpuStartQpc = static_cast<double>(m_calibratedCpu) +
          (static_cast<double>(ticks[0]) - static_cast<double>(m_calibratedGpu)) *
            (static_cast<double>(m_qpcFrequency.QuadPart) /
             static_cast<double>(m_timestampFrequency));
        m_gpuTimings.latencyMs =
          (gpuStartQpc - static_cast<double>(m_submitStart.QuadPart)) * qpcToMs;
      }
      m_gpuTimings.valid = true;
    }
    return true;
  }

  bool D3D12Context::drain(std::string& error) {
    return waitForQueue(m_queue.Get(), m_fence.Get(), m_fenceEvent, m_fenceValue,
                        "pipeline drain", error);
  }

  bool D3D12Context::waitForQueue(ID3D12CommandQueue* queue,
                                  ID3D12Fence* fence,
                                  HANDLE event,
                                  uint64_t& fenceValue,
                                  const char* label,
                                  std::string& error) {
    const uint64_t value = ++fenceValue;
    HRESULT hr = queue->Signal(fence, value);
    if (FAILED(hr)) {
      error = hrToString((std::string(label) + " queue Signal").c_str(), hr);
      return false;
    }

    if (fence->GetCompletedValue() >= value) {
      return true;
    }
    hr = fence->SetEventOnCompletion(value, event);
    if (FAILED(hr)) {
      error = hrToString((std::string(label) + " fence SetEventOnCompletion").c_str(), hr);
      return false;
    }
    // A generous but finite wait. An indefinite one turns a driver-side hang into a frozen
    // encode with no diagnostic, which is materially worse to debug than a failed frame.
    if (WaitForSingleObject(event, 30000) != WAIT_OBJECT_0) {
      error = std::string("Timed out waiting for the GPU to finish ") + label;
      return false;
    }
    return true;
  }

  uint8_t* D3D12Context::mapUploadResource(ID3D12Resource* upload,
                                            const char* label,
                                            std::string& error) {
    void* mapped = nullptr;
    // Null read range: the CPU will not read what it wrote, and saying so lets the driver skip
    // making the write-combined range coherent for reads.
    const D3D12_RANGE noRead = { 0, 0 };
    const HRESULT hr = upload->Map(0, &noRead, &mapped);
    if (FAILED(hr)) {
      error = hrToString((std::string(label) + " upload buffer Map").c_str(), hr);
      return nullptr;
    }
    return static_cast<uint8_t*>(mapped);
  }

  void D3D12Context::unmapUploadResource(ID3D12Resource* upload, uint64_t bytes) {
    // Null written range would mean "wrote nothing"; the whole buffer was written.
    const D3D12_RANGE written = { 0, static_cast<SIZE_T>(bytes) };
    upload->Unmap(0, &written);
  }

  uint8_t* D3D12Context::mapUpload(uint32_t slot, std::string& error) {
    return mapUploadResource(m_uploadBuffers[slot].Get(), "colour", error);
  }

  void D3D12Context::unmapUpload(uint32_t slot) {
    unmapUploadResource(m_uploadBuffers[slot].Get(), m_stagingBytes);
  }

  uint8_t* D3D12Context::mapDepthUpload(std::string& error) {
    return mapUploadResource(m_depthUploadBuffer.Get(), "depth", error);
  }

  void D3D12Context::unmapDepthUpload() {
    unmapUploadResource(m_depthUploadBuffer.Get(), m_depthUploadBytes);
  }

  uint8_t* D3D12Context::mapMotionUpload(std::string& error) {
    return mapUploadResource(m_motionUploadBuffer.Get(), "motion", error);
  }

  void D3D12Context::unmapMotionUpload() {
    unmapUploadResource(m_motionUploadBuffer.Get(), m_motionUploadBytes);
  }

  uint8_t* D3D12Context::mapAutoMotionUpload(std::string& error) {
    return mapUploadResource(m_autoInputUploadBuffer.Get(), "automatic motion", error);
  }

  void D3D12Context::unmapAutoMotionUpload() {
    unmapUploadResource(m_autoInputUploadBuffer.Get(), m_autoInputUploadBytes);
  }

  bool D3D12Context::ensureMotionReadback(std::string& error) {
    if (m_motionReadbackBuffer) {
      return true;
    }

    if (!m_motionTexture || m_motionUploadBytes == 0) {
      error = "There is no motion texture to read back";
      return false;
    }

    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Width = m_motionUploadBytes;
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    bufferDesc.Flags = D3D12_RESOURCE_FLAG_NONE;

    const D3D12_HEAP_PROPERTIES readbackHeap = heapProps(D3D12_HEAP_TYPE_READBACK);
    const HRESULT hr = m_device->CreateCommittedResource(
      &readbackHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
      IID_PPV_ARGS(&m_motionReadbackBuffer));
    if (FAILED(hr)) {
      error = hrToString("CreateCommittedResource (motion readback)", hr);
      return false;
    }

    return true;
  }

  void D3D12Context::recordMotionReadback() {
    if (!m_motionReadbackBuffer || !m_motionTexture) {
      return;
    }

    transition(m_motionTexture.Get(), m_motionState, D3D12_RESOURCE_STATE_COPY_SOURCE);

    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = m_motionReadbackBuffer.Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    dst.PlacedFootprint = m_motionFootprint;

    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = m_motionTexture.Get();
    src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    src.SubresourceIndex = 0;

    m_commandList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);
  }

  const uint8_t* D3D12Context::mapMotionReadback(std::string& error) {
    if (!m_motionReadbackBuffer) {
      error = "The motion readback buffer was never allocated";
      return nullptr;
    }

    void* mapped = nullptr;
    const D3D12_RANGE readAll = { 0, static_cast<SIZE_T>(m_motionUploadBytes) };
    const HRESULT hr = m_motionReadbackBuffer->Map(0, &readAll, &mapped);
    if (FAILED(hr)) {
      error = hrToString("Motion readback buffer Map", hr);
      return nullptr;
    }
    return static_cast<const uint8_t*>(mapped);
  }

  void D3D12Context::unmapMotionReadback() {
    if (!m_motionReadbackBuffer) {
      return;
    }
    const D3D12_RANGE wroteNothing = { 0, 0 };
    m_motionReadbackBuffer->Unmap(0, &wroteNothing);
  }

  const uint8_t* D3D12Context::mapReadback(uint32_t slot, std::string& error) {
    void* mapped = nullptr;
    const D3D12_RANGE readAll = { 0, static_cast<SIZE_T>(m_stagingBytes) };
    const HRESULT hr = m_readbackBuffers[slot]->Map(0, &readAll, &mapped);
    if (FAILED(hr)) {
      error = hrToString("Readback buffer Map", hr);
      return nullptr;
    }
    return static_cast<const uint8_t*>(mapped);
  }

  void D3D12Context::unmapReadback(uint32_t slot) {
    const D3D12_RANGE wroteNothing = { 0, 0 };
    m_readbackBuffers[slot]->Unmap(0, &wroteNothing);
  }

} // namespace vsdlssnr
