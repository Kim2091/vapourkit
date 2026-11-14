import * as fs from 'fs';
import * as path from 'path';
/** Resolve once at process startup: accepting an update never changes a running job. */
export function selectedComponentRoot(data: string, kind: string, fallback: string): string {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(data, 'config', 'component-selection.json'), 'utf8'));
    const key = state.active?.[kind];
    if (typeof key !== 'string' || !/^[a-z0-9-]+@[a-zA-Z0-9._-]+$/.test(key)) return fallback;
    const root = path.join(data, 'components', key);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json'), 'utf8'));
    if (kind === 'runtime' && (!manifest.runtime?.python || !fs.existsSync(path.join(root, manifest.runtime.python)))) return fallback;
    if (kind === 'ffmpeg' && !fs.existsSync(path.join(root, 'bin', 'ffmpeg.exe'))) return fallback;
    if (manifest.kind === kind && fs.existsSync(path.join(root, '.validated'))) return root;
  } catch { /* Legacy installation, or interrupted update: keep the working paths. */ }
  return fallback;
}
