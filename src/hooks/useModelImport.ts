import { useState, useEffect, useCallback, useRef } from 'react';
import type { ModelImportProgress } from '../electron.d';

interface ImportForm {
  onnxPath: string;
  modelName: string;
  minShapes: string;
  optShapes: string;
  maxShapes: string;
  useFp32: boolean;
  modelType: 'tspan' | 'image';
  useDirectML: boolean;
  displayTag: string;
  useStaticShape: boolean;
  useCustomTrtexecParams: boolean;
  customTrtexecParams: string;
}

// Helper function to generate default trtexec command
export const generateTrtexecCommand = (modelType: 'tspan' | 'image', useFp32: boolean, useStaticShape: boolean): string => {
  const channels = modelType === 'tspan' ? '15' : '3';
  // FP32 is the default in trtexec, so only add --fp16 flag when NOT using FP32
  const precisionFlags = useFp32 ? '' : '--inputIOFormats=fp16:chw --outputIOFormats=fp16:chw --fp16';
  
  if (useStaticShape) {
    // Static shape mode
    return `--shapes=input:1x${channels}x720x1280 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=5 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
  } else {
    // Dynamic shape mode
    return `--minShapes=input:1x${channels}x240x240 --optShapes=input:1x${channels}x720x1280 --maxShapes=input:1x${channels}x1080x1920 --saveEngine=OUTPUT_PATH --builderOptimizationLevel=5 --useCudaGraph --tacticSources=+CUDNN,-CUBLAS,-CUBLAS_LT${precisionFlags ? ' ' + precisionFlags : ''}`;
  }
};

const DEFAULT_IMPORT_FORM: ImportForm = {
  onnxPath: '',
  modelName: '',
  minShapes: 'input:1x3x240x240',
  optShapes: 'input:1x3x480x640',
  maxShapes: 'input:1x3x1080x1920',
  useFp32: false,
  modelType: 'image',
  useDirectML: false,
  displayTag: '',
  useStaticShape: false,
  useCustomTrtexecParams: true, // Always true in refactored UI - the textbox is the main interface
  customTrtexecParams: generateTrtexecCommand('image', false, false)
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
        
        setImportForm(prev => ({ 
          ...prev, 
          onnxPath: result,
          modelName: modelName // Auto-fill with filename
        }));
      }
    } catch (error) {
      console.error('Error selecting ONNX file:', error);
    }
  }, []);

  const handleFp32Change = useCallback((useFp32: boolean): void => {
    setImportForm(prev => {
      const newCommand = generateTrtexecCommand(prev.modelType, useFp32, prev.useStaticShape);
      return {
        ...prev,
        useFp32,
        customTrtexecParams: newCommand,
      };
    });
  }, []);

  const handleModelTypeChange = useCallback((modelType: 'tspan' | 'image'): void => {
    setImportForm(prev => {
      const useStatic = prev.useStaticShape;
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStatic);
      return {
        ...prev,
        modelType,
        customTrtexecParams: newCommand,
        minShapes: modelType === 'tspan' ? 'input:1x15x240x240' : 'input:1x3x240x240',
        optShapes: modelType === 'tspan' 
          ? (useStatic ? 'input:1x15x480x640' : 'input:1x15x720x1280')
          : (useStatic ? 'input:1x3x480x640' : 'input:1x3x720x1280'),
        maxShapes: modelType === 'tspan' ? 'input:1x15x1080x1920' : 'input:1x3x1080x1920',
      };
    });
  }, []);

  const handleShapeModeChange = useCallback((useStaticShape: boolean): void => {
    setImportForm(prev => {
      const modelType = prev.modelType;
      const newCommand = generateTrtexecCommand(modelType, prev.useFp32, useStaticShape);
      return {
        ...prev,
        useStaticShape,
        customTrtexecParams: newCommand,
        optShapes: modelType === 'tspan'
          ? (useStaticShape ? 'input:1x15x480x640' : 'input:1x15x720x1280')
          : (useStaticShape ? 'input:1x3x480x640' : 'input:1x3x720x1280'),
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
    
    // Set default shapes based on model type
    const isVideoModel = modelType === 'tspan';
    const minShapes = isVideoModel ? 'input:1x15x240x240' : 'input:1x3x240x240';
    const optShapes = isVideoModel ? 'input:1x15x720x1280' : 'input:1x3x720x1280';
    const maxShapes = isVideoModel ? 'input:1x15x1080x1920' : 'input:1x3x1080x1920';
    
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
    handleImportModel,
    handleAutoBuildModel,
    resetImportForm,
    showAutoBuildModal,
    autoBuildModelName,
    autoBuildModelType,
  };
};
