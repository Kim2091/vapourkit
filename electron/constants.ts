import * as path from 'path';
import { spawnSync } from 'child_process';
import { app } from 'electron';

// Current vapoursynth-mlrt-trt / vapoursynth-mlrt-ort PyPI version.
// Update this when upgrading vs-mlrt; a change prompts users to rebuild engines.
export const VS_MLRT_VERSION = '16.1';

// NCNN is released independently of the ORT/TRT wheels. Pin it separately so
// Linux installs stay reproducible without requesting a non-existent 16.1 wheel.
export const VS_MLRT_NCNN_VERSION = '15.16';

// Minimum vsview version the app requires (named preview outputs rely on its
// set_output API). The vs-view launch path upgrades older installs to satisfy
// this floor; the main plugin install already runs pip with --upgrade.
export const VSVIEW_MIN_VERSION = '0.9.0';

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

// Embedded Python version installed by the Windows bootstrap. This is also the
// first supported Linux ABI; the actual Linux site-packages path is queried
// from its venv interpreter below.
export const PYTHON_VERSION = '3.13.0';
const PYTHON_XY = PYTHON_VERSION.split('.').slice(0, 2).join('.');

// Windows keeps its portable data folder beside the executable. AppImages are
// mounted read-only, so packaged Linux builds must use Electron's writable
// per-user data directory instead.
export const APP_DATA_PATH = app.isPackaged
  ? IS_WINDOWS
    ? path.join(path.dirname(app.getPath('exe')), 'data')
    : path.join(app.getPath('userData'), 'data')
  : path.join(app.getAppPath(), 'data');

const VS_PATH = path.join(APP_DATA_PATH, 'vapoursynth-portable');

/**
 * A Linux venv follows the host interpreter's Python X.Y, which may differ
 * from the Windows embedded runtime. Ask the venv interpreter for its exact
 * site-packages directory rather than inferring it from the filesystem.
 */
export function resolveLinuxSitePackages(vsPath: string = VS_PATH): string {
  const pythonPath = path.join(vsPath, 'bin', 'python3');
  const result = spawnSync(
    pythonPath,
    ['-c', 'import site; print(site.getsitepackages()[0])'],
    { encoding: 'utf8', windowsHide: true },
  );
  const sitePackages = result.status === 0 ? result.stdout.trim() : '';
  if (sitePackages) {
    return sitePackages;
  }
  // The venv has not been created yet. This fallback is only used during its
  // bootstrap; the next PATHS.SITE_PACKAGES access queries the interpreter.
  const libDir = path.join(vsPath, 'lib');
  return path.join(libDir, `python${PYTHON_XY}`, 'site-packages');
}

// Centralized path constants
//
// The VapourSynth runtime is installed from PyPI into the Python environment's
// site-packages: vspipe and the core libraries live in site-packages/vapoursynth,
// and plugins autoload from site-packages/vapoursynth/plugins (pip plugin wheels
// install into per-plugin subfolders there; bundled extra DLLs go in its root).
export const PATHS = {
  APP_DATA: APP_DATA_PATH,
  VS: VS_PATH,
  get SITE_PACKAGES() {
    return IS_WINDOWS
      ? path.join(VS_PATH, 'Lib', 'site-packages')
      : resolveLinuxSitePackages();
  },
  get PLUGINS() { return path.join(this.SITE_PACKAGES, 'vapoursynth', 'plugins'); },
  SCRIPTS: path.join(VS_PATH, 'vs-scripts'),
  MODELS: path.join(APP_DATA_PATH, 'models'),
  // vsmlrt.py model zoo (RIFE/DPIR for the bundled filter templates). App-owned
  // so pip reinstalls can't remove it; generated scripts point
  // vsmlrt.models_path here (the pip vs-mlrt wheels ship no models folder).
  VSMLRT_MODELS: path.join(APP_DATA_PATH, 'vsmlrt-models'),
  CONFIG: path.join(APP_DATA_PATH, 'config'),
  VIDEO_COMPARE: path.join(APP_DATA_PATH, 'video-compare'),
  FILTER_TEMPLATES: path.join(APP_DATA_PATH, 'config', 'filter-templates'),
  PIP_CACHE: path.join(APP_DATA_PATH, 'pip-cache'),
  // trtexec shim written by trtexecShim.ts. vsmlrt.py builds TensorRT engines
  // at runtime by spawning trtexec, which the TensorRT pip wheels don't ship;
  // generated scripts point vsmlrt.trtexec_path here and the shim forwards the
  // trtexec-style arguments to the app's own Python API engine builder.
  TRTEXEC_SHIM: path.join(APP_DATA_PATH, IS_WINDOWS ? 'trtexec.cmd' : 'trtexec'),

  // Executables
  get VSPIPE() { return path.join(this.SITE_PACKAGES, 'vapoursynth', `vspipe${EXE}`); },
  get PYTHON() {
    return IS_WINDOWS ? path.join(this.VS, 'python.exe') : path.join(this.VS, 'bin', 'python3');
  },
  // Video Compare only ships an official Windows binary. Linux uses a
  // distribution-installed `video-compare` command when the user has it.
  get VIDEO_COMPARE_EXE() { return IS_WINDOWS ? path.join(this.VIDEO_COMPARE, `video-compare${EXE}`) : 'video-compare'; },
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
  get NCNN_PLUGIN_DLL() { return path.join(this.PLUGINS, IS_WINDOWS ? 'vsncnn.dll' : 'libvsncnn.so'); },
  get TRT_PLUGIN_DLL() { return path.join(this.PLUGINS, 'trt', IS_WINDOWS ? 'vstrt.dll' : 'libvstrt.so'); },
  get TENSORRT_PACKAGE() { return path.join(this.SITE_PACKAGES, 'tensorrt'); },

  // FFmpeg
  FFMPEG_DIR: path.join(APP_DATA_PATH, 'ffmpeg'),
  get FFMPEG() { return path.join(this.FFMPEG_DIR, 'bin', `ffmpeg${EXE}`); },
  get FFPROBE() { return path.join(this.FFMPEG_DIR, 'bin', `ffprobe${EXE}`); }
} as const;
