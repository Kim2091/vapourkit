// src/components/ConsoleDrawer.tsx — the console, as a drawer over the preview.
//
// It used to be a permanent card whose entire job when collapsed was to render
// its own title row. Now it costs nothing until you open it, and when you do
// it borrows from the preview rather than from the settings column.

import { memo, useEffect, useRef } from 'react';
import { Terminal, X } from 'lucide-react';

interface ConsoleDrawerProps {
  open: boolean;
  onClose: () => void;
  consoleOutput: string[];
  consoleEndRef: React.RefObject<HTMLDivElement | null>;
  privacyMode: boolean;
}

export const ConsoleDrawer = memo(function ConsoleDrawer({
  open,
  onClose,
  consoleOutput,
  consoleEndRef,
  privacyMode,
}: ConsoleDrawerProps) {
  // Turning privacy mode on closes the console — log lines carry file paths.
  const prevPrivacyModeRef = useRef(privacyMode);
  useEffect(() => {
    if (!prevPrivacyModeRef.current && privacyMode && open) onClose();
    prevPrivacyModeRef.current = privacyMode;
  }, [privacyMode, open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-x-0 bottom-0 z-20 h-[280px] flex flex-col bg-ink-900/97 backdrop-blur-sm border-t border-ink-750 rounded-b-lg overflow-hidden">
      <div className="h-8 flex-shrink-0 flex items-center gap-2 px-3 border-b border-ink-800">
        <Terminal className="w-3.5 h-3.5 text-accent-500" />
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">
          Console
        </span>
        <span className="text-[11px] text-ink-500 tabular-nums">{consoleOutput.length} lines</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          aria-label="Close console"
          title="Close console (Esc)"
          className="w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed bg-ink-950/60">
        {consoleOutput.length === 0 ? (
          <p className="text-ink-600">Nothing logged yet.</p>
        ) : (
          consoleOutput.map((log, i) => (
            <div key={i} className="text-ink-300 whitespace-pre-wrap break-words">{log}</div>
          ))
        )}
        <div ref={consoleEndRef as React.RefObject<HTMLDivElement>} />
      </div>
    </div>
  );
});
