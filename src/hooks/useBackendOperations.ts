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

  const handleBuildModel = useCallback((model: UninitializedModel): void => {
    // Use existing metadata from ONNX model if available
    const modelType = model.modelType || 'image';
    const displayTag = model.displayTag || '';
    
    // Detect precision from filename
    const modelNameLower = model.name.toLowerCase();
    const useFp32 = modelNameLower.includes('_fp32');
    
    // Set default shapes based on model type
    const isVideoModel = modelType === 'tspan';
    const minShapes = isVideoModel ? 'input:1x15x240x240' : 'input:1x3x240x240';
    const optShapes = isVideoModel ? 'input:1x15x720x1280' : 'input:1x3x720x1280';
    const maxShapes = isVideoModel ? 'input:1x15x1080x1920' : 'input:1x3x1080x1920';
    
    // Generate the trtexec command with proper parameters
    const customTrtexecParams = generateTrtexecCommand(modelType as 'tspan' | 'image', useFp32, false);
    
    setImportForm({
      onnxPath: model.onnxPath,
      modelName: model.name,
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
