// electron/onnxGraphInspector.ts
//
// Reads an ONNX model's graph metadata - input name/shape/type plus the data
// types of its weights - straight out of the protobuf file.
//
// onnxruntime-node cannot answer this for BF16 models: its data-type table
// stops at uint64 and has no name for bfloat16, and session creation rejects
// any graph holding bfloat16 tensors outright ("This is an invalid model. Type
// Error: Type 'tensor(bfloat16)'"). Those models looked like undetectable FP32
// to the importer, which is how BF16 engines ended up being requested as FP16.
//
// The reader seeks past weight payloads instead of reading them, so inspecting
// a multi-GB model costs a handful of small reads rather than its size in RAM.

import * as fs from 'fs';
import { logger } from './logger';

// Protobuf wire types (only the ones ONNX uses).
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

// ONNX TensorProto.DataType. The names match onnxruntime-node's for every type
// it has a name for, so both sources of truth stay directly comparable.
const DATA_TYPE_NAMES: Record<number, string> = {
  1: 'float32', 2: 'uint8', 3: 'int8', 4: 'uint16', 5: 'int16', 6: 'int32',
  7: 'int64', 8: 'string', 9: 'bool', 10: 'float16', 11: 'float64',
  12: 'uint32', 13: 'uint64', 14: 'complex64', 15: 'complex128',
  16: 'bfloat16', 17: 'float8e4m3fn', 18: 'float8e4m3fnuz', 19: 'float8e5m2',
  20: 'float8e5m2fnuz', 21: 'uint4', 22: 'int4', 23: 'float4e2m1',
};

const FLOAT16 = 10;
const BFLOAT16 = 16;

const READ_CHUNK = 64 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
// Subgraph recursion for attribute-held weights (If/Loop bodies).
const MAX_GRAPH_DEPTH = 3;
// Backstop so a corrupt length cannot turn the deferred node scan into a stall.
const MAX_SCANNED_NODES = 100000;

export interface OnnxGraphInfo {
  inputName?: string;
  /** Symbolic dimensions come back as strings, the way ONNX Runtime reports them. */
  inputShape?: Array<number | string>;
  outputShape?: Array<number | string>;
  inputDataType?: string;
  isStatic: boolean;
  /** Distinct data types found on the graph's weights. */
  weightDataTypes: string[];
}

class OnnxParseError extends Error {}

interface ProtoField {
  field: number;
  wire: number;
  /** Decoded value for varint fields. */
  value: number;
  /** Byte range of the payload for length-delimited fields. */
  start: number;
  end: number;
}

interface TensorTypeInfo {
  dataType?: number;
  shape?: Array<number | string>;
}

/** A seeking byte cursor over the model file; never holds more than one chunk. */
class ProtoReader {
  pos = 0;
  private readonly window = Buffer.allocUnsafe(READ_CHUNK);
  private windowStart = 0;
  private windowEnd = 0;

  constructor(private readonly fd: number, readonly size: number) {}

  private byteAt(pos: number): number {
    if (pos < this.windowStart || pos >= this.windowEnd) {
      if (pos < 0 || pos >= this.size) {
        throw new OnnxParseError('read past end of file');
      }
      const read = fs.readSync(this.fd, this.window, 0, this.window.length, pos);
      if (read === 0) {
        throw new OnnxParseError('read past end of file');
      }
      this.windowStart = pos;
      this.windowEnd = pos + read;
    }
    return this.window[pos - this.windowStart];
  }

  readVarint(): number {
    let result = 0;
    let scale = 1;
    // Ten bytes is the longest legal 64-bit varint.
    for (let index = 0; index < 10; index++) {
      const byte = this.byteAt(this.pos++);
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        return result;
      }
      scale *= 128;
    }
    throw new OnnxParseError('malformed varint');
  }

  readString(start: number, end: number): string {
    const length = end - start;
    if (length < 0 || length > MAX_STRING_BYTES) {
      throw new OnnxParseError('implausible string length');
    }
    if (length === 0) {
      return '';
    }
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(this.fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  }
}

