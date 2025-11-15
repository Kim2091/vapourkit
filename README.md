# Vapourkit

![Version](https://img.shields.io/badge/version-0.8.2-blue)
![License](https://img.shields.io/badge/license-GPL%203.0-green)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

**Vapourkit** is a program for video upscaling and enhancement using VapourSynth and AI models. It provides a user-friendly interface for video processing with support for both NVIDIA TensorRT and DirectML (AMD/Intel/NVIDIA) backends.

## 🌟 Features

### Core Capabilities
- **Video Upscaling**: Process videos with AI upscaling models
- **Dual Backend Support**: Supports Nvidia GPUs with TensorRT and AMD/Intel GPUs using DirectML
- **Real-time Preview**: Realtime preview of the upscale!
- **Video Comparison Tool**: Built-in side-by-side comparison viewer for input/output videos
- **TSPANV2 Support**: [TSPANV2](https://github.com/Kim2091/TSPANV2) is a fast & high quality VSR architecture, which provides high quality video upscaling

### Two Modes

#### 🎯 Simple Mode (Default)
Perfect for newcomers to video upscaling:
- Select a video file
- Choose an AI upscaling model
- Configure output settings
- Process with one click

#### 🔬 Advanced Mode
Unlocks powerful customization options for advanced users:
- **Pre-made Filters**: Ships with dozens of pre-made filters for common tasks (thank you tepete!)
- **Custom VapourSynth Filters**: Write custom VapourSynth video processing filters
- **Filter Pipeline**: Chain VapourSynth filters in combination with AI upscaling models
- **Filter Templates**: Save, reuse, or share custom filter configurations (`.vkfilter` files)
- **Workflow System**: Export/import complete processing workflows (`.vkworkflow` files)
- **Custom Model Support**: Import your own ONNX models

### Model Support

See [Model Support](docs/Models.md) for more information.

### Workflow Management (Advanced Mode)

Save complete processing configurations including:
- Filter pipeline (all enabled filters and their settings)
- Selected model and backend settings
- Color matrix configuration
- Output format preferences

Export workflows to `.vkworkflow` files and share them or reuse them later.

## 📋 System Requirements

### Minimum Requirements
- **OS**: Windows 10/11 (x64)
- **RAM**: 8GB+ recommended
- **Storage**: 5 GB Minimum, 10 GB recommended free space for application and dependencies
- **GPU**: 
  - Minimum 6 GB VRAM
  - NVIDIA GPU 16xx or higher
  - AMD/Intel/NVIDIA GPU with DirectX 12 support (for DirectML)

## 🚀 Getting Started

### Installation

1. **Download**: Get the latest release (installer or portable ZIP)
2. **Install/Extract**: Run the installer or extract the ZIP to your desired location
3. **First Launch**: The application will detect missing dependencies and prompt you to run setup
4. **Setup**: Click "Start Setup" to download and install all required components

### Basic Usage (Simple Mode)

1. **Select Video**: Click "Select Video" or drag and drop a video file into the window
2. **Choose Model**: Select an AI upscaling model from the dropdown
   - Video models are recommended for general use
   - Image models provide sharper results but may have temporal instability
3. **Configure Output**: 
   - Choose output file location and name
   - Select output format (MKV, MP4, AVI, etc.)
4. **Preview** (Optional): Click "Preview Output" to see a sample frame
5. **Process**: Click "Upscale Video" to start processing
6. **Monitor Progress**: Track progress via the progress bar and console output
7. **Compare**: After completion, use "Compare Videos" to view input vs output side-by-side

### Advanced Usage (Developer Mode)

See [Advanced Mode](docs/Advanced Mode.md) for more information.

## 🔧 Development

See [Development](docs/Development.md) for more information.

## 📝 License

GPL 3.0 - See LICENSE file for details

## 👤 Author

Kim2091

## 🙏 Credits for included tools and models

- [VapourSynth](https://github.com/vapoursynth/vapoursynth/releases) & [vs-mlrt](https://github.com/AmusementClub/vs-mlrt/releases)
- [tepete](https://github.com/pifroggi)'s work on the filters & his plugins
- [video-compare](https://github.com/pixop/video-compare)
- [Sirosky](https://github.com/Sirosky/Upscale-Hub)'s models
- [the database](https://github.com/the-database/)'s models
- [vs-jetpack](https://github.com/Jaded-Encoding-Thaumaturgy/vs-jetpack/) for additional VapourSynth filters

### Other acknowledgments
- tepete, Bendel, leobby, Princess, and Hermes for beta testing!
 
---

For issues, feature requests, or contributions, please visit the project repository.
