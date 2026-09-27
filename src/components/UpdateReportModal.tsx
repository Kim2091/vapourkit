// The post-update notice.
//
// An update keeps data\, so it has to say what it did there: what it changed on
// its own, and which of the user's edited filters it left alone and why. The
// decisions come from the main process fresh on every open (see
// electron/templateReconcile.ts), so they always describe the files on disk.
// The notice opens itself once per update; after that it waits in Settings
// until every decision is made and it is cleared.

import { memo, useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, CheckCircle, ChevronDown, ChevronRight, FolderOpen, PackageCheck, Wrench, X } from 'lucide-react';
import { ModalSectionHeader as SectionHeader } from './ModalSectionHeader';
import type { TemplateDecision, TemplateDecisionChoice, UpdateReport, UpdateReportSnapshot } from '../electron';

interface UpdateReportModalProps {
  show: boolean;
  onClose: () => void;
}

/** "QTGMC _Old_.vkfilter" → "QTGMC (Old)": filenames spell parentheses as underscores. */
export function templateDisplayName(file: string): string {
  return file.replace(/\.vkfilter$/, '').replace(/ _([^_]+)_/g, ' ($1)');
}

const buttonBase = 'h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const primaryButton = `${buttonBase} bg-accent-500 text-ink-950 hover:bg-accent-400`;
const quietButton = `${buttonBase} bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700`;

