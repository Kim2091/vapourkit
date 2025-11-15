import React, { useEffect, useState } from 'react';
import { Sparkles, Github, Heart, X } from 'lucide-react';

interface AboutModalProps {
  show: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ show, onClose }) => {
  const [version, setVersion] = useState<string>('');

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

  if (!show) return null;

  const openExternal = (url: string): void => {
    window.electronAPI.openExternal(url);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-md w-full">
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
        <div className="p-6 space-y-6">
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
          </div>

          <div className="space-y-3">
            <button
              onClick={() => openExternal('https://github.com/Kim2091')}
              className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-blue rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
            >
              <Github className="w-5 h-5 text-gray-400 group-hover:text-primary-blue transition-colors" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium text-white">See my GitHub Page!</p>
              </div>
            </button>

            <button
              onClick={() => openExternal('https://ko-fi.com/kim20913944')}
              className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-pink-500 rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
            >
              <Heart className="w-5 h-5 text-gray-400 group-hover:text-pink-500 transition-colors" />
              <div className="flex-1 text-left">
                <p className="text-sm font-medium text-white">Support me on Ko-fi</p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
