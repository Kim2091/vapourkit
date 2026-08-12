# Vapourkit

![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FKim2091%2Fvapourkit%2Fmain%2Fpackage.json&query=%24.version&label=version&color=blue)
![License](https://img.shields.io/badge/license-GPL%203.0-green)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)
![Discord](https://img.shields.io/discord/1470824551456706580)


**Vapourkit** is a free, open source program for video upscaling and enhancement using VapourSynth and AI models. It supports NVIDIA TensorRT, DirectML (Windows), and NCNN Vulkan (Linux) inference backends.

<img width="2033" height="1248" alt="image" src="https://github.com/user-attachments/assets/8a821fae-1060-4178-9134-e398048534bc" />

## 🚀 Getting Started

### Installation
[**Free download here**](https://ko-fi.com/s/2e5ebd456d)

#### Windows

1. Download and extract/install to your desired location
2. On first launch, click "Start Setup" when prompted to install dependencies

#### Linux (x86_64 AppImage)

1. Install the host prerequisites listed below.
2. Make the downloaded AppImage executable: `chmod +x Vapourkit-*.AppImage`.
3. Run it with `./Vapourkit-*.AppImage`, then click **Start Setup** when prompted.

The AppImage contains Vapourkit itself; it deliberately uses your distribution's Python, FFmpeg, and Vulkan driver. If FUSE is unavailable, run it with `APPIMAGE_EXTRACT_AND_RUN=1 ./Vapourkit-*.AppImage`.

### Quick Start
1. Select or drag-and-drop a video file
2. Choose an upscaling model
3. Configure output location and format
4. Click "Upscale Video" to process
5. Use "Preview Output" or "Compare Videos" to review results

For advanced features like custom filters and workflows, see [Advanced Mode](https://github.com/Kim2091/vapourkit/blob/main/docs/Advanced%20Mode.md).

## 🌟 Features

### Core Capabilities
- **AI Video Upscaling**: Process videos with high quality AI upscaling models
- **Dual Backend Support**: TensorRT (NVIDIA) or DirectML (AMD/Intel/NVIDIA)
- **Real-time Preview**: See results while processing
- **Video Comparison**: Built-in side-by-side viewer
- **Batch Processing**: Upscale multiple videos sequentially

### 🔬 Complete Control
- **Pre-made Filters**: Dozens of ready-to-use filters (thanks [pifroggi](https://github.com/pifroggi/)!)
- **Custom VapourSynth Filters**: Write and chain custom video processing filters
- **Templates & Workflows**: Save/share filter configs (`.vkfilter`) and complete workflows (`.vkworkflow`)
- **Custom Models**: Import your own ONNX models
- **Enhanced Batch Processing**: Process multiple videos sequentially with custom workflows

### Model Support

See [Model Support](docs/Models.md) for included models, custom model requirements, and model licensing details.

## 📋 System Requirements

### Minimum Requirements
- **OS**: Windows 10/11 (x64), or an x86_64 glibc-based Linux distribution running the AppImage
- **RAM**: 8GB+ recommended
- **Storage**: 5 GB Minimum, 10 GB recommended free space for application and dependencies
- **GPU**:
  - Minimum 6 GB VRAM recommended
  - Windows: NVIDIA 16xx series or newer for TensorRT (driver 580.x or newer), or an AMD/Intel/NVIDIA GPU with DirectX 12 support for DirectML
  - Linux: a working Vulkan loader and GPU driver for NCNN Vulkan inference. TensorRT on Linux requires a separately installed, compatible NVIDIA CUDA/TensorRT stack.

### Linux prerequisites

Before first launch, install these through your distribution package manager:

- Python **3.12 or 3.13**, including its `venv`/`ensurepip` package;
- `ffmpeg` and `ffprobe` on `PATH`;
- the Vulkan loader and a working GPU driver/ICD (for example Mesa's Vulkan driver on supported AMD/Intel hardware, or NVIDIA's proprietary driver).

The application checks for Python and FFmpeg before setup. `video-compare` is optional on Linux. Linux package names vary, so use the package names supplied by your distribution instead of copying a command intended for another release.

## 🔧 Development

See [Development](docs/Development.md) for more information.

## 📝 License

GPL 3.0 - See LICENSE file for details

## Discord
Chat here about Vapourkit!

https://discord.gg/uYKMn2hGwB

## 🙏 Credits

- [VapourSynth](https://github.com/vapoursynth/vapoursynth/releases) & [vs-mlrt](https://github.com/AmusementClub/vs-mlrt/releases)
- [tepete](https://github.com/pifroggi)'s work on the filters & his plugins
- [video-compare](https://github.com/pixop/video-compare)
- [Sirosky](https://github.com/Sirosky/Upscale-Hub)'s models
- [the database](https://github.com/the-database/)'s models
- [vs-jetpack](https://github.com/Jaded-Encoding-Thaumaturgy/vs-jetpack/) for additional VapourSynth filters

### Other acknowledgments
- [tepete/pifroggi](https://github.com/pifroggi/), Bendel, leobby, Princess, and Hermes for beta testing!

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Kim2091/vapourkit&type=date&legend=top-left)](https://www.star-history.com/#Kim2091/vapourkit&type=date&legend=top-left)
