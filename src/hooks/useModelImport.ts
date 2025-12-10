import { useState, useEffect, useCallback, useRef } from 'react';
import type { ModelImportProgress } from '../electron.d';

export interface ImportForm {
  onnxPath: string;
  modelName: string;
  inputName: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  useBf16: boolean;
  modelType: 'tspan' | 'image';
  useDirectML: boolean;
  displayTag: string;
  useStaticShape: boolean;
  useCustomTrtexecParams: boolean;
  customTrtexecParams: string;
}

// Helper function to generate default trtexec command
export const generateTrtexecCommand = (modelType: 'tspan' | 'image', useFp32: boolean, useStaticShape: boolean, inputName: string = 'input', useBf16: boolean = false): string => {
  const channels = modelType === 'tspan' ? '15' : '3';
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
    return `--shapes=${inputName}:1x${channels}x720x1280 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=5 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
  } else {
    // Dynamic shape mode
    return `--minShapes=${inputName}:1x${channels}x240x240 --optShapes=${inputName}:1x${channels}x720x1280 --maxShapes=${inputName}:1x${channels}x1080x1920 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=5 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
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
  useDirectML: false,
  displayTag: '',
  useStaticShape: false,
  useCustomTrtexecParams: true, // Always true in refactored UI - the textbox is the main interface
  customTrtexecParams: generateTrtexecCommand('image', false, false, 'input', false)
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
  // Auto-build modal state
  const [showAutoBuildModal, setShowAutoBuildModal] = useState(false);
  const [autoBuildModelName, setAutoBuildModelName] = useState('');
  const [autoBuildModelType, setAutoBuildModelType] = useState<'tspan' | 'image'>('image');
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
        
        // Validate the model to extract input name and detect static shapes
        let extractedInputName = 'input'; // Default fallback
        let detectedIsStatic = false;
        let detectedShape: number[] | undefined;
        try {
          const validation = await window.electronAPI.validateOnnxModel(result);
          if (validation.isValid && validation.inputName) {
            extractedInputName = validation.inputName;
            addConsoleLog(`[Model] Detected input name: ${extractedInputName}`);
          }
          if (validation.isValid && validation.isStatic && validation.inputShape) {
            detectedIsStatic = true;
            detectedShape = validation.inputShape;
            addConsoleLog(`[Model] Detected static model with shape: ${detectedShape.join('x')}`);
          }
        } catch (validationError) {
          console.warn('Could not validate ONNX model:', validationError);
        }
        
        addConsoleLog(`[Model] Setting form - detectedIsStatic: ${detectedIsStatic}, detectedShape: ${detectedShape ? detectedShape.join('x') : 'none'}`);
        
        setImportForm(prev => {
          // If static model detected, use static mode and the detected shape
          const useStatic = detectedIsStatic;
          const channels = prev.modelType === 'tspan' ? '15' : '3';
          
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
          
          let newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, useStatic, extractedInputName, prev.useBf16);
          
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
            useStaticShape: useStatic,
            customTrtexecParams: newCommand,
            minShapes: `${extractedInputName}:1x${channels}x240x240`,
            optShapes,
            maxShapes: `${extractedInputName}:1x${channels}x1080x1920`,
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
      const newCommand = generateTrtexecCommand(prev.modelType, useFp32, prev.useStaticShape, prev.inputName, prev.useBf16);
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
      const newCommand = generateTrtexecCommand(prev.modelType, useFp32, prev.useStaticShape, prev.inputName, useBf16);
      return {
        ...prev,
        useFp32,
        useBf16,
        customTrtexecParams: newCommand,
      };
    });
  }, []);

  const handleModelTypeChange = useCallback((modelType: 'tspan' | 'image'): void => {
    setImportForm(prev => {
      const useStatic = prev.useStaticShape;
      const inputName = prev.inputName;
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStatic, inputName, prev.useBf16);
      const channels = modelType === 'tspan' ? '15' : '3';
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
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStaticShape, inputName, prev.useBf16);
      const channels = modelType === 'tspan' ? '15' : '3';
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
          useDirectML: importForm.useDirectML,
          displayTag: importForm.displayTag || undefined,
          useStaticShape: importForm.useStaticShape,
          useCustomTrtexecParams: importForm.useCustomTrtexecParams,
          customTrtexecParams: importForm.customTrtexecParams || undefined,
        });
      }
    } catch (error) {
      console.error('Error importing model:', error);
      setIsImporting(false);
    }
  }, [importForm, modalMode]);

  const resetImportForm = useCallback((): void => {
    setImportForm({ ...DEFAULT_IMPORT_FORM, useDirectML });
  }, [useDirectML]);

  const handleAutoBuildModel = useCallback(async (model: { onnxPath: string; name: string; modelType?: string; displayTag?: string }): Promise<void> => {
    // Use existing metadata from ONNX model if available
    const modelType = model.modelType || 'image';
    const displayTag = model.displayTag || '';
    
    // Extract input name from the model
    let inputName = 'input'; // Default fallback
    try {
      const validation = await window.electronAPI.validateOnnxModel(model.onnxPath);
      if (validation.isValid && validation.inputName) {
        inputName = validation.inputName;
      }
    } catch (validationError) {
      console.warn('Could not validate ONNX model for auto-build:', validationError);
    }
    
    // Set default shapes based on model type and extracted input name
    const isVideoModel = modelType === 'tspan';
    const channels = isVideoModel ? '15' : '3';
    const minShapes = `${inputName}:1x${channels}x240x240`;
    const optShapes = `${inputName}:1x${channels}x720x1280`;
    const maxShapes = `${inputName}:1x${channels}x1080x1920`;
    
    // Show auto-build modal with model info
    setAutoBuildModelName(model.name);
    setAutoBuildModelType(modelType as 'tspan' | 'image');
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
        useFp32: false,
        modelType: modelType as 'tspan' | 'image',
        displayTag: displayTag || undefined,
      });
    } catch (error) {
      console.error('Error auto-building model:', error);
      setIsImporting(false);
      setShowAutoBuildModal(false);
    }
  }, []);

  // Listen for model import/build progress
  useEffect(() => {
    const handleModelInitProgress = (progress: ModelImportProgress): void => {
      setImportProgress(progress);
      addConsoleLog(`[Build] ${progress.message}`);
      
      // Update form if static model is detected
      if (progress.detectedStatic && progress.detectedShape) {
        setImportForm(prev => {
          const channels = prev.modelType === 'tspan' ? '15' : '3';
          const newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, true, prev.inputName);
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
        alert('Model built successfully!');
      } else if (progress.type === 'error') {
        setIsImporting(false);
        setShowAutoBuildModal(false);
        alert(`Model Build Failed\n\n${progress.message}`);
      }
    };

    const handleModelImportProgress = (progress: ModelImportProgress): void => {
      setImportProgress(progress);
      addConsoleLog(`[Import] ${progress.message}`);
      
      // Update form if static model is detected
      if (progress.detectedStatic && progress.detectedShape) {
        setImportForm(prev => {
          const channels = prev.modelType === 'tspan' ? '15' : '3';
          const newCommand = generateTrtexecCommand(prev.modelType, prev.useFp32, true, prev.inputName);
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
        alert('Model imported successfully!');
      } else if (progress.type === 'error') {
        setIsImporting(false);
        alert(`Model Import Failed\n\n${progress.message}`);
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
    handleImportModel,
    handleAutoBuildModel,
    resetImportForm,
    showAutoBuildModal,
    autoBuildModelName,
    autoBuildModelType,
  };
};
