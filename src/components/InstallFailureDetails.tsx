// The collapsible part of an install failure: the output lines the summary
// was drawn from, and where the full log is.
//
// Shared by the setup screen and the Plugins window, which both show the
// one-sentence summary up front and keep this behind "Details": the summary
// is what most people need, and the evidence is what a bug report needs.

import { memo } from 'react';
import { ChevronRight, FolderOpen } from 'lucide-react';
import type { InstallFailureInfo } from '../electron.d';

export const InstallFailureDetails = memo<{ failure: InstallFailureInfo }>(({ failure }) => {
  if (!failure.evidence && !failure.logPath) return null;

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-[11px] font-display font-semibold uppercase tracking-[0.09em] text-bad-400 hover:text-bad-300 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
        Details
      </summary>
      {failure.evidence && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-ink-950 border border-ink-800 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-300 whitespace-pre-wrap break-all">
          {failure.evidence}
        </pre>
      )}
      {failure.logPath && (
        <div className="mt-1.5 flex items-start gap-2">
          <p className="flex-1 min-w-0 text-[11px] leading-relaxed text-ink-500 break-all">
            Full log: <span className="font-mono text-ink-400">{failure.logPath}</span>
          </p>
          <button
            type="button"
            onClick={() => { void window.electronAPI.openLogsFolder(); }}
            className="h-6 px-2 flex-shrink-0 rounded inline-flex items-center gap-1 text-[11px] font-semibold border border-ink-750 text-ink-300 hover:bg-ink-800 transition-colors"
          >
            <FolderOpen className="w-3 h-3" />
            Open logs
          </button>
        </div>
      )}
    </details>
  );
});

/** Warnings from an install that otherwise went ahead, kept on screen rather than flashed past. */
export const InstallWarnings = memo<{ warnings: string[] }>(({ warnings }) => {
  if (warnings.length === 0) return null;
  return (
    <div className="p-3 bg-warn-500/10 border border-warn-500/20 rounded-lg space-y-1.5">
      {warnings.map(warning => (
        <p key={warning} className="text-[11.5px] leading-relaxed text-warn-300">{warning}</p>
      ))}
    </div>
  );
});
