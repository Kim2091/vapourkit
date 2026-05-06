// src/components/ProgressPanel.tsx - Progress bar, speed/ETA, and console

import { memo, useEffect, useRef } from 'react';
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react';
import type { UpscaleProgress } from '../electron.d';

interface ProgressPanelProps {
  upscaleProgress: UpscaleProgress | null;
  showConsole: boolean;
  setShowConsole: (show: boolean) => void;
  consoleOutput: string[];
  consoleEndRef: React.RefObject<HTMLDivElement | null>;
  privacyMode: boolean;
}

export const ProgressPanel = memo(function ProgressPanel({
  upscaleProgress,
  showConsole,
  setShowConsole,
  consoleOutput,
  consoleEndRef,
  privacyMode,
}: ProgressPanelProps) {
  const prevPrivacyModeRef = useRef(privacyMode);
  useEffect(() => {
    if (!prevPrivacyModeRef.current && privacyMode && showConsole) {
      setShowConsole(false);
    }
    prevPrivacyModeRef.current = privacyMode;
  }, [privacyMode, showConsole, setShowConsole]);

  return (
    <>
      {/* Progress & Controls */}
      <div className="flex-shrink-0 bg-dark-elevated rounded-2xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">{upscaleProgress?.message || 'Start an upscale!'}</span>
          <span className="text-sm text-gray-400">
            {upscaleProgress?.percentage !== undefined ? `${upscaleProgress.percentage}%` : 'N/A'}
          </span>
        </div>
        <div className="w-full bg-dark-surface rounded-full h-2 mb-3">
          <div
            className="bg-gradient-to-r from-primary-blue to-primary-purple h-2 rounded-full transition-all duration-300"
            style={{ width: `${upscaleProgress?.percentage ?? 0}%` }}
          />
        </div>
        <div className="flex items-center justify-between">
          {upscaleProgress?.fps ? (
            <p className="text-base text-gray-400 font-medium">Speed: {upscaleProgress.fps} FPS</p>
          ) : (
            <p className="text-base text-gray-400 font-medium">Speed: N/A</p>
          )}
          {upscaleProgress?.eta != null && upscaleProgress.eta > 0 && (
            <p className="text-base text-gray-400 font-medium">
              ETA: {upscaleProgress.eta >= 3600
                ? `${Math.floor(upscaleProgress.eta / 3600)}h ${Math.floor((upscaleProgress.eta % 3600) / 60)}m`
                : upscaleProgress.eta >= 60
                  ? `${Math.floor(upscaleProgress.eta / 60)}m ${upscaleProgress.eta % 60}s`
                  : `${upscaleProgress.eta}s`}
            </p>
          )}
        </div>
      </div>

      {/* Console */}
      <div className="flex-shrink-0 bg-dark-elevated rounded-2xl border border-gray-800 overflow-hidden">
        <button
          onClick={() => setShowConsole(!showConsole)}
          className="w-full px-4 py-3 border-b border-gray-800 flex items-center justify-between hover:bg-dark-surface transition-colors"
        >
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-accent-cyan" />
            <h2 className="font-semibold">Console</h2>
          </div>
          {showConsole ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>
        {showConsole && (
          <div className="p-4 max-h-64 overflow-y-auto font-mono text-sm bg-black/30">
            {consoleOutput.map((log, i) => (
              <div key={i} className="text-gray-300 mb-1">{log}</div>
            ))}
            <div ref={consoleEndRef as React.RefObject<HTMLDivElement>} />
          </div>
        )}
      </div>
    </>
  );
});
