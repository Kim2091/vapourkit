# Changelog

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