import React, { useState, useEffect, useRef } from 'react';
import { X, Download, RefreshCw, CheckCircle, XCircle, Loader2, Terminal, ChevronDown, ChevronUp } from 'lucide-react';

interface PluginDependencyProgress {
  type: 'installing' | 'complete' | 'error';
  progress: number;
  message: string;
}

interface PluginsModalProps {
  show: boolean;
  onClose: () => void;
  onInstallationComplete?: () => void;
}

export const PluginsModal: React.FC<PluginsModalProps> = ({ show, onClose, onInstallationComplete }) => {
  const [isInstalling, setIsInstalling] = useState(false);
  const [progress, setProgress] = useState<PluginDependencyProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [showConsole, setShowConsole] = useState(true);
  const [consoleOutput, setConsoleOutput] = useState<string[]>([]);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // Check installation status when modal opens
  useEffect(() => {
    if (show) {
      checkInstallationStatus();
    }
  }, [show]);

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
    if (!show) return;

    const unsubscribe = window.electronAPI.onPluginDependencyProgress(async (prog: PluginDependencyProgress) => {
      setProgress(prog);
      
      if (prog.type === 'complete') {
        setIsInstalling(false);
        setInstallError(null);
        // Recheck installation status after completion
        await checkInstallationStatus();
        // Notify parent component that installation completed
        onInstallationComplete?.();
      } else if (prog.type === 'error') {
        setIsInstalling(false);
        setInstallError(prog.message);
      }
    });

    return unsubscribe;
  }, [show, onInstallationComplete]);

  // Listen to developer console logs (same as developer mode)
  useEffect(() => {
    if (!show) return;

    const unsubscribe = window.electronAPI.onDevConsoleLog((log: any) => {
      const levelPrefix = log.level === 'error' ? '❌' : 
                         log.level === 'warn' ? '⚠️' : 
                         log.level === 'debug' ? '🔍' : 'ℹ️';
      const timestamp = new Date().toLocaleTimeString();
      const logMessage = `[${timestamp}] ${levelPrefix} [${log.level.toUpperCase()}] ${log.message}`;
      
      setConsoleOutput(prev => {
        const updated = [...prev, logMessage];
        // Keep only the last 300 lines
        return updated.length > 300 ? updated.slice(-300) : updated;
      });
    });

    return unsubscribe;
  }, [show]);

  // Auto-scroll console to bottom when new logs arrive
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleOutput]);

  const handleInstallDependencies = async () => {
    setIsInstalling(true);
    setProgress(null);
    setInstallError(null);
    setConsoleOutput([]);

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
    setConsoleOutput([]);

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-purple/20 rounded-lg">
              <Download className="w-6 h-6 text-primary-purple" />
            </div>
            <h2 className="text-2xl font-bold">Install Plugins</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Install Section */}
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Install Plugins & Dependencies</h3>
              <div className="text-gray-300 text-sm mb-4 space-y-2 leading-relaxed">
                <p>
                  Install plugins and dependencies to enable usage of pifroggi's vapoursynth filters (such as vs_temporalfix) and vs-jetpack plugins.
                </p>
                <p>
                  This will install PyTorch with CUDA, vsjetpack, and all required dependencies. It will also extract all plugins and scripts to vs-plugins and vs-scripts.
                </p>
                <p>
                  Click the button below to install these into VapourSynth's Python environment.
                </p>
                <p>
                  NOTE: PyTorch-based filters do not work on AMD or Intel GPUs due to reliance on CUDA.
                </p>
              </div>
            </div>

            {/* Progress Display */}
            {progress && (
              <div className="bg-dark-surface rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{progress.message}</span>
                  <span className="text-sm text-gray-400">{progress.progress}%</span>
                </div>
                <div className="w-full bg-dark-bg rounded-full h-2">
                  <div
                    className="bg-gradient-to-r from-primary-blue to-primary-purple h-2 rounded-full transition-all duration-300"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
                {progress.type === 'complete' && (
                  <div className="flex items-center gap-2 text-green-400">
                    <CheckCircle className="w-4 h-4" />
                    <span className="text-sm">Installation completed successfully!</span>
                  </div>
                )}
              </div>
            )}

            {/* Error Display */}
            {installError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-red-400 text-sm font-medium mb-1">Installation Failed</p>
                    <p className="text-red-300 text-sm">{installError}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3">
              {!isInstalling && !installError && !isInstalled && (
                <button
                  onClick={handleInstallDependencies}
                  disabled={isCheckingStatus}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-primary-blue to-primary-purple rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4" />
                  Install Plugins
                </button>
              )}

              {!isInstalling && !installError && isInstalled && (
                <>
                  <button
                    onClick={handleInstallDependencies}
                    className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-primary-blue to-primary-purple rounded-lg hover:opacity-90 transition-opacity"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Reinstall
                  </button>
                  <button
                    onClick={handleUninstallDependencies}
                    className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
                  >
                    <X className="w-4 h-4" />
                    Uninstall
                  </button>
                </>
              )}
              
              {isInstalling && (
                <button
                  onClick={handleCancelInstall}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
              )}
              
              {installError && (
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-primary-blue to-primary-purple rounded-lg hover:opacity-90 transition-opacity"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retry Installation
                </button>
              )}
            </div>

            {/* Status Indicator */}
            {isCheckingStatus && (
              <div className="flex items-center gap-2 text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Checking installation status...</span>
              </div>
            )}

            {isInstalling && (
              <div className="flex items-center gap-2 text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Processing...</span>
              </div>
            )}

            {!isInstalling && !installError && isInstalled && !isCheckingStatus && (
              <div className="flex items-center gap-2 text-green-400">
                <CheckCircle className="w-4 h-4" />
                <span className="text-sm">Plugins are installed</span>
              </div>
            )}
          </div>

          {/* Console Output Section */}
          <div className="border-t border-gray-800 pt-6">
            <div className="bg-dark-elevated rounded-lg border border-gray-800 overflow-hidden">
              <button
                onClick={() => setShowConsole(!showConsole)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-dark-surface transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-primary-purple" />
                  <h3 className="font-semibold">Installation Console</h3>
                  {consoleOutput.length > 0 && (
                    <span className="text-xs text-gray-400">({consoleOutput.length} lines)</span>
                  )}
                </div>
                {showConsole ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </button>
              {showConsole && (
                <div className="p-4 max-h-64 overflow-y-auto font-mono text-xs bg-black/30 border-t border-gray-800">
                  {consoleOutput.length > 0 ? (
                    <>
                      {consoleOutput.map((log, index) => (
                        <div key={index} className="text-gray-300 mb-1">
                          {log}
                        </div>
                      ))}
                      <div ref={consoleEndRef} />
                    </>
                  ) : (
                    <div className="text-gray-500 italic">No output yet...</div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Plugin Links Section */}
          <div className="border-t border-gray-800 pt-6">
            <h3 className="text-lg font-semibold mb-3">Plugin Resources</h3>
            <div className="bg-dark-surface rounded-lg p-4 space-y-3">
              <p className="text-gray-400 text-sm mb-2">
                Links to plugin documentation and resources:
              </p>
              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 min-w-fit">•</span>
                  <div>
                    <span className="text-gray-300">Most of pifroggi's filters: </span>
                    <a 
                      href="https://github.com/pifroggi" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary-blue hover:text-primary-purple underline transition-colors"
                    >
                      https://github.com/pifroggi
                    </a>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-gray-400 min-w-fit">•</span>
                  <div>
                    <span className="text-gray-300">The entirety of vs-jetpack: </span>
                    <a 
                      href="https://github.com/Jaded-Encoding-Thaumaturgy/vs-jetpack/" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary-blue hover:text-primary-purple underline transition-colors"
                    >
                      https://github.com/Jaded-Encoding-Thaumaturgy/vs-jetpack/
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-6 border-t border-gray-800">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-dark-surface hover:bg-gray-700 rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};