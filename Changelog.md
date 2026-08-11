# Changelog

## 0.17.0
- Migrate the entire install path from manual zip downloads to PyPI
  - VapourSynth (R79), vs-mlrt (16.1), BestSource, and all of pifroggi's plugins (`vs_temporalfix`, `vs_undistort`, `vs_colorfix`, `vs_grain`, `vs_tiletools`) now install via pip
  - Native VapourSynth plugins (akarin, vszip, zsmooth, bestsource, ...) arrive automatically as dependencies of `vsjetpack[full,nvidia]` and the pifroggi packages, using the NVIDIA and JET vs-wheels package indexes
  - `vspipe.exe` and the core runtime now come from the VapourSynth wheel in `Lib\site-packages\vapoursynth`; plugins autoload from `Lib\site-packages\vapoursynth\plugins`
  - vsjetpack is no longer pinned to 1.1.0 (the old `vapoursynth==72` ABI pin is obsolete)
  - `vsview[full]` is installed with the main plugin step instead of a separate pinned install
- TensorRT engine building now uses the TensorRT Python API instead of `trtexec` (the TensorRT pip wheels don't ship trtexec)
  - The Import Model dialog still accepts trtexec-style parameters; unsupported flags are ignored with a warning
- Existing zip-based installs are migrated automatically: the old portable runtime, `vs-plugins` folder, and bundled script modules that PyPI now provides are cleaned up during setup, and re-running setup upgrades the Python environment in place
  - Existing TensorRT engines were built with an older TensorRT and need rebuilding — the existing vs-mlrt version-change prompt handles clearing them
- DPIR filter template now defaults to the ONNX Runtime CUDA backend on NVIDIA (the TRT backend relied on runtime `trtexec` engine builds)
- Bundled `vs_deepdeinterlace` (not yet on PyPI) and the Hybrid scripts continue to install as before
- Groundwork for Linux support: all platform-specific filenames and the site-packages layout are centralized in `electron/constants.ts`; the pip install phases are platform-neutral, leaving only the Python bootstrap (and FFmpeg/video-compare downloads) Windows-specific
- Fix update checker falsely prompting nightly builds to "update" to the stable release they were cut from
  - Nightly version suffixes (e.g. `0.16.1-nightly.2026-05-13`) broke the version comparison; nightlies are now only offered stable releases with a strictly newer base version
- Fix vspipe crashing at startup with `v3bdg: unable to acquire api3 VSAPI, abort`
  - The bundled `fft3dfilter.dll` build contains its own API3-bridge guard that aborts the process under VapourSynth R79; it is now removed at install (fft3dfilter is unavailable until an API4 build is sourced)
  - Other API3 plugins load fine through VapourSynth's compat bridge (with deprecation warnings)
- Replace API3-only bundled plugins with API4 wheels from PyPI: mvtools, CAS, adaptivegrain, WNNM, KNLMeansCL (nlm-cuda), SCXvid, DCTFilter
- Fix vs-mlrt ONNX Runtime CUDA support: both `vapoursynth-mlrt-ort` (CPU/DirectML) and `vapoursynth-mlrt-ort-cuda` ship a `vsort.dll` and the CPU-only copy always won the autoload race; the redundant CPU-only folder is now removed post-install (the CUDA build bundles DirectML too)
- Bundled plugins now extract with skip-existing semantics so they can never overwrite pip-managed plugin files (several share identical filenames)
- Fix fresh installs on NVIDIA GPUs silently starting in DirectML mode
  - A race persisted `useDirectML=true` to localStorage before async CUDA detection resolved, permanently blocking the detection-based default
- Fix DirectML failing with `open ..._fp16_fp16.onnx failed` when a TensorRT engine model is selected
  - The engine→ONNX path mapping now understands the doubled precision suffix of custom-built engines and picks whichever ONNX candidate exists on disk
- Pre-included models now get the same ONNX auto-detection as custom imports when opening the build modal
  - Temporal frame count, precision, and static shapes were previously hardcoded (15 channels for any VSR model, precision from filename only), and the frame count was missing from the form entirely

## 0.16.1
- Fix `Cannot read properties of null (reading 'execute')` crash when canceling or restarting an upscale during the frame count probe
  - Same fix applied to the preview-segment path
- Stream BestSource indexing progress during the frame count probe so cold-cache runs don't look like a hang
  - Indexing progress now shows in the same progress bar used on first video load, and is written to the queue item log

## 0.16.0
- Auto-install plugins at the end of setup
  - Removes the manual "reinstall your plugins" step required by 0.15.0
  - Auto-retries once on transient failure; falls back to Retry / Continue-without-plugins on hard failure
- Add Privacy mode (lock icon in the header)
  - Hides preview frames, input/output filenames, queue thumbnails, and queue item names behind clickable veils
  - Notification toasts become generic so filenames don't leak to screen
  - Console auto-collapses when privacy is enabled
  - Setting persists across launches
- Add descriptive output filenames (enabled by default) — thanks @fs10102020!
  - See 0.15.1 entry below for details
- Add no-filters safety
  - Persistent banner above the Upscale button when no filters are enabled
  - Confirm dialog before upscaling with zero filters
  - Removed the old "default-upscale" silent fallback that would secretly run whichever AI model was selected first
- Add BestSource indexing progress bar under the video drop zone on first video load
- Rename Temporal Fix filters
  - `Temporal Fix V2` → `TemporalFix (AI)`
  - `Temporal Fix` → `TemporalFix (Classic)`
- Fix "Failed to initialize VSScript" on fresh installs
  - Pinned `vapoursynth==72` and `vsjetpack==1.1.0` so pip doesn't silently upgrade to an ABI-incompatible Python binding
- Fix vsview failing to launch (switched from `python -m vsview` to `vsview.exe`)
- Fix descriptive-naming regen ignoring the configured default output folder
- Fix duplicate `video-index-progress` terminal event in the `get-video-info` handler
- Fix content-length parseInt type error under newer `@types/axios`

## 0.15.1
- Add descriptive output filenames (enabled by default)
  - Output filenames now reflect your workflow instead of using a generic `_processed` suffix
  - Example: `EpisodeName-colorimetry_denoise_4x_resize2160.mkv`
  - Includes applied filters, AI model scale, and output resolution
  - Automatically truncates to 32 characters if too long
  - Manually selecting an output path disables auto-generation for that file
  - Toggle available in Settings under Processing
- Fix TypeScript compilation error in `electron/vsMlrtManager.ts`

## 0.14.0
This release in in dedication to my Mom. She passed away on 1/1/26 after a long battle with small cell lung cancer. Rest in peace
- Adds over 150 new filters, including many from Hybrid!
- Replaces the filter selection dropdown with a new modal
  - This has a tag system to make finding filters easier
  - It also has a search!
- Fixes the lag and focus issues present in previous versions of Vapourkit
  - You can now have 20+ filters expanded in your workflow and it will not slow down!
  - The bug that required alt tabbing to fix is no longer present
- Adds vse-previewer! This allows for realtime previewing of how your video will turn out without having to render the whole thing
  - Replaced vse-previewer with vs-view, a much more modern solution that has more features and is more robust
- Adds ESC button support to all pop up modals
- Added [vs_grain](https://github.com/pifroggi/vs_grain)
- Replaces pop up dialogs with notifications within the GUI
- Change legacy "TSPAN" text to "VSR". This change was made in conjunction with releasing [TFDAT](https://github.com/Kim2091/TFDAT), which effectively replaces TSPAN + TSPANv2
- Lots of GUI tweaks and bug fixes to make it more cohesive and consistent
- Add option to Settings to set a permanent output path for all videos
- Add option to duplicate queued items, and overhaul the behavior of the queue button

## 0.12.2
- Fix BF16 engine names (previously appended _fp16 when it's _bf16)
- Remove unused code
- Hide Validate button during processing
- Rename Color Matrix to Colorimetry as it does more than the name implies
- Improve GUI responsiveness
- Change the way Developer Log works. It now polls main.log instead of printing directly to the UI
  - This also has the added benefit of fixing formatting issues that were present previously
- Include 2x_bndl_animefilm_v1.5 FDAT

## 0.12.1
- Overhaul validation method. It will no longer automatically run in the background, instead you must manually run it if desired
- Fix issue where "Same as Input" was the default for fresh installs of Vapourkit
- Fix broken AV1 presets

## 0.12.0
- Remove simple mode to (ironically) simplify codebase
- Move encoding settings from Settings panel to the right pane, and add easy toggles for common settings
- Add RIFE filter for frame interpolation
- Overhaul vkfilter parsing to be more robust
- Fix GUI design inconsistencies
- Reverted to vs-mlrt 15.13 as 15.14 has noticeably lower performance
- Update vs_tiletools 
- Update zsmooth to 0.15

## 0.11.0
- Change the way file names are handled for models
- Overhaul the design of the header to save space
- Move the DirectML toggle from Settings to the header
- Change the default model type from `vsr` to `image` to reduce chance of error for models without metadata
- Fix audio clipping when using segments
- Allow users to customize video-compare settings in the Settings menu
- Force kill trtexec and vspipe processes when beginning workflow processing
- Add MC_Degrain filters
- Change to vs-mlrt version 15.14 from 15.13 RTX
- Add detection for vs-mlrt version changing (will not take effect in this release)
- Add BF16 toggle when building TensorRT models
- Add automatic static + shape detection when building TensorRT models
- Add update system for vs-mlrt plugin
- Update vs_undistort to version 2.0.0 (thanks tepete!)
- Update queue panel behavior and design to be more intuitive

## 0.10.2
- Implement segment selection. Users can now select a small segment of a video to process and preview!
  - When using this mode, the comparison buttons are disabled
- Fix issue where highlighted code wasn't visible in the Filter panel
- Minor bug fixes
- Fix GUI lag
- Add search function to Manage Models menu

## 0.10.1
- Redesign "Show Queue" button and change location
- Allow the user to change the color space the output video is saved in
- Rework the Settings menu to be easier to use
- Fix the way videos are displayed when processing is complete

## 0.10.0
- Add batch video processing support
- Add ability to launch comparisons in from queue list
- Add experimental update checker
- Add force stop button for stuck processes
- Clean up About menu
- Improve changelog display
- Fix processing bug with batch processing
- Update zsmooth plugin to 0.14
- Overhaul internal code for start/stop processing button
- Overhaul Video Info Panel
- Add documentation for Batch Processing
- Shrink queue panel and clean up unused files
- Fix color scheme of syntax highlighting

## 0.9.4
- Clarify precision options in GUI
- Add syntax highlighting for filters
- Add section for license information of included models
- Add link to GitHub page in About window

## 0.9.3
- Fix Logo in header being misaligned in Simple Mode
- Fix program icon being missing

## 0.9.2
- Fix race condition with filters
- Fix "Start Processing" button not working when Advanced mode AND TensorRT mode are enabled without any built engines

## 0.9.1
- Expose previously forced ffmpeg arguments to be edited
- Remove automatic CUDA detection, turned out to be a driver based issue
- Add menu to manage models (modify metadata, change precision, rename, delete)
- Refactored `main.ts

## 0.9.0
- Change preview to PNG from mJPEG to improve compatibility and avoid YUV errors
- ACTUALLY fix --fp32 being added to trt build command
- Move ffmpeg settings to Settings menu, remove old config file
- Add automatic detection for CUDA versions, and install different Pytorch versions depending on that

## 0.8.9
- Update VapourSynth and filter templates (thanks tepete)

## 0.8.8:
- Add custom engine build command support for tensorrt
- Rework "Import Model" interface
- Hopefully fix scrolling bug on right pane when processing a video

## 0.8.7:
- Add labels on header buttons
- Relabel certain buttons to make their function clearer
- Prevent processing when ONNX model is selected in TensorRT mode
- Fix model auto select after building engine

## 0.8.6:
- Fix progress bar in setup screen, round ffmpeg download to nearest integer
- Fix plugins being missing
- Fix workflows not notifying the user of missing models
- Fix workflow names including the extension when loaded

## 0.8.5:
- Static engine support
- Adds version number to about menu and window title
- Fixes ffmpeg and vspipe handling when stopping processing, prevents corrupt files
- Added animations and progress bar text when ffmpeg is stopping
- Adds MOV as an output option
- Rolled back to version 0.12 of zsmooth to fix temporalfix
- Fixed visual bug with num_streams slider
