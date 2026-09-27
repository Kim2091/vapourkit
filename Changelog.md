# Changelog

## 2.1.0

### Updating no longer costs you a re-setup
Until now, installing a new Vapourkit over an old one deleted the whole `data` folder: the Python/VapourSynth environment (several GB, ~20 minutes to rebuild), your settings, workflows, custom filters and built TensorRT engines. That is why copying a new portable build over an old one has been the faster way to update. From 2.1 the setup installer updates in place. `data` is kept, and the update takes seconds.

- **Coming from 2.0 (setup install):** just run the 2.1 installer. The uninstaller that runs during an update belongs to the version being *replaced*, and 2.0's could not cope with the environment's long file paths. It would have failed with "Vapourkit can't be closed" (or "Failed to uninstall old application files"), and clicking Retry never helped. The 2.1 installer now moves `data` out of the way before 2.0's uninstaller runs and puts it back afterwards, so the hop works and nothing is rebuilt
  - If you pick a different install folder on another drive, the installer can't move `data` across drives. It leaves it in a folder named `<old install folder>.update-data`, tells you where, and never deletes it. Move it into the new install folder as `data` and start Vapourkit
  - If an update is interrupted, `data` may be left in that `.update-data` folder. Running the installer again puts it back
- **Coming from 0.16 or older:** unchanged from 2.0. The old environment isn't compatible, so setup runs once. Export your workflows and filters first
- **Portable users:** extract 2.1 over your existing folder, keeping `data`, as before
- **Uninstalling** removes everything, including the long-path files the old uninstaller left behind, so the install folder no longer lingers after an uninstall
- **What an update does to an existing install, and how it tells you:** you don't have to reinstall plugins to get a release's fixes. On the first launch after an update, Vapourkit brings your install up to date and then shows a notice listing what it did. The notice stays in Settings → Last Update until every decision in it is made
  - **Filters you haven't edited** are updated to the new version, or removed if the release dropped them. This release updates 40 and removes 14
  - **Filters you have edited** are never changed without asking. If the release changed a filter you edited, the notice offers *Use new version* or *Keep mine*. If it dropped one, the notice offers *Remove* or *Keep*, and names the replacement when the filter was only renamed. Your copy is saved to `data\config\template-backups` before anything replaces or removes it. An edit made to a filter the release didn't change is left alone and not mentioned
  - **Filters you deleted** stay deleted. Updates used to put them back
  - **Python packages** are checked against the list this version installs. Anything missing or below its minimum version is installed: this release, `vapoursynth-timecube` (fast LUTs) and `vs_undistort>=2.3.1`. This needs an internet connection once. If it fails, the app still starts and tries again a day later
  - **Vapourkit's own DLSS plugin** (`vsdlssnr.dll`) is replaced when the bundled build differs
  - **VapourSynth scripts** (the Hybrid scripts and the bundled script pack) are versioned too. An update replaces the ones you haven't edited when a release changes them, keeps any you edited and lists them in the notice, and downloads nothing when nothing changed. Reinstalling plugins restores every shipped script, saving your edited ones to `data\config\script-backups` first
  - **Saved workflows are never touched**: each step keeps its own copy of the filter's code
  - How it knows: `data\config\installed-components.json` records the version of every filter, plugin and script Vapourkit put into your install, so later updates can tell its files from your changes

### Installing is more reliable
- **Downloads no longer hang.** Every download now gives up on a stalled connection instead of sitting at "Downloading… N%" forever, retries, and only hands a file to 7-Zip once it's completely written. That covers Python, pip, FFmpeg, video-compare, the model packs and the VapourSynth scripts. It also uses Windows' proxy settings. Before this, the "7-zip exited with code 2 / 0 bytes / file in use" fix only covered the scripts download
- **Errors say what went wrong.** A failed install used to say only "exit code 1". It now names the cause and what to do, with the relevant lines under Details and the log's location. Recognised causes: disk full, antivirus or a locked file, Windows' path-length limit, no connection, proxy or HTTPS interception, a damaged pip, and an interrupted earlier install
- **Checked before starting:** free space on the data drive and the temp folder (an NVIDIA plugin install needs 12 GB, and warns below 18 GB to leave room for pip's downloads and the TensorRT engines you'll build), whether Vapourkit's folder is writable, and warnings for a portable copy under Program Files or a folder path too long for Windows. After a successful install, pip's download cache is cleared, instead of growing to several GB
- **No more tangled retries.** Setup retries a failed plugin install once, as before, but no longer shows "Retry" while that retry is already running. Clicking it there used to start a second install into the same environment. Only one install or uninstall can run at a time
- **Cancel works during downloads and extraction**, not only while pip is running
- **A failed setup no longer leaves "Start Setup" stuck** on its spinner until you restart the app
- **The VapourSynth scripts download no longer fails the whole install.** If GitHub can't be reached, the rest installs, and the next launch fetches the scripts
- **Repairs itself where it can:**
  - At launch, a pip that no longer runs is reinstalled
  - A half-extracted Python is re-extracted instead of being trusted because `python.exe` exists
  - Plugin DLLs that vanish right after extraction are reported as antivirus quarantine, naming the folder to exclude, instead of failing later with a missing-plugin error
