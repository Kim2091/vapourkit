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
} from 'lucide-react';
import { useConsoleLog } from '../hooks/useConsoleLog';
import { ModalSectionHeader as SectionHeader } from './ModalSectionHeader';

interface PluginDependencyProgress {
  type: 'download' | 'extract' | 'install' | 'complete' | 'error';
  progress: number;
  message: string;
  package?: string;
}

interface PluginsModalProps {
  show: boolean;
  onClose: () => void;
  onInstallationComplete?: () => void;
}

export const PluginsModal = memo<PluginsModalProps>(({ show, onClose, onInstallationComplete }) => {
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<PluginDependencyProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
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

    const unsubscribe = window.electronAPI.onPluginDependencyProgress(async (nextProgress: PluginDependencyProgress) => {
      setProgress(nextProgress);

      if (nextProgress.type === 'complete') {
        setIsInstalling(false);
        setInstallError(null);
        await checkInstallationStatus();
        onInstallationComplete?.();
      } else if (nextProgress.type === 'error') {
        setIsInstalling(false);
        setInstallError(nextProgress.message);
      }
    });

    return unsubscribe;
  }, [show, onInstallationComplete]);

  const handleInstallDependencies = async () => {
    setIsInstalling(true);
    setProgress(null);
    setInstallError(null);

    try {
      const result = await window.electronAPI.installPluginDependencies();
      if (!result.success) {
        setInstallError(result.error || 'Installation failed');
        setIsInstalling(false);
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unknown error');
      setIsInstalling(false);
    }
  };

  const handleUninstallDependencies = async () => {
    setIsInstalling(true);
    setProgress(null);
    setInstallError(null);

    try {
      const result = await window.electronAPI.uninstallPluginDependencies();
      if (!result.success) {
        setInstallError(result.error || 'Uninstallation failed');
        setIsInstalling(false);
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unknown error');
      setIsInstalling(false);
    }
  };

  const handleCancelInstall = async () => {
    try {
      await window.electronAPI.cancelPluginDependencyInstall();
      setIsInstalling(false);
      setProgress(null);
    } catch (error) {
      console.error('Error canceling installation:', error);
    }
  };

  const handleRetry = () => {
    setInstallError(null);
    handleInstallDependencies();
  };

  if (!show) return null;

  const status = isCheckingStatus
    ? { label: 'Checking installation', detail: 'Verifying the installed VapourSynth package set.', tone: 'text-ink-400', icon: Loader2, spin: true }
    : isInstalling
      ? { label: 'Installation in progress', detail: progress?.message || 'Preparing the runtime package set.', tone: 'text-accent-400', icon: Loader2, spin: true }
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

            {installError && (
              <div className="px-4 py-3 border-b border-ink-900 bg-bad-500/5">
                <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-bad-400 mb-1">Error details</p>
                <p className="text-[11.5px] leading-relaxed text-bad-300 whitespace-pre-wrap">{installError}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 px-4 py-3">
              {!isInstalling && !installError && !isInstalled && (
                <button onClick={handleInstallDependencies} disabled={isCheckingStatus} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500 text-ink-950 hover:bg-accent-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  <Download className="w-3.5 h-3.5" />
                  Install plugins
                </button>
              )}
              {!isInstalling && !installError && isInstalled && (
                <>
                  <button onClick={handleInstallDependencies} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" />
                    Reinstall
                  </button>
                  <button onClick={handleUninstallDependencies} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold border border-bad-500/30 text-bad-400 hover:bg-bad-500/10 transition-colors">
                    <X className="w-3.5 h-3.5" />
                    Uninstall
                  </button>
                </>
              )}
              {isInstalling && (
                <button onClick={handleCancelInstall} className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold border border-bad-500/30 text-bad-400 hover:bg-bad-500/10 transition-colors">
                  <X className="w-3.5 h-3.5" />
                  Cancel
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
