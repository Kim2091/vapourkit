import * as path from 'path';
import { app } from 'electron';

// Use portable path relative to the executable location
// In development: uses the project directory
// In production: uses the directory where the .exe is located
export const APP_DATA_PATH = app.isPackaged 
  ? path.join(path.dirname(app.getPath('exe')), 'data')
  : path.join(app.getAppPath(), 'data');

// Centralized path constants
export const PATHS = {
  APP_DATA: APP_DATA_PATH,
  VS: path.join(APP_DATA_PATH, 'vapoursynth-portable'),
  PLUGINS: path.join(APP_DATA_PATH, 'vapoursynth-portable', 'vs-plugins'),
  SCRIPTS: path.join(APP_DATA_PATH, 'vapoursynth-portable', 'vs-scripts'),
  MLRT_PLUGIN: path.join(APP_DATA_PATH, 'vapoursynth-portable', 'vs-plugins', 'vsmlrt-cuda'),
  MODELS: path.join(APP_DATA_PATH, 'models'),
  CONFIG: path.join(APP_DATA_PATH, 'config'),
  VIDEO_COMPARE: path.join(APP_DATA_PATH, 'video-compare'),
  FILTER_TEMPLATES: path.join(APP_DATA_PATH, 'config', 'filter-templates'),
  
  // Executables
  get VSPIPE() { return path.join(this.VS, 'vspipe.exe'); },
  get PYTHON() { return path.join(this.VS, 'python.exe'); },
  get TRTEXEC() { return path.join(this.MLRT_PLUGIN, 'trtexec.exe'); },
  get VIDEO_COMPARE_EXE() { return path.join(this.VIDEO_COMPARE, 'video-compare.exe'); },
  
  // FFmpeg
  FFMPEG_DIR: path.join(APP_DATA_PATH, 'ffmpeg'),
  get FFMPEG() { return path.join(this.FFMPEG_DIR, 'bin', 'ffmpeg.exe'); },
  get FFPROBE() { return path.join(this.FFMPEG_DIR, 'bin', 'ffprobe.exe'); }
} as const;