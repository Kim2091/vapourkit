// OutputSettingsPanel.tsx
import { Download } from 'lucide-react';
import type { VideoInfo } from '../electron.d';

interface OutputSettingsPanelProps {
  videoInfo: VideoInfo | null;
  outputPath: string;
  outputFormat: string;
  isProcessing: boolean;
  onFormatChange: (format: string) => void;
  onSelectOutputFile: () => void;
}

export function OutputSettingsPanel({
  videoInfo,
  outputPath,
  outputFormat,
  isProcessing,
  onFormatChange,
  onSelectOutputFile,
}: OutputSettingsPanelProps) {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Download className="w-4 h-4 text-accent-cyan" />
        <h2 className="text-base font-semibold">Output Settings</h2>
      </div>
      
      <div className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Output Format</label>
          <select
            value={outputFormat}
            onChange={(e) => onFormatChange(e.target.value)}
            disabled={isProcessing}
            className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-base focus:outline-none focus:border-primary-purple transition-colors disabled:opacity-50"
          >
            <option value="mkv">MKV (Recommended)</option>
            <option value="mp4">MP4</option>
            <option value="mov">MOV</option>
            <option value="avi">AVI</option>
          </select>
        </div>
        
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Save Location</label>
          <button
            onClick={onSelectOutputFile}
            disabled={!videoInfo || isProcessing}
            className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-left hover:border-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {outputPath ? (
              <span className="text-sm truncate block">{outputPath}</span>
            ) : (
              <span className="text-sm text-gray-500">Choose output file...</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}