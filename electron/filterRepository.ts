
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { z } from 'zod';
import { pkg, safePath, chooseArtifact, type Package } from './filterRepositoryPolicy';
import type { RepositoryEntry } from './filterRepositoryTypes';
import { PATHS } from './constants';
import { downloadToFile } from './download';
import { fileDigest } from './modelPackage';
import { setupVSEnvironment } from './utils';
import { TemplateManager } from './templateManager';

const REGISTRY = 'https://www.vapoursynth.com/vsrepo/vspackages3.zip';
let packages: Package[] = [];
let installed = new Set<string>();
let installing = false;

function run(code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PATHS.PYTHON, ['-I', '-c', code, ...args], { env: setupVSEnvironment(PATHS.PYTHON), windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message)); else resolve(stdout);
    });
  });
}
function findPackage(id: string): Package | undefined {
  return packages.find(p => [p.identifier, p.namespace, p.modulename].includes(id));
}
function plan(root: Package): Package[] {
  const result: Package[] = []; const visiting = new Set<string>(); const done = new Set<string>();
  const visit = (p: Package) => {
    if (done.has(p.identifier) || installed.has(p.identifier)) return;
    if (visiting.has(p.identifier)) throw new Error('The registry contains a dependency cycle.');
    if (!chooseArtifact(p)) throw new Error(p.name + ': no compatible binary/API declaration for this runtime.');
    visiting.add(p.identifier);
    for (const dependency of p.dependencies) {
      if (installed.has(dependency)) continue;
      const child = findPackage(dependency);
      if (!child) throw new Error(p.name + ': dependency is not in VSRepo: ' + dependency);
      visit(child);
    }
    visiting.delete(p.identifier); done.add(p.identifier); result.push(p);
  };
  visit(root); return result;
}
export async function listRepository(refresh: boolean): Promise<RepositoryEntry[]> {
  const cache = path.join(PATHS.CONFIG, 'vsrepo-packages.json');
  if (refresh || !packages.length) {
    let data: unknown;
    if (!refresh) data = await fs.readJson(cache).catch(() => null);
    if (!data) {
      const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'vapourkit-vsrepo-'));
      try {
        const archive = path.join(stage, 'registry.zip');
        await downloadToFile(REGISTRY, archive, { label: 'VapourSynth filter catalog', retries: 1 });
        const seven = (await import('7zip-min')).default;
        await seven.cmd(['x', '-y', '-o' + stage, archive, 'vspackages3.json']);
        data = await fs.readJson(path.join(stage, 'vspackages3.json'));
      } finally { await fs.remove(stage); }
    }
    const parsed = z.object({ 'file-format': z.literal(3), packages: z.array(z.unknown()).max(2000) }).parse(data);
    packages = parsed.packages.map(p => pkg.safeParse(p)).filter(p => p.success).map(p => p.data!);
    await fs.ensureDir(PATHS.CONFIG); await fs.writeJson(cache, data);
  }
  // One runtime query per catalog refresh; don't import every script just to list it.
  const info = JSON.parse(await run("import json,vapoursynth as vs\nprint(json.dumps([p.identifier for p in vs.core.plugins()]))"));
  installed = new Set<string>(info);
  for (const p of packages) {
    if (p.type === 'PyScript' && p.modulename && /^[\w]+$/.test(p.modulename)) {
      if (await fs.pathExists(path.join(PATHS.SCRIPTS, p.modulename + '.py')) || await fs.pathExists(path.join(PATHS.SITE_PACKAGES, p.modulename)) || await fs.pathExists(path.join(PATHS.SITE_PACKAGES, p.modulename + '.py'))) installed.add(p.identifier);
    }
  }
  return packages.map(p => {
    const chosen = chooseArtifact(p); let reason = '';
    try { plan(p); } catch (error) { reason = String(error); }
    return { id: p.identifier, name: p.name, description: p.description, kind: p.type,
      version: chosen?.version ?? '', api: chosen?.api ?? p.api ?? null, namespace: p.namespace ?? p.modulename ?? '',
      compatible: Boolean(chosen) && !reason, reason: reason || (chosen ? '' : 'No supported API3/API4 artifact for this platform, or script metadata is incomplete.'),
      installed: installed.has(p.identifier) };
  });
}
export async function installRepositoryPackage(id: string): Promise<{ message: string }> {
  if (installing) throw new Error('A filter installation is already running.');
  const root = findPackage(id);
  if (!root) throw new Error('Load the VSRepo catalog before installing.');
  const work = plan(root);
  if (!work.length) return { message: 'This plugin is already available in the current runtime.' };
  installing = true;
  let stage = '';
  const published: string[] = [];
  const templateNames: string[] = [];
  try {
    stage = await fs.mkdtemp(path.join(os.tmpdir(), 'vapourkit-filter-'));
    const files: { source: string; target: string; kind: string; module?: string }[] = [];
    for (const p of work) {
      const chosen = chooseArtifact(p)!;
      const url = new URL(chosen.asset.url);
      if (url.protocol !== 'https:' || url.username || url.password || !['github.com', 'api.github.com', 'raw.githubusercontent.com', 'www.vapoursynth.com'].includes(url.hostname)) throw new Error('Unsupported repository download host: ' + url.hostname);
      const folder = path.join(stage, randomUUID()); await fs.ensureDir(folder);
      const archive = path.join(folder, 'download');
      await downloadToFile(url.href, archive, { label: p.name, retries: 1 });
      const entries = Object.entries(chosen.asset.files);
      if (entries.length > 512) throw new Error('Package has too many files.');
      for (const [target, [member]] of entries) { safePath.parse(target); safePath.parse(member); }
      const seven = (await import('7zip-min')).default;
      // Select exact registry members, never extract an entire third-party archive.
      const direct = entries.length === 1 && decodeURIComponent(path.posix.basename(url.pathname)) === path.posix.basename(entries[0][1][0]);
      if (direct) {
        const destination = path.join(folder, entries[0][1][0]);
        await fs.ensureDir(path.dirname(destination));
        await fs.copy(archive, destination);
      } else {
        const listing = await seven.list(archive);
        for (const [, [member]] of entries) {
          const found = listing.find(item => item.name.replace(/\\/g, '/') === member);
          if (!found || !found.size || Number(found.size) > 512 * 1024 * 1024) throw new Error('Invalid or oversized archive member: ' + member);
        }
        await seven.cmd(['x', '-y', '-o' + folder, archive, ...entries.map(([, [member]]) => member)]);
      }
      for (const [target, [member, sha]] of entries) {
        const source = path.join(folder, member);
        if (!(await fs.realpath(source)).startsWith(await fs.realpath(folder) + path.sep) || !(await fs.lstat(source)).isFile() || await fileDigest(source) !== sha) throw new Error('Checksum/type mismatch: ' + target);
        const base = p.type === 'PyScript' ? PATHS.SCRIPTS : PATHS.PLUGINS;
        const destination = path.join(base, target);
        if (files.some(f => f.target.toLowerCase() === destination.toLowerCase())) throw new Error('Dependency file collision: ' + target);
        if (await fs.pathExists(destination)) {
          if (await fileDigest(destination) === sha) continue;
          throw new Error('Existing plugin/script would be overwritten: ' + target + '. Keep your current version or manage it explicitly.');
        }
        files.push({ source, target: destination, kind: p.type, module: p.modulename });
      }
    }
    const native = files.filter(f => f.kind === 'VSPlugin' && /\.(dll|so)$/i.test(f.source)).map(f => f.source);
    const scripts = [...new Set(work.filter(p => p.type === 'PyScript').map(p => p.modulename).filter(Boolean))];
    // Loading staged plugins in a disposable interpreter validates API/ABI and dependencies.
    const health = await run(`import json,sys,pathlib,importlib,vapoursynth as vs
spec=json.loads(sys.argv[1])
handles=[]\nimport os\nif hasattr(os,'add_dll_directory'):\n for folder in spec['folders']: handles.append(os.add_dll_directory(folder))\nerrors=[]\nfor file in spec['native']:\n try: vs.core.std.LoadPlugin(path=file)\n except Exception as error: errors.append(str(error))\nloaded={p.identifier for p in vs.core.plugins()}\nassert set(spec['nativeIds']).issubset(loaded),errors
for folder in spec['folders']: sys.path.insert(0,folder)
sys.path.insert(0,spec['scriptsPath'])
for module in spec['scripts']: importlib.import_module(module)
result=[]
for plugin in vs.core.plugins():
 if plugin.identifier in spec['ids']:
  result.append({'namespace':plugin.namespace,'functions':[{'name':f.name,'signature':f.signature} for f in plugin.functions()]})
print(json.dumps(result))`, [JSON.stringify({ native, folders: files.map(f => path.dirname(f.source)), scripts, scriptsPath: PATHS.SCRIPTS, nativeIds: work.filter(p => p.type === 'VSPlugin').map(p => p.identifier), ids: work.map(p => p.identifier) })]);
    // Publish without replacing anything already loaded by a running workflow.
    for (const file of files) {
      await fs.ensureDir(path.dirname(file.target));
      await fs.copy(file.source, file.target, { overwrite: false, errorOnExist: true });
      published.push(file.target);
    }
    const manager = new TemplateManager();
    const existing = new Set((await manager.loadTemplates()).map(t => t.name));
    let templates = 0;
    for (const plugin of JSON.parse(health) as { namespace: string; functions: { name: string; signature: string }[] }[]) {
      if (!/^\w+$/.test(plugin.namespace)) continue;
      for (const fn of plugin.functions) {
        if (!/^\w+$/.test(fn.name)) continue;
        const args = fn.signature.split(';').filter(Boolean);
        if (!args[0]?.match(/^[\w]+:vnode$/) || args.slice(1).some(arg => !arg.split(':').includes('opt'))) continue;
        const name = 'VSRepo ' + plugin.namespace + ' ' + fn.name;
        if (existing.has(name)) continue;
        await manager.saveTemplate({ name, category: ['VSRepo'], description: root.description, code: 'clip = core.' + plugin.namespace + '.' + fn.name + '(clip)' });
        templateNames.push(name);
        templates++;
      }
    }
    for (const p of work) installed.add(p.identifier);
    return { message: 'Installed ' + work.map(p => p.name).join(', ') + '. Added ' + templates + ' single-clip filter templates. Filter templates refreshed; close/reopen any preview to load the new plugins. Other functions/scripts can be used in a custom filter.' };
  } catch (error) {
    const manager = new TemplateManager();
    for (const name of templateNames) await manager.deleteTemplate(name).catch(() => {});
    for (const file of published.reverse()) await fs.remove(file).catch(() => {});
    throw error;
  } finally { installing = false; if (stage) await fs.remove(stage); }
}
