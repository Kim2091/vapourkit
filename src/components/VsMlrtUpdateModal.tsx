import React, { useState } from 'react';
import { AlertTriangle, X, Trash2, RefreshCw, Loader2 } from 'lucide-react';
import type { VsMlrtVersionInfo } from '../electron';

interface VsMlrtUpdateModalProps {
  versionInfo: VsMlrtVersionInfo;
  onClose: () => void;
  onEnginesCleared: () => void;
}

export const VsMlrtUpdateModal: React.FC<VsMlrtUpdateModalProps> = ({
  versionInfo,
  onClose,
  onEnginesCleared,
}) => {
  const [isClearing, setIsClearing] = useState(false);
  const [clearResult, setClearResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleClearEngines = async () => {
    setIsClearing(true);
    setClearResult(null);
    
    try {
      const result = await window.electronAPI.clearEngineFiles();
      
      if (result.success) {
        // Update the stored version to current
        await window.electronAPI.updateVsMlrtVersion();
        
        setClearResult({
          success: true,
          message: `Successfully cleared ${result.deletedCount} engine file${result.deletedCount !== 1 ? 's' : ''}. You can now rebuild your engines.`
        });
        
        // Notify parent to refresh models
        onEnginesCleared();
      } else {
        setClearResult({
          success: false,
          message: result.error || 'Failed to clear engine files'
        });
      }
    } catch (error) {
      setClearResult({
        success: false,
        message: error instanceof Error ? error.message : 'An unknown error occurred'
      });
    } finally {
      setIsClearing(false);
    }
  };

  const handleDismiss = async () => {
    // Update the stored version so user isn't bothered again
    await window.electronAPI.updateVsMlrtVersion();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-lg w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-yellow-500" />
            <h2 className="text-xl font-bold">TensorRT Plugin Updated</h2>
          </div>
          <button
            onClick={handleDismiss}
            className="text-gray-400 hover:text-white transition-colors"
            disabled={isClearing}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {/* Version Info */}
          <div className="bg-dark-surface border border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-400">Previous Version</p>
                <p className="text-lg font-semibold text-white">v{versionInfo.storedVersion || 'Unknown'}</p>
              </div>
              <div className="text-yellow-500 text-2xl font-bold">→</div>
              <div>
                <p className="text-sm text-gray-400">Current Version</p>
                <p className="text-lg font-semibold text-green-400">v{versionInfo.currentVersion}</p>
              </div>
            </div>
          </div>

          {/* Warning Message */}
          <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4">
            <p className="text-sm text-yellow-200">
              <strong>Important:</strong> The vs-mlrt TensorRT plugin has been updated. Your existing 
              TensorRT engine files ({versionInfo.engineCount} found) may be incompatible with the 
              new version and could cause errors.
            </p>
          </div>

          <p className="text-gray-300 text-sm">
            We recommend clearing your existing engines and rebuilding them. This ensures 
            compatibility with the updated plugin.
          </p>

          {/* Result Message */}
          {clearResult && (
            <div className={`rounded-lg p-4 ${clearResult.success 
              ? 'bg-green-900/20 border border-green-700/50' 
              : 'bg-red-900/20 border border-red-700/50'
            }`}>
              <p className={`text-sm ${clearResult.success ? 'text-green-200' : 'text-red-200'}`}>
                {clearResult.message}
              </p>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            {!clearResult?.success && (
              <button
                onClick={handleClearEngines}
                disabled={isClearing}
                className="flex-1 bg-gradient-to-r from-red-600 to-red-500 hover:opacity-90 disabled:opacity-50 text-white font-semibold rounded-lg px-6 py-3 transition-all duration-300 flex items-center justify-center gap-2"
              >
                {isClearing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-5 h-5" />
                    Clear Engines & Rebuild
                  </>
                )}
              </button>
            )}
            
            <button
              onClick={handleDismiss}
              disabled={isClearing}
              className={`${clearResult?.success ? 'flex-1' : ''} bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold rounded-lg px-6 py-3 transition-colors flex items-center justify-center gap-2`}
            >
              {clearResult?.success ? (
                <>
                  <RefreshCw className="w-5 h-5" />
                  Done
                </>
              ) : (
                'Keep Existing Engines'
              )}
            </button>
          </div>

          {!clearResult?.success && (
            <p className="text-xs text-gray-500 text-center">
              Note: Keeping existing engines may result in processing errors if they're incompatible.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