- On Linux, setup runs `vapoursynth config`, which fixes "Failed to initialize VSScript" on first launch (not yet tested on a Linux machine)
- **The dependency check runs once per launch.** It could run twice at once, and the two runs could spoil each other's files; this was the cause of the occasional "Failed to write the trtexec shim" in logs

### Colour grading
- Colour grading is a step in the filter chain, so it can sit anywhere: before the model to fix the source, after it to finish the result, or both. Reorder or disable it like any other step
- Opening a grade docks a Resolve-style panel under the preview: lift/gamma/gain/offset trackballs, a tone grid, and scopes. On a wide enough window the scopes get their own column beside the picture
- Grading is live against the real chain at full resolution, shaded on the GPU. Closing the panel re-renders once with the values baked in
- The tone sliders follow the cursor and take typed values
- A Clip toggle stripes clipped pixels (red at the top, blue at the bottom) live while you drag
- A black point picker: click something that should be black, and lift is solved per channel for level and colour cast together
- The preview reports where the picture sits in 8-bit code values, and flags footage that looks like limited-range video being read as full range
- Lift and gain are now a single ramp, as in Resolve, so setting a black point no longer drags the highlights. Highlight headroom above 1.0 is kept through gamma and contrast. An unedited Color Grade template is upgraded automatically
- LUTs (experimental): export a grade as `.cube` or `.3dl`, or import one as an Apply LUT step. **Create LUT** / **Load LUT** is a pair of steps that captures the colour at one point in the chain and restores it at another, either exactly or by fitting when a model sits between them, and reports how well it fit
- LUTs render through `timecube` (installed automatically), which is about 4x faster and half the memory of the fallback. Fixed a `.3dl` round trip that could come back up to 16x too bright, and importing two LUTs with the same filename no longer repoints saved workflows at the wrong one

### Inspect: preview the real chain in the app
- **Inspect** shows the actual output of each step at full resolution, one step at a time, instead of a 640px ffmpeg snapshot. Number keys switch steps, and Ctrl+R reloads after a chain change
- Playback: the chain plays in the app, each step at its own frame rate. Every frame is shown in order and none are dropped, so combing, cadence and ghosting are visible
- Timeline: position readout, drag to scrub, loop, Home/End, Shift+arrows for one-second steps. The picture follows a segment handle while you drag it, and the Segment button now toggles the mode directly
- The Before/After wipe works in Inspect
- Inspect can be cancelled while it's opening, even mid engine build
- **Removed:** the "Preview selection" button, which rendered a segment to a temp file. Playback plus loop replaces it. Preview errors now show as a toast
- Fixed the timeline seeking to the wrong moment on steps that change the clip length (e.g. a bob deinterlacer), and being off by the segment's in point

### DLSS Neural Uplift (NVIDIA)
- New filter backed by NVIDIA's DLSS-NR model, with Vapourkit's own VapourSynth plugin (`vsdlssnr.dll`, bundled)
- It needs `nvngx_dlssnr.dll`, which NVIDIA doesn't distribute on its own (it ships inside games that use DLSS 5). Import your copy with the file picker, either from the Plugins modal or from the bar that appears when a workflow needs it. The picker checks you chose the right DLL and not one of its lookalikes
- About 2x faster than the first build: 4K goes from ~19.5 to ~37 fps, and 1440p from ~34 to ~53 fps (RTX 5080)
- Optional motion vectors and depth inputs, plus automatic motion estimation on the GPU (on by default). A Vulkan backend is available and off by default
- `working_scale` runs the model on a downscaled copy and puts the detail back. Measured at 4K: ~26 fps at 0.75 and ~31 fps at 0.5, against ~17 at 1.0. Check faces and fine texture when using it
- Fixed several filter instances breaking each other (e.g. a preview and an encode at once)
- The official DLL is Blackwell-only. The filter no longer claims RTX 20 to 40 series can't work with it

