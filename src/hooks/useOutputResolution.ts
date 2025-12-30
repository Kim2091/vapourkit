import { useState, useCallback, useRef } from 'react';
import type { VideoInfo, Filter } from '../electron.d';

interface UseOutputResolutionProps {
  videoInfo: VideoInfo | null;
  selectedModel: string;
  useDirectML: boolean;
  filters: Filter[];
  numStreams: number;
  onLog: (message: string) => void;
  onUpdateVideoInfo: (updater: (prev: VideoInfo | null) => VideoInfo | null) => void;
  onError?: (message: string) => void;
}

export type ValidationStatus = 'idle' | 'validating' | 'success' | 'error';

interface UseOutputResolutionReturn {
  isValidating: boolean;
  validationStatus: ValidationStatus;
  validationError: string | null;
  validateWorkflow: () => Promise<boolean>;
  cancelValidation: () => Promise<void>;
  clearValidationStatus: () => void;
}

export function useOutputResolution({
  videoInfo,
  selectedModel,
  useDirectML,
  filters,
  numStreams,
  onLog,
  onUpdateVideoInfo,
  onError,
}: UseOutputResolutionProps): UseOutputResolutionReturn {
  const [isValidating, setIsValidating] = useState(false);
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const isValidatingRef = useRef(false);
  const isCancelledRef = useRef(false);

  const clearValidationStatus = useCallback(() => {
    setValidationStatus('idle');
    setValidationError(null);
  }, []);

  const cancelValidation = useCallback(async (): Promise<void> => {
    if (!isValidatingRef.current) {
      return;
    }
    
    onLog('Cancelling validation...');
    isCancelledRef.current = true;
    
    try {
      await window.electronAPI.cancelValidation();
      onLog('Validation cancelled');
    } catch (error) {
      console.error('Error cancelling validation:', error);
    }
    
    isValidatingRef.current = false;
    setIsValidating(false);
    setValidationStatus('idle');
    setValidationError(null);
  }, [onLog]);

  const validateWorkflow = useCallback(async (): Promise<boolean> => {
    if (!videoInfo) {
      const errorMsg = 'No video loaded - cannot validate workflow';
      onLog(errorMsg);
      setValidationStatus('error');
      setValidationError('No video loaded');
      onError?.(errorMsg);
      return false;
    }
    
    // Prevent concurrent validations
    if (isValidatingRef.current) {
      onLog('Validation already in progress...');
      return false;
    }
    
    isValidatingRef.current = true;
    isCancelledRef.current = false;
    setIsValidating(true);
    setValidationStatus('validating');
    setValidationError(null);
    onLog('Validating workflow (processing first 5 seconds)...');
    
    try {
      const info = await window.electronAPI.getOutputResolution(
        videoInfo.path,
        selectedModel,
        useDirectML,
        true,
        filters,
        0,
        numStreams,
        videoInfo.fps || undefined // Pass source FPS for validation frame calculation
      );
      
      // Check if validation was cancelled
      if (isCancelledRef.current) {
        return false;
      }
      
      // Check if backend returned an error
      if (info.error) {
        onLog(`Workflow validation failed: ${info.error}`);
        setValidationStatus('error');
        setValidationError(info.error);
        onError?.(info.error);
        return false;
      }
      
      if (info.resolution || info.fps) {
        onUpdateVideoInfo(prev => prev ? { 
          ...prev, 
          outputResolution: info.resolution || undefined,
          outputFps: info.fps || undefined,
          outputPixelFormat: info.pixelFormat || undefined,
          outputCodec: info.codec || undefined,
          outputScanType: info.scanType || undefined
        } : null);
        
        const logParts = ['Workflow validated successfully'];
        if (info.resolution) logParts.push(`Output resolution: ${info.resolution}`);
        if (info.fps) logParts.push(`Output FPS: ${info.fps}`);
        onLog(logParts.join(', '));
        setValidationStatus('success');
        return true;
      } else {
        // No resolution/fps but also no error - treat as validation failure
        const errorMsg = 'No output info returned from workflow validation. Please check the log for details.';
        onLog('Workflow validation failed: No output info returned');
        setValidationStatus('error');
        setValidationError(errorMsg);
        onError?.(errorMsg);
        return false;
      }
    } catch (error) {
      // Check if validation was cancelled
      if (isCancelledRef.current) {
        return false;
      }
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      onLog(`Workflow validation failed: ${errorMsg}`);
      console.error('Error validating workflow:', error);
      setValidationStatus('error');
      setValidationError(errorMsg);
      onError?.(errorMsg);
      return false;
    } finally {
      isValidatingRef.current = false;
      setIsValidating(false);
    }
  }, [videoInfo, selectedModel, useDirectML, filters, numStreams, onLog, onUpdateVideoInfo, onError]);

  return {
    isValidating,
    validationStatus,
    validationError,
    validateWorkflow,
    cancelValidation,
    clearValidationStatus,
  };
}
