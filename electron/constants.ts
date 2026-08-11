import * as path from 'path';
import { app } from 'electron';

// Current vapoursynth-mlrt-trt / vapoursynth-mlrt-ort PyPI version.
// Update this when upgrading vs-mlrt; a change prompts users to rebuild engines.
export const VS_MLRT_VERSION = '16.1';

// Extra package indexes required by the PyPI install:
// - pypi.nvidia.com hosts the TensorRT (tensorrt-cu13*) wheels
// - the JET vs-wheels index hosts vapoursynth-* plugin wheels not on PyPI
export const PYPI_EXTRA_INDEX_ARGS = [
  '--extra-index-url', 'https://pypi.nvidia.com/',
  '--extra-index-url', 'https://jaded-encoding-thaumaturgy.github.io/vs-wheels/simple',
];

// Platform helpers — keep every platform-specific filename/layout decision in
// this file so a Linux build only needs changes here (plus a venv bootstrap in
// dependencyManager instead of the Windows embedded-Python download).
export const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';
const DLL = IS_WINDOWS ? '.dll' : '.so';

// Embedded Python version installed by the Windows bootstrap. The site-packages
// location depends on it on Linux (lib/pythonX.Y/site-packages).
export const PYTHON_VERSION = '3.13.0';
const PYTHON_XY = PYTHON_VERSION.split('.').slice(0, 2).join('.');

// Use portable path relative to the executable location
// In development: uses the project directory
// In production: uses the directory where the .exe is located
export const APP_DATA_PATH = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'data')
  : path.join(app.getAppPath(), 'data');

const VS_PATH = path.join(APP_DATA_PATH, 'vapoursynth-portable');
const SITE_PACKAGES_PATH = IS_WINDOWS
  ? path.join(VS_PATH, 'Lib', 'site-packages')
  : path.join(VS_PATH, 'lib', `python${PYTHON_XY}`, 'site-packages');

// Centralized path constants
//
// The VapourSynth runtime is installed from PyPI into the Python environment's
// site-packages: vspipe and the core libraries live in site-packages/vapoursynth,
// and plugins autoload from site-packages/vapoursynth/plugins (pip plugin wheels
// install into per-plugin subfolders there; bundled extra DLLs go in its root).
export const PATHS = {
  APP_DATA: APP_DATA_PATH,
  VS: VS_PATH,
  SITE_PACKAGES: SITE_PACKAGES_PATH,
  PLUGINS: path.join(SITE_PACKAGES_PATH, 'vapoursynth', 'plugins'),
  SCRIPTS: path.join(VS_PATH, 'vs-scripts'),
  MODELS: path.join(APP_DATA_PATH, 'models'),
  CONFIG: path.join(APP_DATA_PATH, 'config'),
  VIDEO_COMPARE: path.join(APP_DATA_PATH, 'video-compare'),
  FILTER_TEMPLATES: path.join(APP_DATA_PATH, 'config', 'filter-templates'),
  PIP_CACHE: path.join(APP_DATA_PATH, 'pip-cache'),

  // Executables
  get VSPIPE() { return path.join(this.SITE_PACKAGES, 'vapoursynth', `vspipe${EXE}`); },
  get PYTHON() {
    return IS_WINDOWS ? path.join(this.VS, 'python.exe') : path.join(this.VS, 'bin', 'python3');
  },
  get VIDEO_COMPARE_EXE() { return path.join(this.VIDEO_COMPARE, `video-compare${EXE}`); },
  // pip console-script launcher (entry point `vsview = vsview.cli:main`)
  get VSVIEW_EXE() {
    return IS_WINDOWS ? path.join(this.VS, 'Scripts', 'vsview.exe') : path.join(this.VS, 'bin', 'vsview');
  },

  // Key pip-installed plugin/package locations used for install health checks.
  // The plain "ort" folder is removed post-install when the CUDA build is
  // present (see applyPluginCompatibilityFixes), so ORT checks must accept both.
  get BESTSOURCE_DLL() { return path.join(this.PLUGINS, `libbestsource${DLL}`); },
  get ORT_PLUGIN_DLL() { return path.join(this.PLUGINS, 'ort', IS_WINDOWS ? 'vsort.dll' : 'libvsort.so'); },
  get ORT_CUDA_PLUGIN_DLL() { return path.join(this.PLUGINS, 'ort-cuda', IS_WINDOWS ? 'vsort.dll' : 'libvsort.so'); },
  get TRT_PLUGIN_DLL() { return path.join(this.PLUGINS, 'trt', IS_WINDOWS ? 'vstrt.dll' : 'libvstrt.so'); },
  get TENSORRT_PACKAGE() { return path.join(this.SITE_PACKAGES, 'tensorrt'); },

  // FFmpeg
  FFMPEG_DIR: path.join(APP_DATA_PATH, 'ffmpeg'),
  get FFMPEG() { return path.join(this.FFMPEG_DIR, 'bin', `ffmpeg${EXE}`); },
  get FFPROBE() { return path.join(this.FFMPEG_DIR, 'bin', `ffprobe${EXE}`); }
} as const;
