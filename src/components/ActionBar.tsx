// src/components/ActionBar.tsx — the 52px bar across the bottom of the window.
//
// Replaces two things at once: a card that spent ~100px carrying four numbers
// at text-base, and a row of py-4 buttons that sat at the end of a scrolling
// column. Progress is the bar's own top edge, so the strip costs no height at
// all.

import { memo } from 'react';
import {
  Sparkles, XCircle, Loader2, CheckCircle, AlertCircle, Play, Gauge,
  AlertTriangle, Terminal,
} from 'lucide-react';
import type { BackendId, QueueItem, SegmentSelection, Filter, UpscaleProgress } from '../electron.d';
import type { ValidationStatus } from '../hooks/useOutputResolution';

interface ActionBarProps {
  // Progress
  upscaleProgress: UpscaleProgress | null;

  // Console drawer
  showConsole: boolean;
  onToggleConsole: () => void;

  // Processing state
  isProcessing: boolean;
  isStopping: boolean;
  isStartDisabled: boolean;
  /** Why the button is off, shown on hover. Undefined when it is not. */
  startDisabledReason?: string;

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
  defaultBackend: BackendId;
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
  handleUpscale: (model: string, defaultBackend: BackendId, filters: Filter[], numStreams: number, segment: SegmentSelection, benchmarkMode: boolean) => void;
  handleCancelUpscale: () => void;
  handleStartQueue: () => void;
  handleStopQueue: () => void;
}