/**
 * Walks the fields of one message. Visitors may move the cursor while reading a
 * length-delimited payload; it is restored to the end of that field afterwards.
 */
function eachField(reader: ProtoReader, end: number, visit: (field: ProtoField) => void): void {
  while (reader.pos < end) {
    const keyStart = reader.pos;
    const key = reader.readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;

    if (wire === WIRE_VARINT) {
      visit({ field, wire, value: reader.readVarint(), start: 0, end: 0 });
    } else if (wire === WIRE_LENGTH) {
      const length = reader.readVarint();
      const payloadStart = reader.pos;
      const payloadEnd = payloadStart + length;
      if (payloadEnd > end) {
        throw new OnnxParseError(`field ${field} at ${keyStart} runs past its parent message`);
      }
      visit({ field, wire, value: 0, start: payloadStart, end: payloadEnd });
      reader.pos = payloadEnd;
    } else if (wire === WIRE_FIXED64) {
      reader.pos += 8;
    } else if (wire === WIRE_FIXED32) {
      reader.pos += 4;
    } else {
      throw new OnnxParseError(`unsupported wire type ${wire}`);
    }
  }
  reader.pos = end;
}

/** TensorProto.data_type, without touching the weight payload that follows it. */
function tensorDataType(reader: ProtoReader, start: number, end: number): number | undefined {
  let dataType: number | undefined;
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.field === 2 && field.wire === WIRE_VARINT) {
      dataType = field.value;
    }
  });
  return dataType;
}

function tensorShape(reader: ProtoReader, start: number, end: number): Array<number | string> {
  const dims: Array<number | string> = [];
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.field !== 1 || field.wire !== WIRE_LENGTH) {
      return; // TensorShapeProto.dim
    }
    // An empty Dimension is a dynamic dimension with no name.
    let dim: number | string = '';
    reader.pos = field.start;
    eachField(reader, field.end, (member) => {
      if (member.field === 1 && member.wire === WIRE_VARINT) {
        dim = member.value; // dim_value
      } else if (member.field === 2 && member.wire === WIRE_LENGTH) {
        dim = reader.readString(member.start, member.end); // dim_param
      }
    });
    dims.push(dim);
  });
  return dims;
}

function tensorTypeInfo(reader: ProtoReader, start: number, end: number): TensorTypeInfo {
  const info: TensorTypeInfo = {};
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.field === 1 && field.wire === WIRE_VARINT) {
      info.dataType = field.value; // elem_type
    } else if (field.field === 2 && field.wire === WIRE_LENGTH) {
      info.shape = tensorShape(reader, field.start, field.end);
    }
  });
  return info;
}

function valueInfo(reader: ProtoReader, start: number, end: number): { name?: string; type: TensorTypeInfo } {
  let name: string | undefined;
  let type: TensorTypeInfo = {};
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.field === 1 && field.wire === WIRE_LENGTH) {
      name = reader.readString(field.start, field.end);
    } else if (field.field === 2 && field.wire === WIRE_LENGTH) {
      reader.pos = field.start;
      eachField(reader, field.end, (typeField) => {
        if (typeField.field === 1 && typeField.wire === WIRE_LENGTH) {
          type = tensorTypeInfo(reader, typeField.start, typeField.end); // TypeProto.tensor_type
        }
      });
    }
  });
  return { name, type };
}

function hasLowPrecision(dataTypes: Set<number>): boolean {
  return dataTypes.has(BFLOAT16) || dataTypes.has(FLOAT16);
}

