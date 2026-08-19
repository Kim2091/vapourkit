// electron/modelValidator.ts
import * as fs from 'fs-extra';
import * as path from 'path';
import { logger } from './logger';
import { inspectOnnxGraph, type OnnxGraphInfo } from './onnxGraphInspector';
import { resolveModelPrecision, precisionFromName, type ModelPrecision } from './modelPrecision';

export interface OnnxModelInfo {
  isValid: boolean;
  error?: string;
  inputShape?: number[];
  outputShape?: number[];
  inputName?: string;
  isStatic?: boolean;
  inputDataType?: string;
  /** Build precision resolved from the model name and its weights. */
  precision?: ModelPrecision;
  /**
   * Set when the model is a valid ONNX graph that ONNX Runtime itself refuses
   * to load - BF16 graphs, mainly. Backends that build an engine from the ONNX
   * do not care; backends that run it through ONNX Runtime cannot use it.
   */
  runtimeError?: string;
}

export class ModelValidator {
  /**
   * Validates that a file is a valid ONNX model using ONNX Runtime
   */
  async validateOnnxModel(onnxPath: string): Promise<OnnxModelInfo> {
    logger.model(`Validating ONNX model: ${onnxPath}`);

    const modelName = path.basename(onnxPath, path.extname(onnxPath));

    try {
      if (!await fs.pathExists(onnxPath)) {
        return {
          isValid: false,
          error: 'File does not exist',
          precision: precisionFromName(modelName)
        };
      }

      // Check file size
      const stats = await fs.stat(onnxPath);
      if (stats.size < 100) {
        return {
          isValid: false,
          error: 'File too small to be a valid ONNX model',
          precision: precisionFromName(modelName)
        };
      }

      // Read the graph itself first. ONNX Runtime cannot see BF16 weights (or
      // load a BF16 graph at all), so precision has to come from the file.
      const graph = inspectOnnxGraph(onnxPath);
      const precision = resolveModelPrecision({
        modelName,
        weightDataTypes: graph?.weightDataTypes,
        inputDataType: graph?.inputDataType
      });
      if (graph) {
        logger.model(`Graph weights: ${graph.weightDataTypes.join(', ') || 'none'}`);
        logger.model(`Graph input type: ${graph.inputDataType || 'unknown'}`);
      }
      logger.model(`Build precision: ${precision ? precision.toUpperCase() : 'undetermined'}`);

      // Try to load the model with ONNX Runtime
      try {
        const ort = require('onnxruntime-node');
        
        // Set logger severity to verbose
        // ort.env.logLevel = 'verbose';
        
        logger.model('Loading model with ONNX Runtime...');
        const session = await ort.InferenceSession.create(onnxPath);
        
        // Get input/output metadata
        const inputNames = session.inputNames;
        const outputNames = session.outputNames;
        
        logger.model(`Model loaded successfully`);
        logger.model(`Inputs: ${inputNames.join(', ')}`);
        logger.model(`Outputs: ${outputNames.join(', ')}`);
        
        // Try to get input shape and data type if available
        let inputShape: number[] | undefined;
        let outputShape: number[] | undefined;
        let inputDataType: string | undefined;

        try {
          if (inputNames.length > 0) {
            // Access via handler (internal API used by onnxruntime-node)
            const handler = (session as any).handler;
            if (handler && handler.inputMetadata && Array.isArray(handler.inputMetadata) && handler.inputMetadata.length > 0) {
              const firstInput = handler.inputMetadata[0];
              // The shape is in the 'shape' property, not 'dims'
              if (firstInput && firstInput.shape) {
                inputShape = firstInput.shape;
                logger.model(`Input shape: ${inputShape!.join('x')}`);
              }
              // Extract data type from metadata ('type' field contains strings like 'float32', 'float16')
              if (firstInput && (firstInput.type || firstInput.dataType)) {
                inputDataType = firstInput.type || firstInput.dataType;
                logger.model(`Input data type: ${inputDataType}`);
              }
            }

            // Also try to get output shape
            if (handler && handler.outputMetadata && Array.isArray(handler.outputMetadata) && handler.outputMetadata.length > 0) {
              const firstOutput = handler.outputMetadata[0];
              if (firstOutput && firstOutput.shape) {
                outputShape = firstOutput.shape;
                logger.model(`Output shape: ${outputShape!.join('x')}`);
              }
            }
          }
        } catch (shapeError) {
          logger.model(`Could not extract shape information: ${shapeError}`);
        }
        
        // Get input name (defaults to 'input' if not found)
        const inputName = inputNames.length > 0 ? inputNames[0] : 'input';
        logger.model(`Input name: ${inputName}`);
        
        // Debug: log detailed shape info to understand the data types
        if (inputShape) {
          logger.model(`Input shape raw values: ${JSON.stringify(inputShape)}`);
          logger.model(`Input shape types: ${inputShape.map(dim => typeof dim).join(', ')}`);
        }
        
        // Check if the model is static (all input dimensions are fixed positive values)
        // ONNX Runtime may return BigInt for dimensions, so we need to handle that
        // Dynamic dimensions are typically represented as -1, 0, or symbolic strings
        const isStatic = inputShape !== undefined && 
          inputShape.length >= 4 && 
          inputShape.every(dim => {
            // Handle BigInt (common in ONNX Runtime)
            if (typeof dim === 'bigint') {
              return dim > 0n;
            }
            // Handle regular numbers
            if (typeof dim === 'number') {
              return Number.isInteger(dim) && dim > 0;
            }
            // Strings or other types indicate dynamic dimensions
            return false;
          });
        logger.model(`Model type: ${isStatic ? 'Static' : 'Dynamic'}`);
        logger.model('ONNX model validation passed');
        
        return {
          isValid: true,
          inputShape,
          outputShape,
          inputName,
          isStatic,
          inputDataType,
          precision
        };

      } catch (ortError: any) {
        // A graph ONNX Runtime rejects is not necessarily a broken model: it
        // refuses every bfloat16 graph. If the file parsed as ONNX, trust it
        // and answer from the graph instead.
        if (graph) {
          const runtimeError = ortError.message || 'Could not load model with ONNX Runtime';
          logger.model(`ONNX Runtime could not load the model (${runtimeError}); using the graph read from the file`);
          return { isValid: true, ...graphModelInfo(graph), precision, runtimeError };
        }
        logger.error('ONNX Runtime validation failed:', ortError);
        return {
          isValid: false,
          error: `Invalid ONNX model: ${ortError.message || 'Could not load model with ONNX Runtime'}`,
          precision
        };
      }

    } catch (error) {
      logger.error('Error validating ONNX model:', error);
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error',
        precision: precisionFromName(modelName)
      };
    }
  }
}

/**
 * Shapes the graph reader's output like ONNX Runtime's. Symbolic dimensions are
 * strings in both, which the shape type has always glossed over.
 */
function graphModelInfo(graph: OnnxGraphInfo): Omit<OnnxModelInfo, 'isValid'> {
  logger.model(`Input name: ${graph.inputName || 'input'}`);
  logger.model(`Input shape: ${graph.inputShape ? graph.inputShape.join('x') : 'unknown'}`);
  logger.model(`Model type: ${graph.isStatic ? 'Static' : 'Dynamic'}`);
  return {
    inputShape: graph.inputShape as number[] | undefined,
    outputShape: graph.outputShape as number[] | undefined,
    inputName: graph.inputName || 'input',
    isStatic: graph.isStatic,
    inputDataType: graph.inputDataType
  };
}