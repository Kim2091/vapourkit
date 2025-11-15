// c:\Users\mystery\Projects\SELL\TSPAN-GUI\src\components\ColorMatrixPanel.tsx

// src/components/ColorMatrixPanel.tsx
import { useState } from 'react';
import { Palette, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import type { ColorMatrixSettings, VideoInfo } from '../electron';

interface ColorMatrixPanelProps {
  settings: ColorMatrixSettings;
  isProcessing: boolean;
  videoInfo: VideoInfo | null;
  onSettingsChange: (settings: ColorMatrixSettings) => void;
}

export function ColorMatrixPanel({
  settings,
  isProcessing,
  videoInfo,
  onSettingsChange,
}: ColorMatrixPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if video format is RGB
  const isRgbFormat = videoInfo?.pixelFormat?.toLowerCase().includes('rgb') || 
                      videoInfo?.pixelFormat?.toLowerCase().includes('gbr') ||
                      videoInfo?.pixelFormat?.toLowerCase().includes('bgr');

  // Auto-disable checkbox if RGB is detected
  const handleCheckboxChange = (checked: boolean) => {
    if (isRgbFormat && checked) {
      // Don't allow enabling for RGB
      return;
    }
    onSettingsChange({ ...settings, overwriteMatrix: checked });
  };

  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800">
      {/* Header - Collapsible */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => settings.overwriteMatrix && !isRgbFormat && setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 flex-1 hover:opacity-80 transition-opacity"
          disabled={!settings.overwriteMatrix || isRgbFormat}
        >
          <Palette className="w-4 h-4 text-accent-cyan" />
          <h3 className="text-base font-semibold">Color Matrix</h3>
          {settings.overwriteMatrix && !isRgbFormat && (
            <span className="text-sm text-accent-cyan bg-accent-cyan/10 px-2 py-0.5 rounded">
              {settings.matrix709 ? 'BT.709' : 'BT.601'}
            </span>
          )}
          {settings.overwriteMatrix && !isRgbFormat && (isExpanded ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />)}
        </button>
        <div className="flex items-center gap-2 ml-2">
          <input
            type="checkbox"
            id="color-matrix-override"
            checked={settings.overwriteMatrix && !isRgbFormat}
            onChange={(e) => handleCheckboxChange(e.target.checked)}
            disabled={isProcessing || isRgbFormat}
            className="w-4 h-4 rounded border-gray-700 bg-dark-surface text-accent-cyan focus:ring-2 focus:ring-accent-cyan focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>

      {/* RGB Warning */}
      {isRgbFormat && (
        <div className="px-4 pb-3">
          <div className="flex items-start gap-2 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-500">
              Color matrix override is not available for RGB video formats
            </p>
          </div>
        </div>
      )}

      {/* Expandable Content */}
      {isExpanded && settings.overwriteMatrix && !isRgbFormat && (
        <div className="px-4 pb-3 space-y-3">
          {/* Matrix Selection Dropdown */}
          <div className="space-y-2">
            <label className="text-sm text-gray-400 block">
              Select color matrix:
            </label>
            <select
              value={settings.matrix709 ? '709' : '601'}
              onChange={(e) => onSettingsChange({ ...settings, matrix709: e.target.value === '709' })}
              disabled={isProcessing}
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-base"
            >
              <option value="709">BT.709 (HD - 720p and above)</option>
              <option value="601">BT.601 (SD - below 720p)</option>
            </select>
            <p className="text-sm text-gray-500">
              Does not apply to RGB inputs. Allows you to override the video's color space metadata (e.g. if it's incorrectly tagged). 
            </p>
          </div>
        </div>
      )}
    </div>
  );
}