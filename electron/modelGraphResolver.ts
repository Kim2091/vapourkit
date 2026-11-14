import { execFile } from 'child_process';
import { inspectOnnxGraph, type OnnxGraphInfo, type OnnxBinding } from './onnxGraphInspector';

/** Resolve symbolic channels in the same Python helper used during inference.
 * Numeric RGB graphs retain the fast metadata-only path, including BF16.
 */
export async function inspectResolvedOnnxGraph(source: string): Promise<OnnxGraphInfo | null> {
  const graph = inspectOnnxGraph(source);
  if (!graph || ![...graph.inputs, ...graph.outputs].some(b => b.shape.length === 4 && typeof b.shape[1] !== 'number')) return graph;
  const { ensureModelRuntimeScript } = await import('./trtexecShim');
  const { PATHS } = await import('./constants');
  const script = await ensureModelRuntimeScript();
  const resolved = await new Promise<string>((resolve, reject) => {
    execFile(PATHS.PYTHON, ['-I', script, '--inspect-bindings', source], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Could not resolve ONNX tensor channels in Vapourkit's private Python: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
  const value = JSON.parse(resolved);
  const merge = (original: OnnxBinding[], inferred: unknown): OnnxBinding[] => {
    if (!Array.isArray(inferred) || original.length !== inferred.length) throw new Error('ONNX shape inspection changed tensor bindings.');
    return original.map((binding, index) => {
      const result = inferred[index];
      if (result.name !== binding.name || !Array.isArray(result.shape) || result.shape.length !== binding.shape.length || !result.shape.every((d: unknown) => d === null || typeof d === 'string' || (typeof d === 'number' && Number.isInteger(d)))) throw new Error('Invalid inferred ONNX tensor metadata.');
      return { ...binding, shape: result.shape.map((d: number | string | null) => d ?? 'unknown') };
    });
  };
  const inputs = merge(graph.inputs, value.inputs); const outputs = merge(graph.outputs, value.outputs);
  return { ...graph, inputs, outputs, inputName: inputs[0]?.name, inputShape: inputs[0]?.shape, outputShape: outputs[0]?.shape,
    isStatic: inputs[0]?.shape.every(d => typeof d === 'number' && d > 0) ?? false };
}
