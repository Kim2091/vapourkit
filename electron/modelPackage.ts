import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { describeModel } from './modelContract';
import { inspectOnnxGraph } from './onnxGraphInspector';
import { inspectResolvedOnnxGraph } from './modelGraphResolver';

export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function modelPackageFiles(source: string): Promise<string[]> {
  const graph = inspectOnnxGraph(source);
  if (!graph) throw new Error('Cannot inspect this ONNX package. Repair or re-export the model.');
  const root = await fs.realpath(path.dirname(source));
  const files: string[] = [];
  for (const location of graph.externalData) {
    if (!location || path.isAbsolute(location) || path.win32.isAbsolute(location) || location.split(/[\\/]/).includes('..')) throw new Error(`External weight location must stay inside the model folder: ${location}`);
    const resolved = await fs.realpath(path.join(root, location)).catch(() => { throw new Error(`Missing external weights: ${location}. Select the ONNX alongside all its weight files.`); });
    if (!resolved.startsWith(root + path.sep) || !(await fs.stat(resolved)).isFile()) throw new Error(`External weight file is outside the model folder: ${location}`);
    files.push(location);
  }
  return files.sort();
}
export async function packageIdentity(source: string): Promise<string> {
  const files = await modelPackageFiles(source);
  const parts = [['model', await fileDigest(source)]];
  for (const file of files) parts.push([file, await fileDigest(path.join(path.dirname(source), file))]);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
/** Immutable package folders prevent external-data collisions and preserve old workflows. */
export async function importModelPackage(source: string, modelsRoot: string, name: string): Promise<string> {
  if (!/^[^<>:"/\\|?*\x00-\x1f]+$/.test(name) || name === '.' || name === '..') throw new Error('Choose a model name without path separators or reserved characters.');
  const files = await modelPackageFiles(source);
  const identity = await packageIdentity(source);
  const targetDir = path.join(modelsRoot, 'packages', `${name}-${identity.slice(0, 16)}`);
  const target = path.join(targetDir, `${name}.onnx`);
  if (await fs.pathExists(target)) {
    if (await packageIdentity(target) !== identity) throw new Error('The installed model package was modified. Restore it before reimporting.');
    return target;
  }
  const stage = `${targetDir}.staging-${process.pid}-${Date.now()}`;
  try {
    await fs.ensureDir(stage);
    await fs.copy(source, path.join(stage, `${name}.onnx`));
    for (const file of files) {
      if (file === `${name}.onnx`) throw new Error('External weights collide with the ONNX filename. Rename the model.');
      await fs.copy(path.join(path.dirname(source), file), path.join(stage, file));
    }
    const graph = await inspectResolvedOnnxGraph(path.join(stage, `${name}.onnx`));
    if (!graph) throw new Error('Cannot inspect imported graph.');
    await fs.writeJson(path.join(stage, `${name}.onnx.contract.json`), describeModel(graph));
    if (await packageIdentity(path.join(stage, `${name}.onnx`)) !== identity) throw new Error('Model files changed during import; retry after the download finishes.');
    await fs.move(stage, targetDir, { overwrite: false });
    return target;
  } finally { await fs.remove(stage); }
}
export async function listModelFiles(root: string): Promise<string[]> {
  const files = await fs.readdir(root, { recursive: true, encoding: 'utf8' }) as string[];
  return files.filter(file => !file.includes('.staging-') && !file.split(/[\\/]/).includes('engines') && /\.(onnx|engine)$/.test(file));
}
