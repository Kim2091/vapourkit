import { memo, useState, useEffect } from 'react';
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Loader2,
  Package,
  RefreshCw,
  Terminal,
  X,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { useConsoleLog } from '../hooks/useConsoleLog';
import { ModalSectionHeader as SectionHeader } from './ModalSectionHeader';
import { DlssRuntimeSection } from './DlssRuntimeSection';
import { InstallFailureDetails, InstallWarnings } from './InstallFailureDetails';
import type { InstallFailureInfo, InstallResult, PluginDependencyProgress } from '../electron.d';

interface PluginsModalProps {
  show: boolean;
  onClose: () => void;
  onInstallationComplete?: () => void;
}

export const PluginsModal = memo<PluginsModalProps>(({ show, onClose, onInstallationComplete }) => {
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<PluginDependencyProgress | null>(null);
  const [installError, setInstallError] = useState<InstallFailureInfo | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Cancel was asked for and the operation has not stopped yet
  const [isCancelling, setIsCancelling] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const { consoleOutput, consoleEndRef } = useConsoleLog();

  const checkInstallationStatus = async () => {
    setIsCheckingStatus(true);
    try {
      const result = await window.electronAPI.checkPluginDependencies();
      setIsInstalled(result.installed);
    } catch (error) {
      console.error('Error checking installation status:', error);
      setIsInstalled(false);
    } finally {
      setIsCheckingStatus(false);
    }
  };

  useEffect(() => {
    if (show) {
      checkInstallationStatus();
    }
  }, [show]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && show) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [show, onClose]);

  useEffect(() => {
    if (!show) return;

    const unsubscribe = window.electronAPI.onPluginDependencyProgress((nextProgress: PluginDependencyProgress) => {
      // A warning stops nothing; keep it listed rather than letting the next
      // progress message overwrite it.
      if (nextProgress.type === 'warning') {
        setWarnings(previous => previous.includes(nextProgress.message) ? previous : [...previous, nextProgress.message]);
        return;
      }

      setProgress(nextProgress);

      if (nextProgress.type === 'complete') {
        setIsInstalling(false);
        setIsCancelling(false);
        setInstallError(null);
        if (nextProgress.warnings) setWarnings(nextProgress.warnings);
        void checkInstallationStatus().then(() => onInstallationComplete?.());
      } else if (nextProgress.type === 'error') {
        setIsInstalling(false);
        setIsCancelling(false);
        setInstallError({
          summary: nextProgress.summary ?? nextProgress.message,
          evidence: nextProgress.evidence,
          logPath: nextProgress.logPath,
        });
      }
    });

    return unsubscribe;
  }, [show, onInstallationComplete]);

  /**
   * What the install or uninstall replied once it ended. This, not the
   * cancel click, is what returns the window to idle: the operation replies
   * only after it has actually stopped, and the window may have been closed
   * (and missed the progress events) while it ran.
   */
  const settle = (result: InstallResult, fallback: string) => {
    setIsCancelling(false);
    setIsInstalling(false);
    if (result.success) {
      if (result.warnings) setWarnings(result.warnings);
      return;
    }
    if (result.cancelled) {
      setProgress(null);
      return;
    }
    setInstallError(previous => previous ?? {
      summary: result.summary ?? result.error ?? fallback,
      evidence: result.evidence,
      logPath: result.logPath,
    });
  };

  const startOperation = async (run: () => Promise<InstallResult>, fallback: string) => {
    setIsInstalling(true);
    setIsCancelling(false);
    setProgress(null);
    setInstallError(null);
    setWarnings([]);

    try {
      settle(await run(), fallback);
    } catch (error) {
      setInstallError({ summary: error instanceof Error ? error.message : 'Unknown error' });
      setIsInstalling(false);
      setIsCancelling(false);
    }
  };

  // Which reinstall ran last, so Retry repeats it.
  const [lastMode, setLastMode] = useState<'partial' | 'complete'>('partial');

  const handleInstallDependencies = (mode: 'partial' | 'complete' = 'partial') => {
    setLastMode(mode);
    return startOperation(() => window.electronAPI.installPluginDependencies(mode), 'Installation failed');
  };

  const handleCompleteReinstall = () => {
    if (!confirm(
      'Complete reinstall?\n\n'
      + 'Every plugin package is removed and downloaded again, and every built-in filter and script goes back to how Vapourkit ships it. '
      + 'Filters and scripts you edited are backed up to data\\config first. Your own filters are not touched.',
    )) return;
    void handleInstallDependencies('complete');
  };

  const handleUninstallDependencies = () =>
    startOperation(() => window.electronAPI.uninstallPluginDependencies(), 'Uninstallation failed');

  const handleCancelInstall = async () => {
    setIsCancelling(true);
    try {
      await window.electronAPI.cancelPluginDependencyInstall();
    } catch (error) {
      console.error('Error canceling installation:', error);
      setIsCancelling(false);
    }
  };

  const handleRetry = () => {
    setInstallError(null);
    void handleInstallDependencies(lastMode);
  };

  if (!show) return null;

  const status = isCheckingStatus
    ? { label: 'Checking installation', detail: 'Verifying the installed VapourSynth package set.', tone: 'text-ink-400', icon: Loader2, spin: true }
    : isInstalling
      ? isCancelling
        ? { label: 'Cancelling', detail: 'Stopping the running step; this can take a few seconds.', tone: 'text-ink-300', icon: Loader2, spin: true }
        : { label: 'Installation in progress', detail: progress?.message || 'Preparing the runtime package set.', tone: 'text-accent-400', icon: Loader2, spin: true }
      : installError
        ? { label: 'Installation failed', detail: 'Review the error details below, then retry when ready.', tone: 'text-bad-400', icon: XCircle, spin: false }
        : isInstalled
          ? { label: 'Plugins installed', detail: 'The VapourSynth runtime and bundled filters are ready to use.', tone: 'text-ok-400', icon: CheckCircle, spin: false }
          : { label: 'Plugins not installed', detail: 'Install the runtime package set to enable plugin-based filters.', tone: 'text-ink-300', icon: Package, spin: false };
  const StatusIcon = status.icon;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Package className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Plugins</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close plugins"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <section>
            <SectionHeader icon={Package} title="Runtime & Dependencies" />
            <div className="px-4 py-3 border-b border-ink-900">
              <div className="flex items-start gap-3">
                <StatusIcon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${status.tone} ${status.spin ? 'animate-spin' : ''}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-[12.5px] font-medium ${status.tone}`}>{status.label}</p>
                  <p className="text-[11px] leading-relaxed text-ink-500 mt-0.5">{status.detail}</p>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-b border-ink-900">
              <p className="text-[11px] leading-relaxed text-ink-400">
                Installs PyTorch, vsjetpack, vs-mlrt, and pifroggi&apos;s packages from PyPI. Packages follow the detected GPU: NVIDIA uses TensorRT and CUDA; AMD and Intel use DirectML. PyTorch-only filters run on CPU without NVIDIA CUDA.
              </p>
            </div>

            {progress && (
              <div className="px-4 py-3 border-b border-ink-900">
                <div className="flex items-center justify-between gap-3 mb-2 text-[11.5px]">
                  <span className="text-ink-300 truncate">{progress.message}</span>
                  <span className="font-mono text-ink-500 tabular-nums flex-shrink-0">{progress.progress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-ink-950">
                  <div className="h-full rounded-full bg-accent-500 transition-all duration-300" style={{ width: `${progress.progress}%` }} />
                </div>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="px-4 py-3 border-b border-ink-900">
                <InstallWarnings warnings={warnings} />
              </div>
            )}

            {installError && (
              <div className="px-4 py-3 border-b border-ink-900 bg-bad-500/5">
                <p className="text-[11px] font-display font-semibold uppercase tracking-[0.09em] text-bad-400 mb-1">What went wrong</p>
                <p className="text-[12.5px] leading-relaxed text-bad-300 whitespace-pre-wrap">{installError.summary}</p>
                <InstallFailureDetails failure={installError} />
              </div>
            )}

            {!isInstalling && !installError && isInstalled && (
              <dl className="px-4 py-3 border-b border-ink-900 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[11px] leading-relaxed">
                <dt className="font-semibold text-ink-300">Partial</dt>
                <dd className="text-ink-400">
                  Installs any package that is missing or out of date, and any built-in filter that is missing. Everything you changed stays as it is: edited filters and scripts, and filters you deleted. Try this first when filters stop working.
                </dd>
                <dt className="font-semibold text-ink-300">Complete</dt>
                <dd className="text-ink-400">
                  Removes the plugin packages and installs them again from scratch, which fixes a damaged package that a partial reinstall leaves in place. Every built-in filter and script goes back to how Vapourkit ships it, including ones you deleted. Edited copies are saved to <span className="font-mono text-ink-300">{String.raw`data\config\template-backups`}</span> and <span className="font-mono text-ink-300">script-backups</span> first. Filters you made yourself are never touched. It downloads several GB again.
                </dd>
              </dl>
            )}

            <div className="flex flex-wrap gap-2 px-4 py-3">
              {!isInstalling && !installError && !isInstalled && (
                <button onClick={() => void handleInstallDependencies('partial')} disabled={isCheckingStatus} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500 text-ink-950 hover:bg-accent-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  <Download className="w-3.5 h-3.5" />
                  Install plugins
                </button>
              )}
              {!isInstalling && !installError && isInstalled && (
                <>
                  <button
                    onClick={() => void handleInstallDependencies('partial')}
                    title="Installs anything missing or outdated. Keeps every filter and script you changed."
                    className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Partial reinstall
                  </button>
                  <button
                    onClick={handleCompleteReinstall}
                    title="Reinstalls every plugin package from scratch and puts every built-in filter and script back to stock."
                    className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Complete reinstall
                  </button>
                  <button onClick={handleUninstallDependencies} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold border border-bad-500/30 text-bad-400 hover:bg-bad-500/10 transition-colors">
                    <X className="w-3.5 h-3.5" />
                    Uninstall
                  </button>
                </>
              )}
              {isInstalling && (
                <button onClick={handleCancelInstall} disabled={isCancelling} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold border border-bad-500/30 text-bad-400 hover:bg-bad-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                  {isCancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              )}
              {installError && (
                <button onClick={handleRetry} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500 text-ink-950 hover:bg-accent-400 transition-colors">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Retry installation
                </button>
              )}
            </div>
          </section>

          <DlssRuntimeSection />

          <section className="mt-2 border-t border-ink-700">
            <button onClick={() => setShowConsole(!showConsole)} aria-expanded={showConsole} className="w-full text-left">
              <SectionHeader
                icon={Terminal}
                title="Installation Console"
                action={
                  <>
                    {consoleOutput.length > 0 && <span className="mr-2 text-[10.5px] font-mono text-ink-500">{consoleOutput.length}</span>}
                    {showConsole ? <ChevronUp className="w-3.5 h-3.5 text-ink-500" /> : <ChevronDown className="w-3.5 h-3.5 text-ink-500" />}
                  </>
                }
              />
            </button>
            {showConsole && (
              <div className="max-h-64 overflow-y-auto bg-ink-950 px-4 py-3 font-mono text-[10.5px] leading-relaxed border-b border-ink-900">
                {consoleOutput.length > 0 ? (
                  <>
                    {consoleOutput.map((log, index) => <div key={index} className="text-ink-400 break-all">{log}</div>)}
                    <div ref={consoleEndRef} />
                  </>
                ) : <p className="text-ink-600 italic">No installation output yet.</p>}
              </div>
            )}
          </section>

          <section className="mt-2 border-t border-ink-700">
            <SectionHeader icon={ExternalLink} title="Resources" />
            {[
              ['pifroggi filters', 'https://github.com/pifroggi'],
              ['vs-jetpack', 'https://github.com/Jaded-Encoding-Thaumaturgy/vs-jetpack/'],
              ['Hybrid VapourSynth scripts', 'https://github.com/Selur/VapoursynthScriptsInHybrid/'],
            ].map(([label, href]) => (
              <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="group h-9 flex items-center gap-2.5 px-4 border-b border-ink-900 text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors">
                <ExternalLink className="w-3.5 h-3.5 text-ink-600 group-hover:text-ink-400 transition-colors" />
                <span className="flex-1 truncate">{label}</span>
              </a>
            ))}
          </section>
        </div>

        <div className="h-9 flex-shrink-0 flex items-center justify-end gap-2 px-4 border-t border-ink-800 bg-ink-900 text-[11px] text-ink-500">
          <kbd className="px-1.5 py-0.5 bg-ink-850 border border-ink-750 rounded text-[10px] font-mono text-ink-300">Esc</kbd>
          <span>to close</span>
        </div>
      </div>
    </div>
  );
});