### Filters
- Every shipped filter is now checked against the real VapourSynth core, at both ends of the clip. **All 151 build and render**
- 37 filters that failed to build now work, most of them broken by upstream renames: Detail/Luma/Ridge/Difference/Normalize Mask, MC_Degrain, Binarize Mask, Maximum/Minimum and their combinations, Clense, Grain Stabilize, EEDI3, Warp Sharp, Temporal Median, SpotLess, the four descalers, Undistort, and more
- Also fixed: QTGMC (Old) on every preset, Guided Filter (refused every real source), Read Image, GradFun3, Add Duplicates, Replace Multiple Frames, LUTDeCrawl (now works at 10-bit instead of 8)
- **Removed 13 filters that could not run**, because their native plugins have no build available: Based AA, Fill Drops RIFE/SVP, Fine Dehalo2, Frame Rate Converter, Grain Factory, LGhost Deghost, Oyster, Rainbow Smooth, Remove Dirt, Remove Dirt MC, TFMBobN, TFMBobQ. Workflows that use them keep their copy of the step. Fine Dehalo2 will come back once an upstream bug is fixed
- Undistort works on 50-series GPUs again (needs `vs_undistort` 2.3.1, installed automatically) and gets its `window_overlap` control back
- Crop at all zeros removes the padding a Pad or Modulus step added, as it originally did, and passes straight through when nothing was padded. Crop (Auto) is merged into it. Crop also has a visual editor
- A step can take its picture from any step above it, not only from the original clip. Wavelet Color Fix from Step is the first filter to use this
- Start is disabled while a filter editor is open, with the reason on hover

### Models and encoding
- BF16 TensorRT engines no longer produce corrupt output
- Model precision is read from the ONNX graph, so BF16 models import correctly. Auto-build now actually builds BF16 models as BF16
- The quality slider now works on hardware encoders (NVENC, AMF, QSV). Before, it had no effect, and every quality setting produced the same few-Mbps output

### Other
- Discord Rich Presence, off by default (Settings)
- The VapourSynth core is pinned to R79, the version every plugin and filter is verified against, and a newer one is put back at launch
- An interrupted plugin install no longer makes every later install fail. Stranded package metadata and half-removed folders are cleaned up first
- Fixed "7-zip exited with code 2" when setup extracted the VapourSynth scripts download
- Compare opens its window again. Before, it ran hidden, holding up to ~1GB

