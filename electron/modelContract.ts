export interface ContractBinding { name: string; shape: Array<number | string>; dataType: string; }
export interface ContractGraph { inputs: ContractBinding[]; outputs: ContractBinding[]; }

/** Versioned semantics shared by import, build and script generation. */
export interface ModelContract {
  schema: 1;
  adapter: 'rgb-image-v1' | 'rgb-window-v1';
  inputs: ContractBinding[];
  outputs: ContractBinding[];
  temporalFrames: number;
  inputType: 'float16' | 'float32';
  outputType: 'float16' | 'float32';
  spatialMultiple: number;
  semantics: 'unverified-rgb' | 'catalog';
}
export function describeModel(graph: ContractGraph, options: { modelType?: string; temporalFrames?: number; spatialMultiple?: number; catalog?: boolean } = {}): ModelContract {
  if (graph.inputs.length !== 1 || graph.outputs.length !== 1) throw new Error('This model has multiple inputs or outputs. It needs a dedicated architecture adapter; automatic RGB setup is unavailable.');
  const input = graph.inputs[0]; const output = graph.outputs[0];
  if (input.shape.length !== 4 || output.shape.length !== 4) throw new Error('Automatic setup supports NCHW image or channel-packed video models. This tensor layout needs a dedicated adapter.');
  if (input.shape[0] !== 1 && typeof input.shape[0] === 'number') throw new Error('The RGB adapter requires batch size 1. Re-export this model or use its dedicated adapter.');
  const channels = input.shape[1];
  if (typeof channels !== 'number' || channels < 3 || channels % 3) throw new Error('The RGB adapter needs a known input channel count of 3 × frames. Chroma, auxiliary and symbolic-channel models need a dedicated adapter.');
  const frames = channels / 3;
  if (frames % 2 === 0) throw new Error('Centered temporal models require an odd frame count. Even-frame models need an explicit frame-order adapter.');
  if (options.modelType && (options.modelType === 'vsr') !== (frames > 1)) throw new Error(`Selected model type disagrees with the graph: ${frames} RGB frame(s). Refresh automatic detection.`);
  if (options.temporalFrames !== undefined && frames !== options.temporalFrames) throw new Error(`The graph requires ${frames} temporal frames, but ${options.temporalFrames} were configured.`);
  if (output.shape[1] !== 3) throw new Error(`Output \"${output.name}\" has ${typeof output.shape[1] === 'number' ? 'incompatible' : 'unresolved'} channels (${output.shape[1]}); shape ${output.shape.join('×')}. The RGB adapter requires exactly three output channels after ONNX shape inference. Re-export with explicit RGB channels or use a dedicated adapter.`);
  for (const binding of [input, output]) if (!['float16', 'float32', 'bfloat16'].includes(binding.dataType)) throw new Error(`Unsupported image tensor type: ${binding.dataType}.`);
  const multiple = options.spatialMultiple ?? 1;
  if (!Number.isInteger(multiple) || multiple < 1 || multiple > 256) throw new Error('Invalid architecture spatial multiple.');
  return { schema: 1, adapter: frames > 1 ? 'rgb-window-v1' : 'rgb-image-v1', inputs: graph.inputs, outputs: graph.outputs,
    temporalFrames: frames, inputType: input.dataType === 'float32' ? 'float32' : 'float16', outputType: output.dataType === 'float32' ? 'float32' : 'float16',
    spatialMultiple: multiple, semantics: options.catalog ? 'catalog' : 'unverified-rgb' };
}

export function profileFor(contract: ModelContract, width: number, height: number): string {
  const input = contract.inputs[0];
  if (![width, height].every(n => Number.isInteger(n) && n > 0)) throw new Error('Cannot build without valid model-stage dimensions.');
  const m = contract.spatialMultiple;
  if (width % m || height % m) throw new Error(`This architecture requires dimensions divisible by ${m}; pad the input before this model.`);
  const dimensions = [1, contract.temporalFrames * 3, height, width];
  input.shape.forEach((dimension, i) => {
    if (typeof dimension === 'number' && dimension > 0 && dimension !== dimensions[i]) throw new Error(`Model input is fixed at ${input.shape.join('×')}; this stage requests ${dimensions.join('×')}. Use matching dimensions or a dynamic ONNX export.`);
  });
  return `${input.name}:${dimensions.join('x')}`;
}
