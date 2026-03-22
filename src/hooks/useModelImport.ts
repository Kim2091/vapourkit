import { useState, useEffect, useCallback, useRef } from 'react';
import type { ModelImportProgress } from '../electron.d';
import { notify } from '../utils/notifications';

export interface ImportForm {
  onnxPath: string;
  modelName: string;
  inputName: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  useBf16: boolean;
  modelType: 'vsr' | 'image';
  temporalFrames: number;
  useDirectML: boolean;
  displayTag: string;
  useStaticShape: boolean;
  useCustomTrtexecParams: boolean;
  customTrtexecParams: string;
  skipValidation: boolean;
  detectionFailed: boolean;
}

// Helper function to generate default trtexec command
export const generateTrtexecCommand = (modelType: 'vsr' | 'image', useFp32: boolean, useStaticShape: boolean, inputName: string = 'input', useBf16: boolean = false, temporalFrames: number = 5): string => {
  const channels = modelType === 'vsr' ? String(temporalFrames * 3) : '3';
  // FP32 is the default in trtexec, so only add --fp16/--bf16 flag when NOT using FP32
  // For BF16: use --bf16 flag but keep fp16 format strings
  let precisionFlags = '';
  if (!useFp32) {
    if (useBf16) {
      precisionFlags = '--inputIOFormats=fp16:chw --outputIOFormats=fp16:chw --bf16';
    } else {
      precisionFlags = '--inputIOFormats=fp16:chw --outputIOFormats=fp16:chw --fp16';
    }
  }
  
  if (useStaticShape) {
    // Static shape mode
    return `--shapes=${inputName}:1x${channels}x720x1280 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=3 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
  } else {
    // Dynamic shape mode
    return `--minShapes=${inputName}:1x${channels}x240x240 --optShapes=${inputName}:1x${channels}x720x1280 --maxShapes=${inputName}:1x${channels}x1080x1920 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=3 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
  }
};

const DEFAULT_IMPORT_FORM: ImportForm = {
  onnxPath: '',
  modelName: '',
  inputName: 'input',
  minShapes: 'input:1x3x240x240',
  optShapes: 'input:1x3x480x640',
  maxShapes: 'input:1x3x1080x1920',
  useFp32: false,
  useBf16: false,
  modelType: 'image',
  temporalFrames: 5,
  useDirectML: false,
  displayTag: '',
  useStaticShape: false,
  useCustomTrtexecParams: true, // Always true in refactored UI - the textbox is the main interface
  customTrtexecParams: generateTrtexecCommand('image', false, false, 'input', false),
  skipValidation: false,
  detectionFailed: false
};