const formatEta = (seconds: number) => {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const Stat = ({ label, value }: { label?: string; value: string }) => (
  <span className="flex items-baseline gap-1.5 text-[12.5px] text-ink-400 whitespace-nowrap">
    {label && <span>{label}</span>}
    <span className="font-medium text-ink-200 tabular-nums">{value}</span>
  </span>
);

const Divider = () => <span className="w-px h-3.5 bg-ink-750 flex-shrink-0" />;

const BTN = 'h-8 px-3 rounded-md inline-flex items-center gap-2 text-[12.5px] font-semibold border transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed';
const BTN_SECONDARY = `${BTN} bg-ink-850 border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 disabled:opacity-40`;

export const ActionBar = memo(function ActionBar({
  upscaleProgress,
  showConsole,
  onToggleConsole,
  isProcessing,
  isStopping,
  isStartDisabled,
  startDisabledReason,
  isValidating,
  validationStatus,
  validationError,
  validateWorkflow,
  cancelValidation,
  isLaunchingPreviewer,
  previewerStatus,
  videoInfo,
  selectedModel,
  defaultBackend,
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
}: ActionBarProps) {
  const percent = upscaleProgress?.percentage;
  const noEnabledFilters = filters.filter(f => f.enabled).length === 0;
  const showNoFiltersWarning = noEnabledFilters && !isProcessing && !showQueue;
  const isStuck = !isProcessing && upscaleProgress?.type === 'progress';

  const state: { label: string; tone: string } = isStopping
    ? { label: 'Stopping', tone: 'border-warn-500/40 bg-warn-500/12 text-warn-400' }
    : isProcessing
      ? { label: benchmarkMode ? 'Benchmarking' : 'Processing', tone: 'border-accent-500/45 bg-accent-500/12 text-accent-400' }
      : { label: upscaleProgress?.message || 'Ready', tone: 'border-ink-750 bg-ink-850 text-ink-400' };

  return (
    <div className="h-[52px] flex-shrink-0 relative flex items-center gap-3 px-4 bg-ink-900 border-t border-ink-800">
      {/* Progress is the bar's top edge — it costs no height of its own */}
      {percent !== undefined && (
        <span
          className="absolute top-0 left-0 h-[2px] bg-accent-500 transition-all duration-300"
          style={{ width: `${percent}%`, boxShadow: '0 0 8px rgba(63,185,166,0.6)' }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Processing progress"
        />
      )}

      <span className={`inline-flex items-center gap-2 h-[26px] px-2.5 rounded-md border text-[12px] font-medium flex-shrink-0 max-w-[280px] ${state.tone}`}>
        {isProcessing && !isStopping && <Play className="w-3.5 h-3.5 flex-shrink-0" />}
        {isStopping && <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />}
        <span className="truncate">{state.label}</span>
      </span>

      {percent !== undefined && (
        <>
          <Stat value={`${percent}%`} />
          <Divider />
        </>
      )}
      {upscaleProgress?.fps && (
        <>
          <Stat label="Speed" value={`${upscaleProgress.fps} FPS`} />
          <Divider />
        </>
      )}
      {upscaleProgress?.eta != null && upscaleProgress.eta > 0 && (
        <Stat label="ETA" value={formatEta(upscaleProgress.eta)} />
      )}

      {showNoFiltersWarning && (
        <span
          className="inline-flex items-center gap-2 h-[26px] px-2.5 rounded-md border border-warn-500/40 bg-warn-500/12 text-warn-400 text-[12px] flex-shrink-0"
          title="No filters are enabled — the video will only be re-encoded with your current settings"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">No filters — re-encode only</span>
        </span>
      )}

      <div className="flex-1 min-w-0" />

      {/* Force stop — only when a run looks stuck */}
      {isStuck && (
        <button
          onClick={handleForceStop}
          className={`${BTN} bg-transparent border-bad-500/50 text-bad-400 hover:bg-bad-500/10`}
          title="Force stop a stuck process"
        >
          <XCircle className="w-4 h-4" />
          Force stop
        </button>
      )}

      <button
        onClick={onToggleConsole}
        className={`${BTN} ${
          showConsole
            ? 'bg-accent-500/15 border-accent-500/45 text-accent-400'
            : 'bg-transparent border-transparent text-ink-400 hover:text-ink-200 hover:bg-ink-850'
        }`}
        aria-pressed={showConsole}
        title={showConsole ? 'Hide console' : 'Show console'}
      >
        <Terminal className="w-4 h-4" />
        Console
      </button>

      {!isProcessing && (
        <button
          onClick={isValidating ? cancelValidation : validateWorkflow}
          disabled={!videoInfo && !isValidating}
          className={
            isValidating
              ? `${BTN} bg-warn-600 border-warn-600 text-ink-950 hover:bg-warn-500`
              : validationStatus === 'success'
                ? `${BTN} bg-ok-600 border-ok-600 text-ink-950 hover:bg-ok-500`
                : validationStatus === 'error'
                  ? `${BTN} bg-bad-600 border-bad-600 text-white hover:bg-bad-500`
                  : BTN_SECONDARY
          }
          title={
            isValidating
              ? 'Click to cancel validation'
              : validationStatus === 'error' && validationError
                ? `Error: ${validationError}`
                : 'Validate the current workflow by processing the first 5 seconds'
          }
        >
          {isValidating ? <><XCircle className="w-4 h-4" />Cancel</>
            : validationStatus === 'success' ? <><CheckCircle className="w-4 h-4" />Valid</>
            : validationStatus === 'error' ? <><AlertCircle className="w-4 h-4" />Failed</>
            : <><CheckCircle className="w-4 h-4" />Validate</>}
        </button>
      )}

      {!isProcessing && (
        <button
          onClick={handleLaunchPreviewer}
          disabled={!videoInfo || isLaunchingPreviewer}
          className={
            isLaunchingPreviewer
              ? `${BTN} bg-ink-800 border-ink-750 text-ink-300 cursor-wait`
              : previewerStatus === 'success'
                ? `${BTN} bg-ok-600 border-ok-600 text-ink-950 hover:bg-ok-500`
                : previewerStatus === 'error'
                  ? `${BTN} bg-bad-600 border-bad-600 text-white hover:bg-bad-500`
                  : BTN_SECONDARY
          }
          title="Preview the VapourSynth script with the current workflow in vs-view"
        >
          {isLaunchingPreviewer ? <><Loader2 className="w-4 h-4 animate-spin" />Launching</>
            : previewerStatus === 'success' ? <><CheckCircle className="w-4 h-4" />Launched</>
            : previewerStatus === 'error' ? <><XCircle className="w-4 h-4" />Failed</>
            : <><Play className="w-4 h-4" />Preview</>}
        </button>
      )}

      {/* Primary action — the one accent-filled control in the window */}
      {showQueue ? (
        <button
          onClick={isQueueStarted ? handleStopQueue : handleStartQueue}
          disabled={(!isQueueStarted && queue.filter(item => item.status === 'pending').length === 0) || isQueueStopping}
          className={
            isQueueStarted
              ? `${BTN} bg-bad-600 border-bad-600 text-white hover:bg-bad-500 ${isQueueStopping ? 'cursor-wait opacity-80' : ''}`
              : `${BTN} bg-accent-500 border-accent-500 text-accent-ink hover:bg-accent-400 disabled:bg-ink-800 disabled:border-ink-750 disabled:text-ink-600`
          }
        >
          {isQueueStarted
            ? isQueueStopping
              ? <><Loader2 className="w-4 h-4 animate-spin" />Stopping queue</>
              : <><XCircle className="w-4 h-4" />Stop queue</>
            : <><Sparkles className="w-4 h-4" />Start queue</>}
        </button>
      ) : (
        <button
          onClick={isProcessing
            ? handleCancelUpscale
            : () => handleUpscale(selectedModel || '', defaultBackend, filters, numStreams, segment, benchmarkMode)}
          disabled={isStartDisabled}
          title={isStartDisabled ? startDisabledReason : undefined}
          className={
            isStopping
              ? `${BTN} bg-warn-600 border-warn-600 text-ink-950 cursor-not-allowed`
              : isProcessing
                ? `${BTN} bg-bad-600 border-bad-600 text-white hover:bg-bad-500`
                : `${BTN} bg-accent-500 border-accent-500 text-accent-ink hover:bg-accent-400 disabled:bg-ink-800 disabled:border-ink-750 disabled:text-ink-600`
          }
        >
          {isStopping ? <><Loader2 className="w-4 h-4 animate-spin" />Stopping</>
            : isProcessing ? <><XCircle className="w-4 h-4" />Stop</>
            : benchmarkMode ? <><Gauge className="w-4 h-4" />Start benchmark</>
            : <><Sparkles className="w-4 h-4" />Start processing</>}
        </button>
      )}
    </div>
  );
});