const DecisionRow = memo<{
  decision: TemplateDecision;
  toVersion: string;
  busy: boolean;
  onResolve: (file: string, choice: TemplateDecisionChoice) => void;
}>(({ decision, toVersion, busy, onResolve }) => {
  const outdated = decision.kind === 'edited-outdated';
  const reason = outdated
    ? `You edited this filter, and ${toVersion} includes a newer version of it.`
    : decision.replacement
      ? `No longer included under this name: it is ${decision.replacement} now. Your edit was kept, but it may be out of date.`
      : 'No longer included, usually because the plugin it needs is not available. Your edit was kept, but it will probably fail if used.';

  return (
    <div className="px-4 py-2.5 border-b border-ink-900 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-ink-100 truncate">{decision.name}</p>
        <p className="text-[11px] leading-relaxed text-ink-500 mt-0.5">{reason}</p>
      </div>
      <div className="flex gap-1.5 flex-shrink-0 pt-0.5">
        {outdated ? (
          <>
            <button className={primaryButton} disabled={busy} onClick={() => onResolve(decision.file, 'replace')}>
              Use new version
            </button>
            <button className={quietButton} disabled={busy} onClick={() => onResolve(decision.file, 'keep')}>
              Keep mine
            </button>
          </>
        ) : (
          <>
            <button className={primaryButton} disabled={busy} onClick={() => onResolve(decision.file, 'remove')}>
              Remove
            </button>
            <button className={quietButton} disabled={busy} onClick={() => onResolve(decision.file, 'keep')}>
              Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
});

/** One collapsible line of what the update did on its own. */
const DoneRow = memo<{ label: string; items: string[]; format?: (item: string) => string }>(({ label, items, format }) => {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="border-b border-ink-900">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full h-8 flex items-center gap-2 px-4 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 transition-colors"
      >
        <Chevron className="w-3.5 h-3.5 text-ink-500 flex-shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        <span className="font-mono text-[11px] text-ink-500 tabular-nums">{items.length}</span>
      </button>
      {open && (
        <p className="px-4 pb-2.5 pl-[38px] text-[11px] leading-relaxed text-ink-400">
          {items.map(item => (format ? format(item) : item)).join(', ')}
        </p>
      )}
    </div>
  );
});

export const UpdateReportModal = memo<UpdateReportModalProps>(({ show, onClose }) => {
  const [snapshot, setSnapshot] = useState<UpdateReportSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backedUp, setBackedUp] = useState(false);

  useEffect(() => {
    if (!show) return;
    setError(null);
    window.electronAPI.getUpdateReport()
      .then(setSnapshot)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, [show]);

  const resolve = useCallback(async (file: string, choice: TemplateDecisionChoice) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.resolveTemplateDecision(file, choice);
      setSnapshot({ report: result.report, decisions: result.decisions });
      if (result.backupPath) setBackedUp(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const report: UpdateReport | null = snapshot?.report ?? null;
  const decisions = snapshot?.decisions ?? [];
  const settled = decisions.length === 0;

  // Closing with everything decided retires the report; with decisions left,
  // it stays reachable from Settings.
  const close = useCallback(async () => {
    if (settled && report) {
      await window.electronAPI.clearUpdateReport().catch(() => undefined);
    }
    onClose();
  }, [settled, report, onClose]);

  if (!show) return null;

  const toVersion = report?.toVersion ?? 'this version of Vapourkit';
  const nothingElse = report && [
    report.templatesUpdated, report.templatesRemoved, report.templatesAdded, report.packagesInstalled, report.pluginsUpdated,
    report.scriptsUpdated ?? [], report.scriptsKept ?? [],
  ].every(list => list.length === 0);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <PackageCheck className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">
              {report ? `Updated to ${report.toVersion}` : 'Edited filters'}
            </h2>
          </div>
          <button
            onClick={() => void close()}
            aria-label="Close update notes"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {report && (
          <div className="px-4 py-3 border-b border-ink-900 flex items-start gap-3">
            <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-ok-400" />
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-ok-400">
                {report?.fromVersion ? `Updated from ${report.fromVersion}. Nothing was set up again.` : 'Nothing was set up again.'}
              </p>
              <p className="text-[11px] leading-relaxed text-ink-500 mt-0.5">
                Your settings, workflows, custom filters, models, TensorRT engines and Python environment were all kept.
              </p>
            </div>
          </div>
          )}

          {decisions.length > 0 && (
            <section>
              <SectionHeader icon={Wrench} title={`Needs a decision (${decisions.length})`} />
              <p className="px-4 py-2.5 border-b border-ink-900 text-[11px] leading-relaxed text-ink-400">
                You changed these filters, so the update left them alone. Replacing or removing one saves your copy first.
                Saved workflows keep their own copy of each step, so nothing here changes them.
              </p>
              {decisions.map(decision => (
                <DecisionRow key={decision.file} decision={decision} toVersion={toVersion} busy={busy} onResolve={resolve} />
              ))}
            </section>
          )}

          {report && (
            <section className={decisions.length > 0 ? 'mt-2 border-t border-ink-700' : ''}>
              <SectionHeader icon={PackageCheck} title="Done automatically" />
              {nothingElse ? (
                <p className="px-4 py-2.5 border-b border-ink-900 text-[11px] text-ink-500">Nothing else needed changing.</p>
              ) : (
                <>
                  <DoneRow label="Filters updated to the new version" items={report.templatesUpdated} format={templateDisplayName} />
                  <DoneRow label="Filters removed (no longer included)" items={report.templatesRemoved} format={templateDisplayName} />
                  <DoneRow label="New filters" items={report.templatesAdded} format={templateDisplayName} />
                  <DoneRow label="Python packages installed" items={report.packagesInstalled} />
                  <DoneRow label="Plugins updated" items={report.pluginsUpdated} />
                  <DoneRow label="VapourSynth scripts updated" items={report.scriptsUpdated ?? []} />
                  <DoneRow label="Scripts you edited, kept as they were (new versions not installed)" items={report.scriptsKept ?? []} />
                </>
              )}
              <p className="px-4 py-2.5 text-[11px] leading-relaxed text-ink-500">
                Only filters and scripts you had not changed were updated or removed. Reinstalling plugins restores every shipped script, saving your edited ones first.
              </p>
            </section>
          )}

          {error && (
            <div className="px-4 py-3 border-t border-ink-900 bg-bad-500/5">
              <p className="text-[11.5px] leading-relaxed text-bad-300 whitespace-pre-wrap">{error}</p>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-t border-ink-800 bg-ink-850">
          {backedUp && (
            <button className={quietButton} onClick={() => void window.electronAPI.openTemplateBackups()}>
              <FolderOpen className="w-3.5 h-3.5" />
              Open backups
            </button>
          )}
          <span className="flex-1 text-[11px] text-ink-500 truncate">
            {!settled && 'You can come back to this from Settings.'}
          </span>
          <button className={settled ? primaryButton : quietButton} onClick={() => void close()}>
            {settled ? <CheckCircle className="w-3.5 h-3.5" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
            {settled ? 'Done' : 'Decide later'}
          </button>
        </div>
      </div>
    </div>
  );
});
