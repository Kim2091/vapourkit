// electron/modelPrecision.ts
//
// One place that decides what precision a model is meant to be built at, and
// how that decision is spelled in file names.
//
// The graph's I/O type is not that decision: nearly every FP16 and BF16 export
// keeps FP32 inputs and outputs and carries the low precision in its weights,
// so reading the input type alone reports FP32 for models that must be built as
// BF16. An explicit suffix in the model name stays authoritative - that is how
// curated models declare their build precision - and the weights answer for
// everything else.

export type ModelPrecision = 'fp16' | 'bf16' | 'fp32';

// `_bf16`, `-fp32.onnx`, `..._bf16_op20` - a separated token anywhere in the name.
const PRECISION_TOKEN = /(?:^|[-_. ])(fp16|bf16|fp32)(?=$|[-_. ])/gi;

/**
 * The precision a model name declares, if any. The last token wins: an engine
 * built from `foo_fp32.onnx` at FP16 is named `foo_fp32_fp16`.
 */
export function precisionFromName(modelName: string): ModelPrecision | undefined {
  let found: ModelPrecision | undefined;
  let match: RegExpExecArray | null;
  PRECISION_TOKEN.lastIndex = 0;
  while ((match = PRECISION_TOKEN.exec(modelName)) !== null) {
    found = match[1].toLowerCase() as ModelPrecision;
  }
  return found;
}

export function hasPrecisionSuffix(modelName: string): boolean {
  return precisionFromName(modelName) !== undefined;
}

/**
 * Names a build output. Models that already declare their precision keep the
 * name they have, so `foo_bf16.onnx` builds `foo_bf16.engine` rather than
 * `foo_bf16_bf16.engine` - a doubled suffix leaves the ONNX looking
 * uninitialized forever, since that scan pairs `<name>.onnx` with
 * `<name>.engine`.
 */
export function withPrecisionSuffix(modelName: string, precision: ModelPrecision): string {
  return hasPrecisionSuffix(modelName) ? modelName : `${modelName}_${precision}`;
}

export function precisionOf(useFp32?: boolean, useBf16?: boolean): ModelPrecision {
  return useFp32 ? 'fp32' : useBf16 ? 'bf16' : 'fp16';
}

/**
 * Resolves the build precision from everything known about a model. Returns
 * undefined when nothing in the name or the graph says - callers keep whatever
 * the user selected in that case.
 */
export function resolveModelPrecision(source: {
  modelName?: string;
  weightDataTypes?: readonly string[];
  inputDataType?: string;
}): ModelPrecision | undefined {
  const declared = source.modelName ? precisionFromName(source.modelName) : undefined;
  if (declared) {
    return declared;
  }

  const weights = source.weightDataTypes ?? [];
  if (weights.includes('bfloat16')) {
    return 'bf16';
  }
  if (weights.includes('float16')) {
    return 'fp16';
  }

  switch (source.inputDataType?.toLowerCase()) {
    case 'bfloat16':
      return 'bf16';
    case 'float16':
      return 'fp16';
    case 'float32':
      return 'fp32';
    default:
      return undefined;
  }
}
