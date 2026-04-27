// src/components/ActionButtons.tsx - Validate/Preview/Start/Stop button cluster

import { memo } from 'react';
import { Sparkles, XCircle, Loader2, CheckCircle, AlertCircle, Play, Gauge, AlertTriangle } from 'lucide-react';
import type { QueueItem, SegmentSelection, Filter, UpscaleProgress } from '../electron.d';
import type { ValidationStatus } from '../hooks/useOutputResolution';

interface ActionButtonsProps {
  // Processing state
  isProcessing: boolean;
  isStopping: boolean;
  isStartDisabled: boolean;
  upscaleProgress: UpscaleProgress | null;

  // Validation state
  isValidating: boolean;
  validationStatus: ValidationStatus;
  validationError: string | null;
  validateWorkflow: () => void;
  cancelValidation: () => void;

  // Preview state
  isLaunchingPreviewer: boolean;
  previewerStatus: 'idle' | 'success' | 'error';

  // Video/model state
  videoInfo: any;
  selectedModel: string | null;
  useDirectML: boolean;
  filters: Filter[];
  numStreams: number;
  segment: SegmentSelection;
  benchmarkMode: boolean;

  // Queue state
  showQueue: boolean;
  isQueueStarted: boolean;
  isQueueStopping: boolean;
  queue: QueueItem[];

  // Handlers
  handleForceStop: () => void;
  handleLaunchPreviewer: () => void;
  handleUpscale: (model: string, useDirectML: boolean, filters: Filter[], numStreams: number, segment: SegmentSelection, benchmarkMode: boolean) => void;
  handleCancelUpscale: () => void;
  handleStartQueue: () => void;
  handleStopQueue: () => void;
}

export const ActionButtons = memo(function ActionButtons({
  isProcessing,
  isStopping,
  isStartDisabled,
  upscaleProgress,
  isValidating,
  validationStatus,
  validationError,
  validateWorkflow,
  cancelValidation,
  isLaunchingPreviewer,
  previewerStatus,
  videoInfo,
  selectedModel,
  useDirectML,
  filters,
  numStreams,
  segment,
  benchmarkMode,
  showQueue,
  isQueueStarted,
  isQueueStopping,
  queue,
  handleForceStop,
  handleLaunchPreviewer,
  handleUpscale,
  handleCancelUpscale,
  handleStartQueue,
  handleStopQueue,
}: ActionButtonsProps) {
  const noEnabledFilters = filters.filter(f => f.enabled).length === 0;
  const showNoFiltersBanner = noEnabledFilters && !isProcessing && !showQueue;

  return (
    <div className="flex-shrink-0 flex flex-col gap-2">
      {showNoFiltersBanner && (
        <div className="bg-yellow-900/40 border border-yellow-500/50 text-yellow-200 px-3 py-2 rounded-lg flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-yellow-400" />
          <span>No filters are configured — the video will only be re-encoded with your current settings.</span>
        </div>
      )}
      <div className="flex gap-2 relative">
        {/* Force Stop Button - Only visible when stuck */}
        {!isProcessing && upscaleProgress && upscaleProgress.type === 'progress' && (
          <button
            onClick={handleForceStop}
            className="bg-red-900/50 hover:bg-red-800 text-red-200 px-4 rounded-xl border border-red-700/50 transition-colors flex items-center gap-2"
            title="Force stop stuck process"
          >
            <XCircle className="w-5 h-5" />
          </button>
        )}

        {/* Validate Workflow Button - hidden during processing */}
        {!isProcessing && (
          <button
            onClick={isValidating ? cancelValidation : validateWorkflow}
            disabled={!videoInfo && !isValidating}
            className={`font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
              isValidating
                ? 'bg-orange-600 hover:bg-orange-700 cursor-pointer text-white'
                : validationStatus === 'success'
                ? 'bg-green-600 hover:bg-green-700 text-white'
                : validationStatus === 'error'
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-dark-surface hover:bg-dark-bg border border-violet-500/50 hover:border-violet-400 text-violet-300 disabled:border-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed'
            }`}
            title={isValidating ? 'Click to cancel validation' : validationStatus === 'error' && validationError ? `Error: ${validationError}` : 'Validate the current workflow by processing first 5 seconds'}
          >
            {isValidating ? (
              <>
                <XCircle className="w-5 h-5" />
                Cancel
              </>
            ) : validationStatus === 'success' ? (
              <>
                <CheckCircle className="w-5 h-5" />
                Valid
              </>
            ) : validationStatus === 'error' ? (
              <>
                <AlertCircle className="w-5 h-5" />
                Failed
              </>
            ) : (
              <>
                <CheckCircle className="w-5 h-5" />
                Validate
              </>
            )}
          </button>
        )}

        {/* Preview Script Button - hidden during processing */}
        {!isProcessing && (
          <button
            onClick={handleLaunchPreviewer}
            disabled={!videoInfo || isLaunchingPreviewer}
            className={`font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
              isLaunchingPreviewer
                ? 'bg-teal-700 border border-teal-500/50 text-white cursor-wait'
                : previewerStatus === 'success'
                ? 'bg-teal-600 hover:bg-teal-700 text-white'
                : previewerStatus === 'error'
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-dark-surface hover:bg-dark-bg border border-teal-500/50 hover:border-teal-400 text-teal-300 disabled:border-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed'
            }`}
            title="Preview VapourSynth script with current workflow in vs-view"
          >
            {isLaunchingPreviewer ? (
              <>
                <Play className="w-5 h-5 animate-spin" />
                Launching...
              </>
            ) : previewerStatus === 'success' ? (
              <>
                <CheckCircle className="w-5 h-5" />
                Launched
              </>
            ) : previewerStatus === 'error' ? (
              <>
                <XCircle className="w-5 h-5" />
                Failed
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                Preview
              </>
            )}
          </button>
        )}

        {showQueue ? (
          <button
            onClick={isQueueStarted ? handleStopQueue : handleStartQueue}
            disabled={(!isQueueStarted && queue.filter(item => item.status === 'pending').length === 0) || isQueueStopping}
            className={`flex-1 font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
              isQueueStarted
                ? isQueueStopping
                  ? 'bg-orange-600 cursor-wait'
                  : 'bg-orange-500 hover:bg-orange-600'
                : 'bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed'
            }`}
          >
            {isQueueStarted ? (
              isQueueStopping ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Stopping Queue...
                </>
              ) : (
                <>
                  <XCircle className="w-5 h-5" />
                  Stop Queue
                </>
              )
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Start Queue
              </>
            )}
          </button>
        ) : (
          <button
            onClick={isProcessing ? handleCancelUpscale : () => handleUpscale(selectedModel || '', useDirectML, filters, numStreams, segment, benchmarkMode)}
            disabled={isStartDisabled}
            className={`flex-1 font-semibold py-4 px-6 rounded-xl transition-all duration-300 flex items-center justify-center gap-3 ${
              isStopping
                ? 'bg-orange-500 cursor-not-allowed'
                : isProcessing
                ? 'bg-red-500 hover:bg-red-600'
                : benchmarkMode
                ? 'bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed'
                : 'bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed'
            }`}
          >
            {isStopping ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Stopping...
              </>
            ) : isProcessing ? (
              <>
                <XCircle className="w-5 h-5" />
                Stop Processing
              </>
            ) : benchmarkMode ? (
              <>
                <Gauge className="w-5 h-5" />
                Start Benchmark
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Start Processing
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
});
