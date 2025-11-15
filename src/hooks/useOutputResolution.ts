import { useEffect, useRef } from 'react';
import type { VideoInfo, Filter } from '../electron.d';

interface UseOutputResolutionProps {
  videoInfo: VideoInfo | null;
  selectedModel: string;
  useDirectML: boolean;
  filters: Filter[];
  numStreams: number;
  onLog: (message: string) => void;
  onUpdateVideoInfo: (updater: (prev: VideoInfo | null) => VideoInfo | null) => void;
}

export function useOutputResolution({
  videoInfo,
  selectedModel,
  useDirectML,
  filters,
  numStreams,
  onLog,
  onUpdateVideoInfo,
}: UseOutputResolutionProps) {
  const isEvaluatingFiltersRef = useRef<boolean>(false);
  const needsReEvaluationRef = useRef<boolean>(false);

  // Update output resolution when settings change
  useEffect(() => {
    const updateOutputResolution = async () => {
      if (!videoInfo) return;
      
      // If an evaluation is already in progress, mark that we need to re-evaluate
      if (isEvaluatingFiltersRef.current) {
        needsReEvaluationRef.current = true;
        return;
      }
      
      isEvaluatingFiltersRef.current = true;
      needsReEvaluationRef.current = false;
      
      try {
        const info = await window.electronAPI.getOutputResolution(
          videoInfo.path,
          selectedModel,
          useDirectML,
          true,
          filters,
          0,
          numStreams
        );
        
        if (info.resolution || info.fps) {
          onUpdateVideoInfo(prev => prev ? { 
            ...prev, 
            outputResolution: info.resolution || undefined,
            outputFps: info.fps || undefined
          } : null);
          
          const logParts = [];
          if (info.resolution) logParts.push(`Output resolution: ${info.resolution}`);
          if (info.fps) logParts.push(`Output FPS: ${info.fps}`);
          if (logParts.length > 0) onLog(logParts.join(', '));
        }
      } catch (error) {
        console.error('Error getting output info:', error);
      } finally {
        isEvaluatingFiltersRef.current = false;
        
        // If changes occurred during evaluation, run one more time with latest state
        if (needsReEvaluationRef.current) {
          needsReEvaluationRef.current = false;
          updateOutputResolution();
        }
      }
    };
    
    updateOutputResolution();
  }, [videoInfo?.path, selectedModel, useDirectML, filters, numStreams, onLog, onUpdateVideoInfo]);
}