/** Weights parked in Constant/attribute tensors rather than graph initializers. */
function scanNodeTensors(
  reader: ProtoReader,
  start: number,
  end: number,
  found: Set<number>,
  depth: number,
): void {
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.field !== 5 || field.wire !== WIRE_LENGTH) {
      return; // NodeProto.attribute
    }
    reader.pos = field.start;
    eachField(reader, field.end, (attribute) => {
      if (attribute.wire !== WIRE_LENGTH) {
        return;
      }
      if (attribute.field === 5 || attribute.field === 10) {
        const dataType = tensorDataType(reader, attribute.start, attribute.end); // t / tensors
        if (dataType !== undefined) {
          found.add(dataType);
        }
      } else if ((attribute.field === 6 || attribute.field === 11) && depth < MAX_GRAPH_DEPTH) {
        scanSubgraph(reader, attribute.start, attribute.end, found, depth + 1); // g / graphs
      }
    });
  });
}

function scanSubgraph(
  reader: ProtoReader,
  start: number,
  end: number,
  found: Set<number>,
  depth: number,
): void {
  reader.pos = start;
  eachField(reader, end, (field) => {
    if (field.wire !== WIRE_LENGTH) {
      return;
    }
    if (field.field === 5) {
      const dataType = tensorDataType(reader, field.start, field.end); // initializer
      if (dataType !== undefined) {
        found.add(dataType);
      }
    } else if (field.field === 1) {
      scanNodeTensors(reader, field.start, field.end, found, depth); // node
    }
  });
}

function dataTypeName(dataType: number): string {
  return DATA_TYPE_NAMES[dataType] ?? `type${dataType}`;
}

/**
 * Returns the graph metadata, or null when the file is not a readable ONNX
 * model. Callers treat null as "no information", never as "invalid model".
 */
export function inspectOnnxGraph(onnxPath: string): OnnxGraphInfo | null {
  let fd: number | undefined;
  try {
    const { size } = fs.statSync(onnxPath);
    fd = fs.openSync(onnxPath, 'r');
    const reader = new ProtoReader(fd, size);

    let graphStart: number | undefined;
    let graphEnd = 0;
    eachField(reader, size, (field) => {
      if (field.field === 7 && field.wire === WIRE_LENGTH) {
        graphStart = field.start; // ModelProto.graph
        graphEnd = field.end;
      }
    });
    if (graphStart === undefined) {
      return null;
    }

    const weightTypes = new Set<number>();
    const nodeRanges: Array<[number, number]> = [];
    let input: { name?: string; type: TensorTypeInfo } | undefined;
    let outputShape: Array<number | string> | undefined;

    // Serialization follows field order, so the weights come before the graph
    // inputs in the byte stream; both are reached by seeking, not by reading.
    reader.pos = graphStart;
    eachField(reader, graphEnd, (field) => {
      if (field.wire !== WIRE_LENGTH) {
        return;
      }
      if (field.field === 5) {
        const dataType = tensorDataType(reader, field.start, field.end); // initializer
        if (dataType !== undefined) {
          weightTypes.add(dataType);
        }
      } else if (field.field === 11 && !input) {
        input = valueInfo(reader, field.start, field.end); // input
      } else if (field.field === 12 && !outputShape) {
        outputShape = valueInfo(reader, field.start, field.end).type.shape; // output
      } else if (field.field === 1 && nodeRanges.length < MAX_SCANNED_NODES) {
        nodeRanges.push([field.start, field.end]); // node, scanned below only if needed
      }
    });

    if (!hasLowPrecision(weightTypes)) {
      for (const [start, end] of nodeRanges) {
        scanNodeTensors(reader, start, end, weightTypes, 0);
        if (hasLowPrecision(weightTypes)) {
          break;
        }
      }
    }

    const inputShape = input?.type.shape;
    const inputDataType = input?.type.dataType;
    return {
      inputName: input?.name,
      inputShape,
      outputShape,
      inputDataType: inputDataType === undefined ? undefined : dataTypeName(inputDataType),
      isStatic: inputShape !== undefined
        && inputShape.length >= 4
        && inputShape.every(dim => typeof dim === 'number' && Number.isInteger(dim) && dim > 0),
      weightDataTypes: [...weightTypes].map(dataTypeName),
    };
  } catch (error) {
    logger.model(`Could not read the ONNX graph directly: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}
