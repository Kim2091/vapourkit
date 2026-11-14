import * as fs from 'fs-extra';
import { statfs } from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import TOML from '@iarna/toml';
import { VAPOURSYNTH_VERSION } from './vapoursynthCore';
import { getPypiPackages, getNoDepsPackages } from './vendorPackages';
import { resolveProvider } from './providers/registry';
import { PATHS } from './constants';
import { catalogSchema, type ComponentCatalog, type ComponentEntry, type ComponentSnapshot } from './componentCatalog';
import { selectedComponentRoot } from './componentPaths';
import { downloadToFile } from './download';
import { fileDigest, importModelPackage } from './modelPackage';
import { inspectOnnxGraph } from './onnxGraphInspector';
import { describeModel } from './modelContract';
import { inspectResolvedOnnxGraph } from './modelGraphResolver';
import { validateFilterTemplate } from './filterValidation';
import { writeJsonAtomic } from './jsonFile';
import { getBundledBasePath } from './utils';

export const CATALOG_URL = 'https://raw.githubusercontent.com/Kim2091/vapourkit/main/include/component-catalog.json';
const selectionFile = () => path.join(PATHS.CONFIG, 'component-selection.json');
const filterRoot = selectedComponentRoot(PATHS.APP_DATA, 'filters', '');
let catalog: ComponentCatalog | null = null;
let busy = false;
let pendingRestart = false;
interface Selection { active: Record<string, string>; previous: Record<string, string | null>; installed: Record<string, string>; }
async function selection(): Promise<Selection> {
  const value = await fs.readJson(selectionFile()).catch(() => null);
  const object = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!value || !object(value.active) || !object(value.previous) || !object(value.installed)) return { active: {}, previous: {}, installed: {} };
  return value;
}
export async function checkComponents(online = true): Promise<ComponentSnapshot> {
  const bundled = catalogSchema.parse(await fs.readJson(path.join(getBundledBasePath(), 'include', 'component-catalog.json')));
  const saved = await fs.readJson(path.join(PATHS.CONFIG, 'component-catalog.json')).catch(() => null);
  const cached = catalogSchema.safeParse(saved);
  catalog = cached.success && cached.data.revision >= bundled.revision ? cached.data : bundled;
  if (online) {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Catalog check failed (${response.status}). Installed components were kept.`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('Component catalog exceeds its size limit.');
    const remote = catalogSchema.parse(JSON.parse(text));
    const last = await fs.readJson(path.join(PATHS.CONFIG, 'component-catalog.json')).catch(() => null);
    if (remote.revision < Math.max(bundled.revision, last?.revision ?? 0)) throw new Error('The catalog is older than the last accepted revision.');
    catalog = remote;
    await writeJsonAtomic(path.join(PATHS.CONFIG, 'component-catalog.json'), remote);
  }
  const { configManager } = await import('./configManager');
  const vendor = configManager.getPluginsGpuVendor() ?? 'unknown';
  const compatible = catalog.components.filter(c => c.platforms.includes(process.platform as 'win32' | 'linux') && c.vendors.includes(vendor));
  return { catalog: { ...catalog, components: compatible }, installed: (await selection()).installed, pendingRestart };
}
function run(exe: string, args: string[], cwd: string, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, shell: false, windowsHide: true });
    let text = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Component health check timed out.')); }, timeout);
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { text = (text + chunk).slice(-8192); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error(`Component health check failed: ${text}`)); });
  });
}
export async function installComponent(id: string, version: string, allowExperimental: boolean): Promise<{ restart: boolean; message: string }> {
  if (busy) throw new Error('Another component installation is running.');
  const entry = catalog?.components.find(c => c.id === id && c.version === version);
  if (!entry) throw new Error('Check the curated catalog before installing a component.');
  const { configManager } = await import('./configManager');
  const vendor = configManager.getPluginsGpuVendor() ?? 'unknown';
  if (!entry.platforms.includes(process.platform as 'win32' | 'linux') || !entry.vendors.includes(vendor)) throw new Error('This component is incompatible with this platform/GPU.');
  if (entry.channel === 'experimental' && !allowExperimental) throw new Error('Enable experimental models explicitly before installing this candidate.');
  busy = true;
  const key = entry.id + '@' + entry.version;
  const root = path.join(PATHS.APP_DATA, 'components', key);
  const stage = root + '.staging-' + randomUUID();
  try {
    await fs.ensureDir(PATHS.APP_DATA);
    const disk = await statfs(PATHS.APP_DATA).catch(() => null);
    if (disk && Number(disk.bavail) * Number(disk.bsize) < entry.files.reduce((n, f) => n + f.bytes, 0) + 64 * 1024 ** 2) throw new Error('Not enough free space to stage this component while keeping the working version.');
    await fs.ensureDir(stage);
    for (const asset of entry.files) {
      const file = path.join(stage, asset.path);
      await fs.ensureDir(path.dirname(file));
      await downloadToFile(asset.url, file, { expectedSha256: asset.sha256, minBytes: asset.bytes, retries: 1 });
      if ((await fs.stat(file)).size !== asset.bytes) throw new Error('Downloaded component size disagrees with the approved manifest.');
    }
    if (entry.kind === 'model' && entry.model) {
      const graph = await inspectResolvedOnnxGraph(path.join(stage, entry.model.file));
      if (!graph) throw new Error('Downloaded model is not a readable ONNX graph.');
      const contract = describeModel(graph, { modelType: entry.model.type, temporalFrames: entry.model.frames, spatialMultiple: entry.model.spatialMultiple, catalog: true });
      await fs.writeJson(path.join(stage, 'model-contract.json'), contract);
    } else if (entry.kind === 'filters') {
      for (const asset of entry.files) {
        if (!asset.path.endsWith('.vkfilter')) throw new Error('Filter packs may only contain .vkfilter templates.');
        validateFilterTemplate(TOML.parse(await fs.readFile(path.join(stage, asset.path), 'utf8')));
      }
    } else if (entry.kind === 'ffmpeg') {
      await run(path.join(stage, 'bin', 'ffmpeg.exe'), ['-version'], stage);
      await run(path.join(stage, 'bin', 'ffprobe.exe'), ['-version'], stage);
      await run(path.join(stage, 'bin', 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64', '-frames:v', '1', '-c:v', 'libx264', '-f', 'null', '-'], stage);
    } else if (entry.kind === 'runtime' && entry.runtime) {
      // Only complete portable Windows bundles, never in-place pip upgrades or relocatable Linux venvs.
      if (entry.runtime.vapoursynthCore !== Number(VAPOURSYNTH_VERSION)) throw new Error('This runtime needs a newer Vapourkit compatibility release.');
      const required = [...getPypiPackages(vendor), ...getNoDepsPackages(vendor), ...resolveProvider(vendor === 'nvidia' ? 'tensorrt' : vendor === 'amd' ? 'migraphx' : 'directml').pipPackages()];
      const code = `import importlib.metadata as m, json, vapoursynth as vs
from packaging.requirements import Requirement
for spec in json.loads(${JSON.stringify(JSON.stringify(required))}):
 r=Requirement(spec)
 assert m.version(r.name) in r.specifier,(r.name,m.version(r.name),str(r.specifier))\nexpected=json.loads(${JSON.stringify(JSON.stringify(entry.runtime.packages))})\nfor name,version in expected.items():\n assert m.version(name)==version,(name,m.version(name),version)\nassert str(vs.core.core_version)=='R${entry.runtime.vapoursynthCore}'\nvs.core.std.BlankClip(width=64,height=64).get_frame(0)\n`;
      await run(path.join(stage, entry.runtime.python), ['-c', code], stage);
      const smoke = path.join(stage, entry.runtime.smokeModel);
      if (vendor === 'nvidia') {
        const { ensureEngineBuilderScript } = await import('./trtexecShim');
        const script = await ensureEngineBuilderScript();
        const graph = inspectOnnxGraph(smoke);
        if (!graph) throw new Error('Runtime smoke model is invalid.');
        const input = graph.inputs[0];
        await run(path.join(stage, entry.runtime.python), ['-u', script, '--onnx=' + smoke, '--saveEngine=' + path.join(stage, '.smoke.engine'), '--shapes=' + input.name + ':1x3x64x64', '--vkAdapter=rgb-window-v1'], stage, 1800000);
      } else {
        const graph = inspectOnnxGraph(smoke);
        if (!graph) throw new Error('Runtime smoke model is invalid.');
        const fmt = graph.inputDataType === 'float16' ? 'RGBH' : 'RGBS';
        const code = `import vapoursynth as vs\nc=vs.core.std.BlankClip(width=64,height=64,format=vs.${fmt})\no=vs.core.ort.Model(c,network_path=${JSON.stringify(smoke)},provider="DML")\no.get_frame(0)\n`;
        await run(path.join(stage, entry.runtime.python), ['-c', code], stage);
      }
    }
    await fs.writeJson(path.join(stage, 'component.json'), entry);
    await fs.writeFile(path.join(stage, '.validated'), '1');
    if (await fs.pathExists(root)) {
      for (const asset of entry.files) if (await fileDigest(path.join(root, asset.path)) !== asset.sha256) throw new Error('This component version was modified. Restore or choose a new version.');
    } else await fs.move(stage, root, { overwrite: false });
    const state = await selection();
    if (entry.kind === 'model' && entry.model) {
      const installed = await importModelPackage(path.join(root, entry.model.file), PATHS.MODELS, entry.id + '-' + entry.version);
      const contract = await fs.readJson(installed + '.contract.json');
      await fs.writeJson(installed + '.contract.json', { ...contract, spatialMultiple: entry.model.spatialMultiple, scale: entry.model.scale, catalog: key, semantics: 'catalog' });
      await configManager.setModelMetadata(path.basename(installed, '.onnx'), false, entry.model.type, entry.name, undefined, false, entry.model.frames);
    } else {
      state.previous[entry.kind] = state.active[entry.kind] ?? null;
      state.active[entry.kind] = key;
      pendingRestart = true;
    }
    state.installed[id] = version;
    await writeJsonAtomic(selectionFile(), state);
    return { restart: entry.kind !== 'model', message: entry.kind === 'model' ? 'Model installed alongside existing versions. Reload the model picker; its engine is built and checked for the workflow dimensions.' : 'Component verified. Restart Vapourkit when all jobs finish to use it.' };
  } finally { busy = false; await fs.remove(stage); }
}
export async function rollbackComponent(kind: string): Promise<void> {
  if (busy || !['runtime', 'ffmpeg', 'filters'].includes(kind)) throw new Error('Cannot roll back this component now.');
  busy = true;
  try {
    const state = await selection();
    if (!(kind in state.previous)) throw new Error('No previous component selection exists.');
    const previous = state.previous[kind];
    state.previous[kind] = state.active[kind] ?? null;
    if (previous) state.active[kind] = previous; else delete state.active[kind];
    pendingRestart = true; await writeJsonAtomic(selectionFile(), state);
  } finally { busy = false; }
}
/** Overlay unedited templates; custom templates and edits always take precedence. */
export async function overlayComponentFilters<T extends { name: string }>(templates: T[], files: Map<string, string>): Promise<T[]> {
  if (!filterRoot) return templates;
  const entry: ComponentEntry = await fs.readJson(path.join(filterRoot, 'component.json'));
  const result = [...templates];
  for (const asset of entry.files) {
    if (!await fs.pathExists(path.join(filterRoot, asset.path)) || await fileDigest(path.join(filterRoot, asset.path)) !== asset.sha256) continue;
    const template = TOML.parse(await fs.readFile(path.join(filterRoot, asset.path), 'utf8')) as unknown as T;
    const at = result.findIndex(t => t.name === template.name);
    const oldFile = files.get(template.name);
    if (at < 0) result.push(template);
    else if (oldFile && entry.replaces?.[template.name]?.includes(await fileDigest(oldFile))) result[at] = template;
  }
  return result;
}
