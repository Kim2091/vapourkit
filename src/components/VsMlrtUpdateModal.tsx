import { memo, useState, useEffect } from 'react';
import { AlertTriangle, X, RefreshCw, Loader2, ChevronDown, ChevronUp, Download, Check } from 'lucide-react';
import type { VsMlrtVersionInfo } from '../electron';

interface VsMlrtUpdateModalProps {
  versionInfo: VsMlrtVersionInfo;
  onClose: () => void;
  onEnginesCleared: () => void;
}

export const VsMlrtUpdateModal = memo<VsMlrtUpdateModalProps>(({
  versionInfo,
  onClose,
  onEnginesCleared,
}) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateComplete, setUpdateComplete] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

  // Listen for update progress
  useEffect(() => {
    const unsubscribe = window.electronAPI.onVsMlrtUpdateProgress((progress) => {
      setUpdateProgress(progress.progress);
      setUpdateMessage(progress.message);
    });

    return unsubscribe;
  }, []);

  const handleUpdateAndClear = async () => {
    setIsUpdating(true);
    setUpdateError(null);
    setUpdateProgress(0);
    setUpdateMessage('Starting update...');
    
    try {
      // First update the plugin
      const updateResult = await window.electronAPI.updateVsMlrtPlugin();
      
      if (!updateResult.success) {
        setUpdateError(updateResult.error || 'Failed to update vs-mlrt plugin');
        return;
      }
      
      setUpdateMessage('Clearing old engine files...');
      
      // Then clear the engines
      const clearResult = await window.electronAPI.clearEngineFiles();
      
      if (!clearResult.success) {
        setUpdateError(clearResult.error || 'Failed to clear engine files');
        return;
      }
      
      // Update the stored version
      await window.electronAPI.updateVsMlrtVersion();
      
      setUpdateComplete(true);
      setUpdateMessage(`Update complete! Cleared ${clearResult.deletedCount} engine file${clearResult.deletedCount !== 1 ? 's' : ''}.`);
      
      // Notify parent to refresh models
      onEnginesCleared();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : 'An unknown error occurred');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSkip = async () => {
    // Update the stored version so user isn't bothered again
    await window.electronAPI.updateVsMlrtVersion();
    onClose();
  };

  const handleDone = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-ink-850 rounded-2xl border border-ink-800 shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-ink-800">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-warn-500" />
            <h2 className="text-xl font-bold">TensorRT Plugin Updated</h2>
          </div>
          <button
            onClick={handleSkip}
            className="text-ink-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isUpdating}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Version Info */}
          <div className="bg-ink-900 border border-ink-700 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-400">Previous Version</p>
                <p className="text-lg font-semibold text-white">
                  {versionInfo.storedVersion ? `v${versionInfo.storedVersion}` : 'Pre-tracking'}
                </p>
              </div>
              <div className="text-warn-500 text-2xl font-bold">→</div>
              <div>
                <p className="text-sm text-ink-400">New Version</p>
                <p className="text-lg font-semibold text-ok-400">v{versionInfo.currentVersion}</p>
              </div>
            </div>
          </div>

          {/* Info Message */}
          <div className="bg-accent-900/20 border border-accent-700/50 rounded-lg p-4">
            <p className="text-sm text-accent-200">
              <strong>Plugin Update Required:</strong> A new version of the vs-mlrt TensorRT plugin 
              (v{versionInfo.currentVersion}) is available. Your existing TensorRT engine files 
              ({versionInfo.engineCount} found) were built with a different version and need to be cleared 
              and rebuilt to ensure compatibility.
            </p>
          </div>

          {/* Why Rebuild Section */}
          <div className="bg-ink-900 border border-ink-700 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-2 text-white">Why do I need to rebuild my engines?</h3>
            <p className="text-xs text-ink-300 leading-relaxed">
              TensorRT engine files are optimized binaries compiled specifically for your GPU and the 
              version of the TensorRT runtime. When the runtime is updated, existing engines may use 
              incompatible features or optimizations, leading to crashes or incorrect results. Rebuilding 
              ensures your engines work properly with the new version.
            </p>
          </div>

          {/* Progress Display */}
          {isUpdating && (
            <div className="bg-ink-900 border border-ink-700 rounded-lg p-4">
              <div className="flex items-center gap-3 mb-3">
                <Loader2 className="w-5 h-5 text-accent-500 animate-spin" />
                <p className="text-sm font-medium text-white">Updating Plugin...</p>
              </div>
              <div className="w-full bg-ink-950 rounded-full h-2 mb-2">
                <div 
                  className="bg-gradient-to-r from-accent-500 to-accent-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${updateProgress}%` }}
                />
              </div>
              <p className="text-xs text-ink-400">{updateMessage}</p>
            </div>
          )}

          {/* Error Message */}
          {updateError && (
            <div className="bg-bad-900/20 border border-bad-700/50 rounded-lg p-4">
              <p className="text-sm text-bad-200">
                <strong>Error:</strong> {updateError}
              </p>
            </div>
          )}

          {/* Success Message */}
          {updateComplete && (
            <div className="bg-ok-900/20 border border-ok-700/50 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Check className="w-5 h-5 text-ok-400" />
                <p className="text-sm font-semibold text-ok-200">Update Complete!</p>
              </div>
              <p className="text-sm text-ok-200">{updateMessage}</p>
              <p className="text-xs text-ink-400 mt-2">
                You can now rebuild your engines with the updated plugin.
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-3 pt-2">
            {!updateComplete && !updateError && (
              <button
                onClick={handleUpdateAndClear}
                disabled={isUpdating}
                className="w-full bg-gradient-to-r from-accent-500 to-accent-500 hover:opacity-90 disabled:opacity-50 text-white font-semibold rounded-lg px-6 py-3 transition-all duration-300 flex items-center justify-center gap-2"
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Start Update & Clear Engines
                  </>
                )}
              </button>
            )}

            {updateComplete && (
              <button
                onClick={handleDone}
                className="w-full bg-gradient-to-r from-accent-500 to-accent-500 hover:opacity-90 text-white font-semibold rounded-lg px-6 py-3 transition-all duration-300 flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-5 h-5" />
                Done!
              </button>
            )}

            {!updateComplete && !isUpdating && (
              <>
                {/* Advanced Options Dropdown */}
                <div className="border border-ink-700 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                    className="w-full bg-ink-900 hover:bg-ink-850 text-ink-300 font-medium px-4 py-2.5 transition-colors flex items-center justify-between"
                  >
                    <span className="text-sm">Advanced Options</span>
                    {showAdvancedOptions ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                  
                  {showAdvancedOptions && (
                    <div className="bg-ink-850 border-t border-ink-700 p-4">
                      <div className="bg-bad-900/20 border border-bad-700/50 rounded-lg p-3 mb-3">
                        <p className="text-xs text-bad-200 leading-relaxed mb-2">
                          <strong>⚠️ WARNING - For Advanced Users Only</strong>
                        </p>
                        <p className="text-xs text-bad-200 leading-relaxed">
                          Skipping this update will leave your plugin outdated. Existing engines may cause 
                          processing errors, crashes, or incorrect output. <strong>You will not receive 
                          support if you skip this update and encounter issues.</strong>
                        </p>
                      </div>
                      
                      <button
                        onClick={handleSkip}
                        className="w-full bg-ink-700 hover:bg-ink-600 text-white font-semibold rounded-lg px-4 py-2.5 transition-colors text-sm"
                      >
                        Skip Update (Not Recommended - No Support)
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
