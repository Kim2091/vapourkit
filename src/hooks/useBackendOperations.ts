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
    // Metadata defaults (from the stock config), refined by ONNX detection below
    const displayTag = model.displayTag || '';
    let modelType: 'vsr' | 'image' = model.modelType || 'image';
    let temporalFrames = 5;

    // Filename precision suffixes are authoritative for curated bundled models
    // (many fp16-weight exports still report fp32 I/O, so the detected data
    // type is only used when the filename has no suffix)
    const modelNameLower = model.name.toLowerCase();
    const hasPrecisionSuffix = /_(fp16|fp32|bf16)/.test(modelNameLower);
    let useFp32 = modelNameLower.includes('_fp32');
    let useBf16 = modelNameLower.includes('_bf16');

    let inputName = 'input'; // Default fallback
    let useStaticShape = false;
    let detectedShape: number[] | undefined;
    let detectionFailed = false;

    // Same ONNX auto-detection as the custom import path
    try {
      const validation = await window.electronAPI.validateOnnxModel(model.onnxPath);
      if (!validation.isValid) {
        detectionFailed = true;
      }
      if (validation.isValid && validation.inputName) {
        inputName = validation.inputName;
        onLog(`Detected input name: ${inputName}`);
      }
      if (validation.isValid && validation.inputShape && validation.inputShape.length >= 4) {
        const inputChannels = Number(validation.inputShape[1]);
        if (Number.isInteger(inputChannels) && inputChannels > 3 && inputChannels % 3 === 0) {
          modelType = 'vsr';
          temporalFrames = inputChannels / 3;
          onLog(`Detected VSR model with ${temporalFrames} temporal frames (${inputChannels} channels)`);
        } else if (inputChannels === 3) {
          modelType = 'image';
          onLog('Detected image model (3 channels)');
        }
        if (validation.isStatic) {
          useStaticShape = true;
          detectedShape = validation.inputShape;
          onLog(`Detected static model with shape: ${detectedShape.join('x')}`);
        }
      }
      if (validation.isValid && validation.inputDataType && !hasPrecisionSuffix) {
        const dt = validation.inputDataType.toLowerCase();
        useFp32 = dt === 'float32';
        useBf16 = dt === 'bfloat16';
        onLog(`Detected ${useFp32 ? 'FP32' : useBf16 ? 'BF16' : 'FP16'} precision`);
      }
    } catch (validationError) {
      console.warn('Could not validate ONNX model:', validationError);
      detectionFailed = true;
    }

    // Shapes based on detected type/frames and extracted input name
    const channels = modelType === 'vsr' ? String(temporalFrames * 3) : '3';
    const minShapes = `${inputName}:1x${channels}x240x240`;
    const optShapes = useStaticShape && detectedShape
      ? `${inputName}:${detectedShape.join('x')}`
      : `${inputName}:1x${channels}x720x1280`;
    const maxShapes = `${inputName}:1x${channels}x1080x1920`;

    // Generate the trtexec-style build command with proper parameters
    let customTrtexecParams = generateTrtexecCommand(modelType, useFp32, useStaticShape, inputName, useBf16, temporalFrames);
    if (useStaticShape && detectedShape) {
      customTrtexecParams = customTrtexecParams.replace(
        `--shapes=${inputName}:1x${channels}x720x1280`,
        `--shapes=${inputName}:${detectedShape.join('x')}`
      );
    }

    setImportForm({
      onnxPath: model.onnxPath,
      modelName: model.name,
      inputName,
      minShapes,
      optShapes,
      maxShapes,
      useFp32: useFp32,
      useBf16: useBf16,
      modelType,
      temporalFrames,
      useDirectML: useDirectML,
      displayTag,
      useStaticShape,
      useCustomTrtexecParams: true,
      customTrtexecParams,
      detectionFailed
    });
    setModalMode('build');
    setShowImportModal(true);

    onLog(`Opening build modal for ${model.name} (${modelType}${modelType === 'vsr' ? `, ${temporalFrames} frames` : ''}, ${useFp32 ? 'FP32' : useBf16 ? 'BF16' : 'FP16'})`);
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