## 2.0.0
- Filters that build TensorRT engines at runtime no longer look like a frozen app
  - A banner names the engine being built, shows progress when the builder reports it, and explains that this is the first run at that resolution; it clears when the build ends, and on every cancel/crash path
  - Engine builds are kill-safe: the engine is written to a temp file and renamed into place, so force-closing mid-build can no longer leave a truncated engine that gets reused as a cache hit and permanently breaks the filter
  - Builds are recorded in the per-item queue log, and the vs-view launch now evaluates the script first so builds happen under Vapourkit's UI instead of freezing vs-view's window
  - Covers `vs_temporalfix`'s TemporalFix (AI) engine builds too — it builds engines its own way, so its existing build log lines are recognized directly (no progress percentage available, so the banner spins)
  - Third-party filters can opt into the same banner by printing `[vk-build] begin/progress/end` lines to stderr — see the [project documentation](https://github.com/Kim2091/vapourkit-site)
- The RIFE and DPIR filter templates now use real TensorRT when the TensorRT backend is selected, instead of ONNX Runtime CUDA
  - vs-mlrt builds those engines by shelling out to `trtexec`, which the TensorRT pip wheels don't ship; Vapourkit now installs a `trtexec` shim that routes the build through its own TensorRT Python API builder (the same one the model importer uses)
  - The first run at each resolution builds an engine (a few minutes, with the banner above); later runs at that resolution start instantly from the cached engine in `data/vsmlrt-models`
  - The RIFE model packs now also install the `rife_v2` model folder, so templates can select the v2 representation with `_implementation=2`; existing installs fetch it in the background at startup
- Python packages are now installed to match your GPU vendor, detected automatically at startup
  - NVIDIA: unchanged — CUDA PyTorch, `vsjetpack[full,nvidia]`, and both vs-mlrt backends (TensorRT + ONNX Runtime)
  - AMD: `vsjetpack[full,amd]` (HIP/OpenCL/Vulkan plugins) with the DirectML backend, and no multi-GB TensorRT/CUDA stack
  - Intel and unrecognized GPUs: `vsjetpack[full,cl,vulkan]` with the DirectML backend
  - PyTorch-based filters (vs_deepdeinterlace) get CPU PyTorch on non-NVIDIA GPUs instead of being broken — slower, but they run
- Installs now clean up packages left over from a different GPU configuration before installing (e.g. TensorRT/cuDNN and CUDA PyTorch when moving to an AMD GPU), including the duplicate ONNX Runtime plugin folder that could otherwise win the autoload race
- The Plugins modal reports "not installed" when the installed package set targets a different GPU than the one detected, so reinstalling repairs it
  - Existing NVIDIA installs are recognized as-is and are not forced through a reinstall; AMD/Intel users who installed the old CUDA-only package set are prompted to reinstall to get the correct packages
- Set `VAPOURKIT_FORCE_GPU_VENDOR=nvidia|amd|intel|unknown` to override GPU detection
- Fix the RIFE and DPIR filter templates failing with `"...models\rife\rife_v4.10.onnx" not found`
  - The old zip-based vs-mlrt shipped its model zoo next to the plugin DLLs; the PyPI wheels don't, so the vsmlrt RIFE/DPIR wrappers had nothing to load
  - The needed packs (RIFE v4.10, DPIR, ~75MB) now download to `data/vsmlrt-models` during plugin install, and existing installs fetch them automatically in the background at startup; generated scripts point `vsmlrt.models_path` there so pip reinstalls can't remove them
  - Other RIFE model versions can be dropped into `data/vsmlrt-models/rife` manually
- Rework inference backends into self-contained provider modules (`electron/providers/`)
  - Each backend (TensorRT, DirectML) owns its script codegen, model-file resolution, pip packages, plugin health checks, and engine building in one place; adding a backend (NCNN, OpenVINO) no longer touches the rest of the codebase
  - The DML/TRT header toggle is now a backend dropdown driven by the provider registry, with the same selection available in Settings
  - Backend choice is now per AI-model filter: every filter defaults to "Auto" (follows the app default) and can override it in the expanded filter card; overridden filters show a badge on the collapsed card
  - Generated scripts now include a `vk_backend()` helper so custom filters follow the app-selected backend; the bundled RIFE and DPIR templates use it (RIFE previously forced DirectML on every GPU, DPIR needed a hand-edited `nvidia_gpu` flag). On the TensorRT selection, script filters get real TensorRT through the `trtexec` shim described above
  - Settings, queue items, and workflow files store a backend id (`tensorrt`/`directml`) instead of the `useDirectML` boolean; existing values migrate automatically on load
- Migrate the entire install path from manual zip downloads to PyPI
  - VapourSynth (R79), vs-mlrt (16.1), BestSource, and all of pifroggi's plugins (`vs_temporalfix`, `vs_undistort`, `vs_colorfix`, `vs_grain`, `vs_tiletools`) now install via pip
  - Native VapourSynth plugins (akarin, vszip, zsmooth, bestsource, ...) arrive automatically as dependencies of `vsjetpack[full,nvidia]` and the pifroggi packages, using the NVIDIA and JET vs-wheels package indexes
  - `vspipe.exe` and the core runtime now come from the VapourSynth wheel in `Lib\site-packages\vapoursynth`; plugins autoload from `Lib\site-packages\vapoursynth\plugins`
  - vsjetpack is no longer pinned to 1.1.0 (the old `vapoursynth==72` ABI pin is obsolete)
  - `vsview[full]` is installed with the main plugin step instead of a separate pinned install
- TensorRT engine building now uses the TensorRT Python API instead of `trtexec` (the TensorRT pip wheels don't ship trtexec)
  - The Import Model dialog still accepts trtexec-style parameters; unsupported flags are ignored with a warning
- Portable installs that reuse an existing `data` folder are migrated in place: the old portable runtime, `vs-plugins` folder, and bundled script modules that PyPI now provides are cleaned up during setup, and the Python environment is upgraded in place
  - Existing TensorRT engines were built with an older TensorRT and need rebuilding — the existing vs-mlrt version-change prompt handles clearing them
- NOTE: upgrading a **setup install** from 0.16.x or older starts fresh (the old installer's upgrade flow removes the `data` folder) — export your workflows and filters before upgrading, then re-import them
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
