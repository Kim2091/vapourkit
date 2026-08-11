import { memo, useEffect, useState } from 'react';
import { Sparkles, Github, Heart, X, FileText, ChevronDown, ChevronUp, Book } from 'lucide-react';
import { Logo } from './Logo';
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
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Sparkles className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">About</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close about"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="text-center px-6 pt-6 pb-5">
            {/* The one surface where the brand mark keeps its full colours (no monochrome prop) */}
            <Logo className="w-12 h-12 mx-auto mb-3" />
            <h3 className="font-display text-[15px] font-semibold uppercase tracking-[0.16em] text-ink-100 mb-1">
              Vapourkit
            </h3>
            {version && (
              <p className="text-ink-400 text-[11.5px] font-mono tabular-nums mb-0.5">
                v{version}
              </p>
            )}
            <p className="text-ink-400 text-[11.5px]">
              Made by Kim2091
            </p>

            {/* Credits */}
            <div className="mt-5 pt-4 border-t border-ink-900">
              <div className="text-center space-y-1.5">
                <p className="text-[12px] font-medium text-ink-300 italic">In loving memory of my Mom</p>
                <p className="text-[11px] text-ink-500 leading-relaxed max-w-md mx-auto">
                  Thank you for your love, support, and encouragement in everything I do
                </p>
                <p className="text-[11px] text-ink-500 pt-1">Rest in peace</p>
              </div>
            </div>
          </div>

          {/* Link ledger */}
          <div className="border-t border-ink-800">
            <button
              onClick={() => openExternal('https://github.com/Kim2091/vapourkit')}
              className="w-full h-9 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
            >
              <Github className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
              <span className="flex-1 truncate">View Vapourkit on GitHub</span>
            </button>

            <button
              onClick={() => openExternal('https://github.com/Kim2091/vapourkit/tree/main/docs')}
              className="w-full h-9 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
            >
              <Book className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
              <span className="flex-1 truncate">View Documentation</span>
            </button>

            <button
              onClick={() => openExternal('https://ko-fi.com/kim20913944')}
              className="w-full h-9 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
            >
              <Heart className="w-4 h-4 text-ink-500 group-hover:text-pink-500 transition-colors" />
              <span className="flex-1 truncate">Support me on Ko-fi!</span>
            </button>
          </div>

          {/* Model Licenses Section */}
          <section className="mt-2 border-t border-ink-700">
            <button
              onClick={() => setLicensesExpanded(!licensesExpanded)}
              aria-expanded={licensesExpanded}
              className="w-full h-9 flex items-stretch gap-2.5 pr-3 bg-ink-850 border-b border-ink-800 text-left hover:opacity-80 transition-opacity"
            >
              <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
              <span className="flex items-center gap-2 min-w-0 flex-1">
                <FileText className="w-3.5 h-3.5 text-ink-500" />
                <span className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Licenses for Included Models</span>
              </span>
              {licensesExpanded ? (
                <ChevronUp className="w-3.5 h-3.5 text-ink-500 self-center flex-shrink-0" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-ink-500 self-center flex-shrink-0" />
              )}
            </button>
            {licensesExpanded && (
              <>
                <p className="text-[11px] text-ink-500 px-4 pt-2 pb-1.5">
                  The following list shows the licenses for the models included with Vapourkit.
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {MODEL_LICENSES.map((model, index) => (
                    <div
                      key={index}
                      className="h-8 flex items-center justify-between gap-3 px-4 border-b border-ink-900"
                    >
                      <span className="text-[12px] text-ink-300 truncate">{model.name}</span>
                      <span className="text-[10.5px] font-mono text-ink-500 whitespace-nowrap">{model.license}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="h-9 flex-shrink-0 flex items-center justify-end gap-2 px-4 border-t border-ink-800 bg-ink-900 text-[11px] text-ink-500">
          <kbd className="px-1.5 py-0.5 bg-ink-850 border border-ink-750 rounded text-[10px] font-mono text-ink-300">Esc</kbd>
          <span>to close</span>
        </div>
      </div>
    </div>
  );
});
