import { memo, useEffect, useState } from 'react';
import { Sparkles, Github, Heart, X, FileText, ChevronDown, ChevronUp, Book } from 'lucide-react';
import { MODEL_LICENSES } from '../data/modelLicenses';

interface AboutModalProps {
  show: boolean;
  onClose: () => void;
}

export const AboutModal = memo<AboutModalProps>(({ show, onClose }) => {
  const [version, setVersion] = useState<string>('');
  const [licensesExpanded, setLicensesExpanded] = useState<boolean>(false);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const result = await window.electronAPI.getVersion();
        setVersion(result.version);
      } catch (error) {
        console.error('Failed to fetch version:', error);
      }
    };
    
    if (show) {
      fetchVersion();
    }
  }, [show]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && show) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [show, onClose]);

  if (!show) return null;

  const openExternal = (url: string): void => {
    window.electronAPI.openExternal(url);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-primary-purple" />
            <h2 className="text-2xl font-bold">About</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          <div className="text-center">
            <h3 className="text-xl font-bold bg-gradient-to-r from-primary-blue via-primary-purple to-accent-cyan bg-clip-text text-transparent mb-2">
              Vapourkit
            </h3>
            {version && (
              <p className="text-gray-500 text-s mb-1">
                v{version}
              </p>
            )}
            <p className="text-gray-400 text-sm">
              Made by Kim2091
            </p>
            
            {/* Credits */}
            <div className="mt-6 pt-5 border-t border-gray-800/50">
              <div className="text-center space-y-2">
                <p className="text-sm font-medium text-gray-300 italic">In loving memory of my Mom</p>
                <p className="text-xs text-gray-400 leading-relaxed max-w-md mx-auto">
                  Thank you for your love, support, and encouragement in everything I do
                </p>
                <p className="text-xs text-gray-450 pt-1">Rest in peace</p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => openExternal('https://github.com/Kim2091/vapourkit')}
              className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-purple rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
            >
              <Github className="w-5 h-5 text-gray-400 group-hover:text-primary-purple transition-colors" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium text-white">View Vapourkit on GitHub</p>
              </div>
            </button>

            <button
              onClick={() => openExternal('https://github.com/Kim2091/vapourkit/tree/main/docs')}
              className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-blue rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
            >
              <Book className="w-5 h-5 text-gray-400 group-hover:text-primary-blue transition-colors" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium text-white">View Documentation</p>
              </div>
            </button>

            <button
              onClick={() => openExternal('https://ko-fi.com/kim20913944')}
              className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-pink-500 rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
            >
              <Heart className="w-5 h-5 text-gray-400 group-hover:text-pink-500 transition-colors" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium text-white">Support me on Ko-fi!</p>
              </div>
            </button>
          </div>

          {/* Model Licenses Section */}
          <div className="border-t border-gray-800 pt-6">
            <button
              onClick={() => setLicensesExpanded(!licensesExpanded)}
              className="w-full flex items-center justify-between gap-2 mb-4 hover:opacity-80 transition-opacity"
            >
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary-purple" />
                <h3 className="text-lg font-semibold text-white">Licenses for Included Models</h3>
              </div>
              {licensesExpanded ? (
                <ChevronUp className="w-5 h-5 text-gray-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-400" />
              )}
            </button>
            {licensesExpanded && (
              <>
                <p className="text-xs text-gray-500 mb-4">
                  The following list shows the licenses for the models included with Vapourkit.
                </p>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                  {MODEL_LICENSES.map((model, index) => (
                    <div
                      key={index}
                      className="bg-dark-surface border border-gray-700/50 rounded-lg px-3 py-2"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-sm text-white font-medium">{model.name}</span>
                        <span className="text-xs text-gray-400 whitespace-nowrap">{model.license}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          
          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-6 text-sm text-gray-400">
            <kbd className="px-2 py-0.5 bg-dark-elevated border border-gray-700 rounded text-gray-300">Esc</kbd>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>
  );
});
