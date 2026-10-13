import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle, X } from 'lucide-react';
import { dialogs, type AskRequest } from '../utils/dialogs';
import { PrivacyVeil } from './PrivacyVeil';

/**
 * Shows the app's confirmation prompts (utils/dialogs.ts), one at a time,
 * above every modal. Enter confirms and Escape cancels; a dangerous choice
 * starts focused on Cancel, so a stray Enter does not delete anything. In
 * privacy mode the message (often a file path) is veiled like the rest.
 */
export const ConfirmDialogHost = memo<{ privacyMode: boolean }>(({ privacyMode }) => {
  const [requests, setRequests] = useState<AskRequest[]>([]);
  useEffect(() => dialogs.subscribe(setRequests), []);
  const current = requests[0];
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!current) return;
    (current.tone === 'danger' ? cancelRef : confirmRef).current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dialogs.answer(current.id, false);
      }
    };
    // Capture, so a modal underneath does not close on the same Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current]);

  if (!current) return null;
  const danger = current.tone === 'danger';
  const Icon = danger ? AlertTriangle : HelpCircle;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => dialogs.answer(current.id, false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`ask-title-${current.id}`}
        aria-describedby={`ask-message-${current.id}`}
        className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 w-[440px] max-w-[90vw]"
        onClick={event => event.stopPropagation()}
      >
        <div className="h-10 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className={`w-[3px] flex-shrink-0 ${danger ? 'bg-bad-500' : 'bg-accent-500'}`} aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Icon className={`w-4 h-4 ${danger ? 'text-bad-400' : 'text-ink-500'}`} />
            <h3 id={`ask-title-${current.id}`} className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 truncate">
              {current.title}
            </h3>
          </div>
          <button
            onClick={() => dialogs.answer(current.id, false)}
            aria-label="Cancel"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3.5">
          <PrivacyVeil enabled={privacyMode}>
            <p id={`ask-message-${current.id}`} className="text-[12.5px] leading-relaxed text-ink-200 whitespace-pre-line break-words">
              {current.message}
            </p>
          </PrivacyVeil>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-800">
          <button
            ref={confirmRef}
            onClick={() => dialogs.answer(current.id, true)}
            className={`flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center text-[12.5px] font-semibold border transition-colors ${danger
              ? 'bg-bad-600 border-bad-600 text-white hover:bg-bad-500'
              : 'bg-accent-500 border-accent-500 text-accent-ink hover:bg-accent-400'}`}
          >
            {current.confirmLabel ?? 'OK'}
          </button>
          <button
            ref={cancelRef}
            onClick={() => dialogs.answer(current.id, false)}
            className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors"
          >
            {current.cancelLabel ?? 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
});
