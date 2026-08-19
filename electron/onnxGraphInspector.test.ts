import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), model: vi.fn() },
}));

import { inspectOnnxGraph } from './onnxGraphInspector';

const testRoot = path.join(os.tmpdir(), `vk-onnx-inspector-test-${process.pid}`);

// Minimal protobuf writer, enough to build the ONNX messages under test.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function message(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

function stringField(field: number, value: string): Buffer {
  return message(field, Buffer.from(value, 'utf8'));
}

const FLOAT32 = 1;
const FLOAT16 = 10;
const INT64 = 7;
const BFLOAT16 = 16;

/** TensorShapeProto.Dimension: a number is dim_value, a string is dim_param. */
function dimension(dim: number | string): Buffer {
  return message(1, typeof dim === 'number' ? varintField(1, dim) : stringField(2, dim));
}

function valueInfo(name: string, dataType: number, dims: Array<number | string>): Buffer {
  const shape = message(2, Buffer.concat(dims.map(dimension)));
  // TypeProto { tensor_type: Tensor { elem_type, shape } }
  const typeProto = message(1, Buffer.concat([varintField(1, dataType), shape]));
  return Buffer.concat([stringField(1, name), message(2, typeProto)]);
}

function initializer(name: string, dataType: number, rawDataBytes: number): Buffer {
  return message(5, Buffer.concat([
    varintField(1, 8), // dims
    varintField(2, dataType), // data_type
    stringField(8, name),
    message(9, Buffer.alloc(rawDataBytes, 0x7f)), // raw_data
  ]));
}

/** A Constant node holding its weights in an attribute tensor. */
function constantNode(name: string, dataType: number, rawDataBytes: number): Buffer {
  const tensor = Buffer.concat([
    varintField(2, dataType),
    message(9, Buffer.alloc(rawDataBytes, 0x11)),
  ]);
  const attribute = message(5, Buffer.concat([
    stringField(1, 'value'),
    message(5, tensor), // AttributeProto.t
  ]));
  return message(1, Buffer.concat([
    stringField(2, `${name}_out`), // output
    stringField(3, name),
    stringField(4, 'Constant'),
    attribute,
  ]));
}

interface ModelParts {
  inputType?: number;
  inputDims?: Array<number | string>;
  outputDims?: Array<number | string>;
  initializers?: Buffer[];
  nodes?: Buffer[];
}

function writeModel(fileName: string, parts: ModelParts): string {
  const {
    inputType = FLOAT32,
    inputDims = ['batch', 3, 'height', 'width'],
    outputDims = ['batch', 3, 'height2', 'width2'],
    initializers = [],
    nodes = [],
  } = parts;

  const graph = Buffer.concat([
    ...nodes,
    stringField(2, 'test_graph'),
    ...initializers,
    message(11, valueInfo('input', inputType, inputDims)),
    message(12, valueInfo('output', inputType, outputDims)),
  ]);
  const model = Buffer.concat([
    varintField(1, 10), // ir_version
    stringField(2, 'vapourkit-test'),
    message(7, graph),
  ]);

  const filePath = path.join(testRoot, fileName);
  fs.writeFileSync(filePath, model);
  return filePath;
}

beforeAll(async () => {
  await fs.ensureDir(testRoot);
});

afterAll(async () => {
  await fs.remove(testRoot);
});

describe('inspectOnnxGraph', () => {
  it('reads the input name, shape and type', () => {
    const info = inspectOnnxGraph(writeModel('dynamic.onnx', {}));

    expect(info).not.toBeNull();
    expect(info!.inputName).toBe('input');
    expect(info!.inputShape).toEqual(['batch', 3, 'height', 'width']);
    expect(info!.inputDataType).toBe('float32');
    expect(info!.isStatic).toBe(false);
  });

  it('reports a fully fixed input shape as static', () => {
    const info = inspectOnnxGraph(writeModel('static.onnx', {
      inputDims: [1, 3, 540, 720],
      outputDims: [1, 3, 1080, 1440],
    }));

    expect(info!.inputShape).toEqual([1, 3, 540, 720]);
    expect(info!.isStatic).toBe(true);
    expect(info!.outputShape).toEqual([1, 3, 1080, 1440]);
  });

  it('finds BF16 weights behind FP32 inputs - the case ONNX Runtime cannot see', () => {
    const info = inspectOnnxGraph(writeModel('bf16.onnx', {
      inputType: FLOAT32,
      initializers: [
        initializer('conv.weight', BFLOAT16, 4096),
        initializer('shape', INT64, 32),
      ],
    }));

    expect(info!.inputDataType).toBe('float32');
    expect(info!.weightDataTypes).toContain('bfloat16');
    expect(info!.weightDataTypes).toContain('int64');
  });

  it('finds weights held in Constant node attributes', () => {
    const info = inspectOnnxGraph(writeModel('constant-weights.onnx', {
      nodes: [constantNode('weights', BFLOAT16, 2048)],
    }));

    expect(info!.weightDataTypes).toContain('bfloat16');
  });

  it('skips the node scan once the initializers have answered', () => {
    const info = inspectOnnxGraph(writeModel('fp16.onnx', {
      initializers: [initializer('conv.weight', FLOAT16, 1024)],
      nodes: [constantNode('unrelated', BFLOAT16, 64)],
    }));

    expect(info!.weightDataTypes).toContain('float16');
    expect(info!.weightDataTypes).not.toContain('bfloat16');
  });

  it('seeks past weight payloads instead of reading them', () => {
    // 24 MB of weights; the reader should touch only a few KB of it
    const filePath = writeModel('large.onnx', {
      initializers: [initializer('conv.weight', BFLOAT16, 24 * 1024 * 1024)],
    });

    const before = process.memoryUsage().heapUsed;
    const info = inspectOnnxGraph(filePath);
    const heapGrowth = process.memoryUsage().heapUsed - before;

    expect(info!.weightDataTypes).toContain('bfloat16');
    expect(info!.inputName).toBe('input');
    expect(heapGrowth).toBeLessThan(4 * 1024 * 1024);
  });

  it('returns null for a file that is not an ONNX model', () => {
    const filePath = path.join(testRoot, 'garbage.onnx');
    fs.writeFileSync(filePath, Buffer.from('this is not a protobuf at all, sorry', 'utf8'));

    expect(inspectOnnxGraph(filePath)).toBeNull();
    expect(inspectOnnxGraph(path.join(testRoot, 'missing.onnx'))).toBeNull();
  });

  it('returns null when the protobuf parses but holds no graph', () => {
    const filePath = path.join(testRoot, 'no-graph.onnx');
    fs.writeFileSync(filePath, Buffer.concat([varintField(1, 10), stringField(2, 'vapourkit-test')]));

    expect(inspectOnnxGraph(filePath)).toBeNull();
  });
});
