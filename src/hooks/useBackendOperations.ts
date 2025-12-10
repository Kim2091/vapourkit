import { useCallback } from 'react';
import type { UninitializedModel } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { generateTrtexecCommand } from './useModelImport';

interface UseBackendOperationsProps {
  onLog: (message: string) => void;
  loadModels: () => Promise<void>;
  loadUninitializedModels: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  setImportForm: (form: any) => void;
  setModalMode: (mode: 'import' | 'build') => void;
  setShowImportModal: (show: boolean) => void;
  handleAutoBuildModel: (params: any) => Promise<void>;
  useDirectML: boolean;
  setIsReloading: (reloading: boolean) => void;
}

export function useBackendOperations({
  onLog,
  loadModels,
  loadUninitializedModels,
  loadTemplates,
  setImportForm,
  setModalMode,
  setShowImportModal,
  handleAutoBuildModel,
  useDirectML,
  setIsReloading,
}: UseBackendOperationsProps) {
  
  const handleReloadBackend = useCallback(async (): Promise<void> => {
    setIsReloading(true);
    onLog('Reloading backend...');
    
    // Small delay to ensure the spinning animation starts
    await new Promise(resolve => setTimeout(resolve, 100));
    
    try {
      const result = await window.electronAPI.reloadBackend();
      if (result.success) {
        await loadModels();
        await loadUninitializedModels();
        await loadTemplates();
        onLog('Backend reloaded successfully');
        
        // Ensure minimum animation duration for visual feedback
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        onLog(`Error reloading backend: ${result.error}`);
      }
    } catch (error) {
      onLog(`Error reloading backend: ${getErrorMessage(error)}`);
    } finally {
      setIsReloading(false);
    }
  }, [onLog, loadModels, loadUninitializedModels, loadTemplates, setIsReloading]);

  const handleBuildModel = useCallback(async (model: UninitializedModel): Promise<void> => {
    // Use existing metadata from ONNX model if available
    const modelType = model.modelType || 'image';
    const displayTag = model.displayTag || '';
    
    // Detect precision from filename
    const modelNameLower = model.name.toLowerCase();
    const useFp32 = modelNameLower.includes('_fp32');
    
    // Extract input name from the model
    let inputName = 'input'; // Default fallback
    try {
      const validation = await window.electronAPI.validateOnnxModel(model.onnxPath);
      if (validation.isValid && validation.inputName) {
        inputName = validation.inputName;
        onLog(`Detected input name: ${inputName}`);
      }
    } catch (validationError) {
      console.warn('Could not validate ONNX model:', validationError);
    }
    
    // Set default shapes based on model type and extracted input name
    const isVideoModel = modelType === 'tspan';
    const channels = isVideoModel ? '15' : '3';
    const minShapes = `${inputName}:1x${channels}x240x240`;
    const optShapes = `${inputName}:1x${channels}x720x1280`;
    const maxShapes = `${inputName}:1x${channels}x1080x1920`;
    
    // Generate the trtexec command with proper parameters
    const customTrtexecParams = generateTrtexecCommand(modelType as 'tspan' | 'image', useFp32, false, inputName);
    
    setImportForm({
      onnxPath: model.onnxPath,
      modelName: model.name,
      inputName,
      minShapes,
      optShapes,
      maxShapes,
      useFp32: useFp32,
      modelType,
      useDirectML: useDirectML,
      displayTag,
      useStaticShape: false,
      useCustomTrtexecParams: true,
      customTrtexecParams
    });
    setModalMode('build');
    setShowImportModal(true);
    
    onLog(`Opening build modal for ${model.name} (${modelType}, ${useFp32 ? 'FP32' : 'FP16'})`);
  }, [setImportForm, setModalMode, setShowImportModal, useDirectML, onLog]);

  const handleAutoBuild = useCallback(async (model: UninitializedModel): Promise<void> => {
    onLog(`Auto-building model: ${model.name}`);
    await handleAutoBuildModel({
      onnxPath: model.onnxPath,
      name: model.name,
      modelType: model.modelType,
      displayTag: model.displayTag
    });
  }, [onLog, handleAutoBuildModel]);

  return {
    handleReloadBackend,
    handleBuildModel,
    handleAutoBuild,
  };
}