export const useModelImport = (
  useDirectML: boolean,
  onImportComplete: (enginePath?: string) => void,
  addConsoleLog: (message: string) => void
) => {
  const [showImportModal, setShowImportModal] = useState(false);
  const [modalMode, setModalMode] = useState<'import' | 'build'>('import');
  const [importProgress, setImportProgress] = useState<ModelImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importForm, setImportForm] = useState<ImportForm>(DEFAULT_IMPORT_FORM);
  // Ref to access skipValidation inside callbacks without re-creating them
  const skipValidationRef = useRef(importForm.skipValidation);
  skipValidationRef.current = importForm.skipValidation;

  // Auto-build modal state
  const [showAutoBuildModal, setShowAutoBuildModal] = useState(false);
  const [autoBuildModelName, setAutoBuildModelName] = useState('');
  const [autoBuildModelType, setAutoBuildModelType] = useState<'vsr' | 'image'>('image');
  const [autoBuildIsStatic, setAutoBuildIsStatic] = useState(false);
  const [autoBuildStaticShape, setAutoBuildStaticShape] = useState<string | null>(null);
  // Guard to ensure completion handlers run only once per import/build
  const completionGuardRef = useRef(false);

  // Update import form when DirectML setting changes
  useEffect(() => {
    setImportForm(prev => ({ ...prev, useDirectML }));
  }, [useDirectML]);

  const handleSelectOnnxFile = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.selectOnnxFile();
      if (result) {
        // Extract filename without extension for auto-fill
        const filename = result.split(/[\\/]/).pop() || '';
        const modelName = filename.replace(/\.onnx$/i, '');
        
        // Validate the model to extract input name and detect properties
        let extractedInputName = 'input'; // Default fallback
        let detectedIsStatic = false;
        let detectedShape: number[] | undefined;
        let detectedModelType: 'vsr' | 'image' | undefined;
        let detectedTemporalFrames: number | undefined;
        let detectedPrecision: 'fp16' | 'bf16' | 'fp32' | undefined;
        let detectionFailed = false;

        if (skipValidationRef.current) {
          addConsoleLog(`[Model] Skipping ONNX auto-detection (skip validation enabled)`);
        } else {
        try {
          const validation = await window.electronAPI.validateOnnxModel(result);
          if (!validation.isValid) {
            detectionFailed = true;
          }
          if (validation.isValid && validation.inputName) {
            extractedInputName = validation.inputName;
            addConsoleLog(`[Model] Detected input name: ${extractedInputName}`);
          }
          if (validation.isValid && validation.inputShape) {
            if (validation.isStatic) {
              detectedIsStatic = true;
              detectedShape = validation.inputShape;
              addConsoleLog(`[Model] Detected static model with shape: ${detectedShape.join('x')}`);
            } else {
              addConsoleLog(`[Model] Detected dynamic model`);
            }
          }
          // Auto-detect VSR model type and temporal frames from channel count
          if (validation.isValid && validation.inputShape && validation.inputShape.length >= 4) {
            const inputChannels = validation.inputShape[1];
            if (inputChannels > 3 && inputChannels % 3 === 0) {
              detectedModelType = 'vsr';
              detectedTemporalFrames = inputChannels / 3;
              addConsoleLog(`[Model] Detected VSR model with ${detectedTemporalFrames} temporal frames (${inputChannels} channels)`);
            } else if (inputChannels === 3) {
              detectedModelType = 'image';
              addConsoleLog(`[Model] Detected image model (3 channels)`);
            }
          }
          // Auto-detect precision from input data type
          if (validation.isValid && validation.inputDataType) {
            const dt = validation.inputDataType.toLowerCase();
            if (dt === 'float16') {
              detectedPrecision = 'fp16';
              addConsoleLog(`[Model] Detected FP16 precision`);
            } else if (dt === 'bfloat16') {
              detectedPrecision = 'bf16';
              addConsoleLog(`[Model] Detected BF16 precision`);
            } else if (dt === 'float32') {
              detectedPrecision = 'fp32';
              addConsoleLog(`[Model] Detected FP32 precision`);
            }
          }
        } catch (validationError) {
          console.warn('Could not validate ONNX model:', validationError);
          detectionFailed = true;
        }
        }

        addConsoleLog(`[Model] Setting form - detectedIsStatic: ${detectedIsStatic}, detectedShape: ${detectedShape ? detectedShape.join('x') : 'none'}`);

        setImportForm(prev => {
          // Apply detected values, falling back to current form state
          const useStatic = detectedIsStatic;
          const modelType = detectedModelType ?? prev.modelType;
          const temporalFrames = detectedTemporalFrames ?? prev.temporalFrames;
          const useFp32 = detectedPrecision === 'fp32' ? true : detectedPrecision ? false : prev.useFp32;
          const useBf16 = detectedPrecision === 'bf16' ? true : detectedPrecision ? false : prev.useBf16;
          const channels = modelType === 'vsr' ? String(temporalFrames * 3) : '3';

          addConsoleLog(`[Model] Form update - useStatic: ${useStatic}, channels: ${channels}`);

          // Build optShapes based on detected shape or defaults
          let optShapes: string;
          if (useStatic && detectedShape && detectedShape.length >= 4) {
            // Use the detected static shape: [batch, channels, height, width]
            optShapes = `${extractedInputName}:${detectedShape.join('x')}`;
          } else if (useStatic) {
            optShapes = `${extractedInputName}:1x${channels}x480x640`;
          } else {
            optShapes = `${extractedInputName}:1x${channels}x720x1280`;
          }

          let newCommand = generateTrtexecCommand(modelType, useFp32, useStatic, extractedInputName, useBf16, temporalFrames);

          // If static model with detected shape, update the command to use the actual detected shape
          if (useStatic && detectedShape && detectedShape.length >= 4) {
            const detectedShapeStr = detectedShape.join('x');
            addConsoleLog(`[Model] Updating command with detected shape: ${detectedShapeStr}`);
            // Replace the default shape with the detected shape
            newCommand = newCommand.replace(
              `--shapes=${extractedInputName}:1x${channels}x720x1280`,
              `--shapes=${extractedInputName}:${detectedShapeStr}`
            );
          }

          const finalForm = {
            ...prev,
            onnxPath: result,
            modelName: modelName,
            inputName: extractedInputName,
            modelType,
            temporalFrames,
            useFp32,
            useBf16,
            useStaticShape: useStatic,
            customTrtexecParams: newCommand,
            minShapes: `${extractedInputName}:1x${channels}x240x240`,
            optShapes,
            maxShapes: `${extractedInputName}:1x${channels}x1080x1920`,
            detectionFailed,
          };

          addConsoleLog(`[Model] Final form - useStaticShape: ${finalForm.useStaticShape}, optShapes: ${finalForm.optShapes}`);

          return finalForm;
        });
      }
    } catch (error) {
      console.error('Error selecting ONNX file:', error);
    }
  }, [addConsoleLog]);

  const handleFp32Change = useCallback((useFp32: boolean): void => {
    setImportForm(prev => {
      const newCommand = generateTrtexecCommand(prev.modelType, useFp32, prev.useStaticShape, prev.inputName, prev.useBf16, prev.temporalFrames);
      return {
        ...prev,
        useFp32,
        customTrtexecParams: newCommand,
      };
    });
  }, []);

  const handlePrecisionChange = useCallback((precision: 'fp16' | 'bf16' | 'fp32'): void => {
    setImportForm(prev => {
      const useFp32 = precision === 'fp32';
      const useBf16 = precision === 'bf16';
      const newCommand = generateTrtexecCommand(prev.modelType, useFp32, prev.useStaticShape, prev.inputName, useBf16, prev.temporalFrames);
      return {
        ...prev,
        useFp32,
        useBf16,
        customTrtexecParams: newCommand,
      };
    });
  }, []);

  const handleModelTypeChange = useCallback((modelType: 'vsr' | 'image'): void => {
    setImportForm(prev => {
      const useStatic = prev.useStaticShape;
      const inputName = prev.inputName;
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStatic, inputName, prev.useBf16, prev.temporalFrames);
      const channels = modelType === 'vsr' ? String(prev.temporalFrames * 3) : '3';
      return {
        ...prev,
        modelType,
        customTrtexecParams: newCommand,
        minShapes: `${inputName}:1x${channels}x240x240`,
        optShapes: useStatic 
          ? `${inputName}:1x${channels}x480x640` 
          : `${inputName}:1x${channels}x720x1280`,
        maxShapes: `${inputName}:1x${channels}x1080x1920`,
      };
    });
  }, []);

  const handleShapeModeChange = useCallback((useStaticShape: boolean): void => {
    setImportForm(prev => {
      const modelType = prev.modelType;
      const inputName = prev.inputName;
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStaticShape, inputName, prev.useBf16, prev.temporalFrames);
      const channels = modelType === 'vsr' ? String(prev.temporalFrames * 3) : '3';
      return {
        ...prev,
        useStaticShape,
        customTrtexecParams: newCommand,
        optShapes: useStaticShape 
          ? `${inputName}:1x${channels}x480x640` 
          : `${inputName}:1x${channels}x720x1280`,
      };
    });
  }, []);

  const handleTemporalFramesChange = useCallback((temporalFrames: number): void => {
    setImportForm(prev => {
      const channels = String(temporalFrames * 3);
      const inputName = prev.inputName;
      const newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, prev.useStaticShape, inputName, prev.useBf16, temporalFrames);
      return {
        ...prev,
        temporalFrames,
        customTrtexecParams: newCommand,
        minShapes: `${inputName}:1x${channels}x240x240`,
        optShapes: prev.useStaticShape
          ? `${inputName}:1x${channels}x480x640`
          : `${inputName}:1x${channels}x720x1280`,
        maxShapes: `${inputName}:1x${channels}x1080x1920`,
      };
    });
  }, []);

  const handleImportModel = useCallback(async (): Promise<void> => {
    if (!importForm.onnxPath || !importForm.modelName) return;

    setIsImporting(true);
    // Reset completion guard at the start of a new import/build
    completionGuardRef.current = false;
    try {
      if (modalMode === 'build') {
        await window.electronAPI.initializeModel({
          onnxPath: importForm.onnxPath,
          modelName: importForm.modelName,
          minShapes: importForm.minShapes,
          optShapes: importForm.optShapes,
          maxShapes: importForm.maxShapes,
          useFp32: importForm.useFp32,
          useBf16: importForm.useBf16,
          modelType: importForm.modelType,
          temporalFrames: importForm.modelType === 'vsr' ? importForm.temporalFrames : undefined,
          displayTag: importForm.displayTag || undefined,
          useStaticShape: importForm.useStaticShape,
          useCustomTrtexecParams: importForm.useCustomTrtexecParams,
          customTrtexecParams: importForm.customTrtexecParams || undefined,
        });
      } else {
        await window.electronAPI.importCustomModel({
          onnxPath: importForm.onnxPath,
          modelName: importForm.modelName,
          minShapes: importForm.minShapes,
          optShapes: importForm.optShapes,
          maxShapes: importForm.maxShapes,
          useFp32: importForm.useFp32,
          useBf16: importForm.useBf16,
          modelType: importForm.modelType,
          temporalFrames: importForm.modelType === 'vsr' ? importForm.temporalFrames : undefined,
          useDirectML: importForm.useDirectML,
          displayTag: importForm.displayTag || undefined,
          useStaticShape: importForm.useStaticShape,
          useCustomTrtexecParams: importForm.useCustomTrtexecParams,
          customTrtexecParams: importForm.customTrtexecParams || undefined,
          skipValidation: importForm.skipValidation,
        });
      }
    } catch (error) {
      console.error('Error importing model:', error);
      setIsImporting(false);
    }
  }, [importForm, modalMode]);

  const handleCancelBuild = useCallback(async (): Promise<void> => {
    try {
      addConsoleLog('[Model] Cancelling build...');
      await window.electronAPI.cancelModelImport();
      setIsImporting(false);
      setImportProgress(null);
      addConsoleLog('[Model] Build cancelled');
    } catch (error) {
      console.error('Error cancelling build:', error);
    }
  }, [addConsoleLog]);

  const resetImportForm = useCallback((): void => {
    setImportForm({ ...DEFAULT_IMPORT_FORM, useDirectML });
  }, [useDirectML]);

  const handleAutoBuildModel = useCallback(async (model: { onnxPath: string; name: string; modelType?: string; displayTag?: string }): Promise<void> => {
    // Use existing metadata from ONNX model if available
    const modelType = model.modelType || 'image';
    const displayTag = model.displayTag || '';
    
    // Extract input name and detect properties from the model
    let inputName = 'input'; // Default fallback
    let isStaticModel = false;
    let detectedShape: number[] | undefined;
    let temporalFrames = 5; // Default
    let useFp32 = false;
    try {
      const validation = await window.electronAPI.validateOnnxModel(model.onnxPath);
      if (validation.isValid && validation.inputName) {
        inputName = validation.inputName;
      }
      // Detect if this is a static model
      if (validation.isValid && validation.isStatic && validation.inputShape) {
        isStaticModel = true;
        detectedShape = validation.inputShape;
        addConsoleLog(`[Auto-Build] Detected static model with shape: ${detectedShape.join('x')}`);
      }
      // Auto-detect temporal frames from channel count
      if (validation.isValid && validation.inputShape && validation.inputShape.length >= 4) {
        const inputChannels = validation.inputShape[1];
        if (inputChannels > 3 && inputChannels % 3 === 0) {
          temporalFrames = inputChannels / 3;
          addConsoleLog(`[Auto-Build] Detected ${temporalFrames} temporal frames (${inputChannels} channels)`);
        }
      }
      // Auto-detect precision
      if (validation.isValid && validation.inputDataType) {
        const dt = validation.inputDataType.toLowerCase();
        if (dt === 'float32') {
          useFp32 = true;
          addConsoleLog(`[Auto-Build] Detected FP32 precision`);
        } else {
          addConsoleLog(`[Auto-Build] Detected ${dt} precision`);
        }
      }
    } catch (validationError) {
      console.warn('Could not validate ONNX model for auto-build:', validationError);
    }

    // Set shapes based on whether model is static or dynamic
    const isVideoModel = modelType === 'vsr';
    const channels = isVideoModel ? String(temporalFrames * 3) : '3';
    
    let minShapes: string;
    let optShapes: string;
    let maxShapes: string;
    
    if (isStaticModel && detectedShape && detectedShape.length >= 4) {
      // Static model: use the detected shape for all shape params
      const shapeStr = detectedShape.join('x');
      minShapes = `${inputName}:${shapeStr}`;
      optShapes = `${inputName}:${shapeStr}`;
      maxShapes = `${inputName}:${shapeStr}`;
      addConsoleLog(`[Auto-Build] Using static shape mode with shape: ${shapeStr}`);
    } else {
      // Dynamic model: use default dynamic shape range
      minShapes = `${inputName}:1x${channels}x240x240`;
      optShapes = `${inputName}:1x${channels}x720x1280`;
      maxShapes = `${inputName}:1x${channels}x1080x1920`;
    }
    
    // Show auto-build modal with model info
    setAutoBuildModelName(model.name);
    setAutoBuildModelType(modelType as 'vsr' | 'image');
    setAutoBuildIsStatic(isStaticModel);
    setAutoBuildStaticShape(isStaticModel && detectedShape ? detectedShape.join('x') : null);
    setShowAutoBuildModal(true);
    setIsImporting(true);
    completionGuardRef.current = false;
    
    try {
      await window.electronAPI.initializeModel({
        onnxPath: model.onnxPath,
        modelName: model.name,
        minShapes,
        optShapes,
        maxShapes,
        useFp32,
        modelType: modelType as 'vsr' | 'image',
        temporalFrames: modelType === 'vsr' ? temporalFrames : undefined,
        displayTag: displayTag || undefined,
        useStaticShape: isStaticModel,
      });
    } catch (error) {
      console.error('Error auto-building model:', error);
      setIsImporting(false);
      setShowAutoBuildModal(false);
    }
  }, [addConsoleLog]);

  // Listen for model import/build progress
  useEffect(() => {
    const handleModelInitProgress = (progress: ModelImportProgress): void => {
      setImportProgress(progress);
      addConsoleLog(`[Build] ${progress.message}`);
      
      // Update form if static model is detected
      if (progress.detectedStatic && progress.detectedShape) {
        setImportForm(prev => {
          const channels = prev.modelType === 'vsr' ? String(prev.temporalFrames * 3) : '3';
          const newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, true, prev.inputName, prev.useBf16, prev.temporalFrames);
          // Replace the default shape with the detected shape
          const updatedCommand = newCommand.replace(
            `--shapes=${prev.inputName}:1x${channels}x720x1280`,
            `--shapes=${prev.inputName}:${progress.detectedShape}`
          );
          return {
            ...prev,
            useStaticShape: true,
            customTrtexecParams: updatedCommand,
            optShapes: `${prev.inputName}:${progress.detectedShape}`
          };
        });
        addConsoleLog(`[Build] Auto-updated to static mode with shape: ${progress.detectedShape}`);
      }
      
      if (progress.type === 'complete') {
        if (completionGuardRef.current) return;
        completionGuardRef.current = true;
        setIsImporting(false);
        setShowImportModal(false);
        setShowAutoBuildModal(false);
        // Pass the enginePath to the completion handler
        onImportComplete(progress.enginePath);
        resetImportForm();
        notify.success('Model Built', 'Model built successfully!');
      } else if (progress.type === 'error') {
        setIsImporting(false);
        setShowAutoBuildModal(false);
        notify.error('Model Build Failed', progress.message);
      }
    };

    const handleModelImportProgress = (progress: ModelImportProgress): void => {
      setImportProgress(progress);
      addConsoleLog(`[Import] ${progress.message}`);
      
      // Update form if static model is detected
      if (progress.detectedStatic && progress.detectedShape) {
        setImportForm(prev => {
          const channels = prev.modelType === 'vsr' ? String(prev.temporalFrames * 3) : '3';
          const newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, true, prev.inputName, prev.useBf16, prev.temporalFrames);
          // Replace the default shape with the detected shape
          const updatedCommand = newCommand.replace(
            `--shapes=${prev.inputName}:1x${channels}x720x1280`,
            `--shapes=${prev.inputName}:${progress.detectedShape}`
          );
          return {
            ...prev,
            useStaticShape: true,
            customTrtexecParams: updatedCommand,
            optShapes: `${prev.inputName}:${progress.detectedShape}`
          };
        });
        addConsoleLog(`[Import] Auto-updated to static mode with shape: ${progress.detectedShape}`);
      }
      
      if (progress.type === 'complete') {
        if (completionGuardRef.current) return;
        completionGuardRef.current = true;
        setIsImporting(false);
        setShowImportModal(false);
        // Pass the enginePath to the completion handler
        onImportComplete(progress.enginePath);
        resetImportForm();
        notify.success('Model Imported', 'Model imported successfully!');
      } else if (progress.type === 'error') {
        setIsImporting(false);
        notify.error('Model Import Failed', progress.message);
      }
    };

    const offInit = window.electronAPI.onModelInitProgress(handleModelInitProgress);
    const offImport = window.electronAPI.onModelImportProgress(handleModelImportProgress);

    // Cleanup to prevent multiple listeners accumulating across re-renders
    return () => {
      try { offInit && offInit(); } catch {}
      try { offImport && offImport(); } catch {}
    };
  }, [addConsoleLog, onImportComplete, resetImportForm]);

  return {
    showImportModal,
    setShowImportModal,
    modalMode,
    setModalMode,
    importProgress,
    isImporting,
    importForm,
    setImportForm,
    handleSelectOnnxFile,
    handleModelTypeChange,
    handleShapeModeChange,
    handleFp32Change,
    handlePrecisionChange,
    handleTemporalFramesChange,
    handleImportModel,
    handleCancelBuild,
    handleAutoBuildModel,
    resetImportForm,
    showAutoBuildModal,
    autoBuildModelName,
    autoBuildModelType,
    autoBuildIsStatic,
    autoBuildStaticShape,
  };
};
