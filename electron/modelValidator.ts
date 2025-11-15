// electron/modelValidator.ts
import * as fs from 'fs-extra';
import { logger } from './logger';

export interface OnnxModelInfo {
  isValid: boolean;
  error?: string;
  inputShape?: number[];
  outputShape?: number[];
}

export class ModelValidator {
  /**
   * Validates that a file is a valid ONNX model using ONNX Runtime
   */
  async validateOnnxModel(onnxPath: string): Promise<OnnxModelInfo> {
    logger.model(`Validating ONNX model: ${onnxPath}`);
    
    try {
      if (!await fs.pathExists(onnxPath)) {
        return {
          isValid: false,
          error: 'File does not exist'
        };
      }

      // Check file size
      const stats = await fs.stat(onnxPath);
      if (stats.size < 100) {
        return {
          isValid: false,
          error: 'File too small to be a valid ONNX model'
        };
      }

      // Try to load the model with ONNX Runtime
      try {
        const ort = require('onnxruntime-node');
        
        // Set logger severity to verbose
        ort.env.logLevel = 'verbose';
        
        logger.model('Loading model with ONNX Runtime...');
        const session = await ort.InferenceSession.create(onnxPath);
        
        // Get input/output metadata
        const inputNames = session.inputNames;
        const outputNames = session.outputNames;
        
        logger.model(`Model loaded successfully`);
        logger.model(`Inputs: ${inputNames.join(', ')}`);
        logger.model(`Outputs: ${outputNames.join(', ')}`);
        
        // Try to get input shape if available
        let inputShape: number[] | undefined;
        let outputShape: number[] | undefined;
        
        try {
          if (inputNames.length > 0) {
            const inputMetadata = session.inputMetadata[inputNames[0]];
            inputShape = inputMetadata?.dims as number[];
            logger.model(`Input shape: ${inputShape?.join('x') || 'dynamic'}`);
          }
          
          if (outputNames.length > 0) {
            const outputMetadata = session.outputMetadata[outputNames[0]];
            outputShape = outputMetadata?.dims as number[];
            logger.model(`Output shape: ${outputShape?.join('x') || 'dynamic'}`);
          }
        } catch (shapeError) {
          logger.debug('Could not extract shape information:', shapeError);
        }
        
        logger.model('ONNX model validation passed');
        
        return {
          isValid: true,
          inputShape,
          outputShape
        };
        
      } catch (ortError: any) {
        // If ONNX Runtime fails to load, it's not a valid model
        logger.error('ONNX Runtime validation failed:', ortError);
        return {
          isValid: false,
          error: `Invalid ONNX model: ${ortError.message || 'Could not load model with ONNX Runtime'}`
        };
      }

    } catch (error) {
      logger.error('Error validating ONNX model:', error);
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown validation error'
      };
    }
  }
}