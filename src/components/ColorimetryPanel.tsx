// src/components/ColorimetryPanel.tsx
import { memo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ColorimetrySettings, VideoInfo } from '../electron';
import { Section } from './Section';

interface ColorimetryPanelProps {
  settings: ColorimetrySettings;
  isProcessing: boolean;
  videoInfo: VideoInfo | null;
  onSettingsChange: (settings: ColorimetrySettings) => void;
}

export const ColorimetryPanel = memo<ColorimetryPanelProps>(({
  settings,
  isProcessing,
  videoInfo,
  onSettingsChange,
}: ColorimetryPanelProps) => {
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
    <Section
      title="Colorimetry"
      meta={settings.overwriteMatrix && !isRgbFormat ? (settings.matrix709 ? 'BT.709' : 'BT.601') : 'off'}
      actions={
        <input
          type="checkbox"
          id="colorimetry-override"
          checked={settings.overwriteMatrix && !isRgbFormat}
          onChange={(e) => handleCheckboxChange(e.target.checked)}
          disabled={isProcessing || isRgbFormat}
          title="Override the video’s colour matrix metadata"
          className="w-3.5 h-3.5 rounded border-ink-700 bg-ink-850 disabled:opacity-40 disabled:cursor-not-allowed"
        />
      }
      collapsible={settings.overwriteMatrix && !isRgbFormat}
      open={isExpanded}
      onToggle={() => setIsExpanded(!isExpanded)}
    >

      {/* RGB Warning */}
      {isRgbFormat && (
        <div className="px-3 py-2 border-b border-ink-900">
          <div className="flex items-start gap-2 p-3 bg-warn-500/10 border border-warn-500/30 rounded-lg">
            <AlertTriangle className="w-4 h-4 text-warn-400 flex-shrink-0 mt-0.5" />
            <p className="text-[12px] text-warn-400">
              Colorimetry override is not available for RGB video formats
            </p>
          </div>
        </div>
      )}

      {/* Expandable Content */}
      {isExpanded && settings.overwriteMatrix && !isRgbFormat && (
        <div className="px-3 py-2.5 space-y-2 border-b border-ink-900">
          {/* Matrix Selection Dropdown */}
          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-wide text-ink-500 block">
              Select color matrix:
            </label>
            <select
              value={settings.matrix709 ? '709' : '601'}
              onChange={(e) => onSettingsChange({ ...settings, matrix709: e.target.value === '709' })}
              disabled={isProcessing}
              className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="709">BT.709 (HD - 720p and above)</option>
              <option value="601">BT.601 (SD - below 720p)</option>
            </select>
            <p className="text-[11px] text-ink-500">
              Does not apply to RGB inputs. Allows you to override the video's color space metadata (e.g. if it's incorrectly tagged). 
            </p>
          </div>
        </div>
      )}
    </Section>
  );
});
