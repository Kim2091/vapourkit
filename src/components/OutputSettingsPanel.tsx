// OutputSettingsPanel.tsx
import { memo, useState, useEffect } from 'react';
import { Download, ChevronDown, ChevronUp, Sliders, Gauge } from 'lucide-react';
import type { VideoInfo } from '../electron.d';
import type { Codec, Preset, Encoder } from '../utils/ffmpegConfig';
import { PrivacyText } from './PrivacyVeil';
import {
  parseFfmpegArgs,
  generateFfmpegArgs,
  getRecommendedCrfRange,
  supportsCrf,
  supportsPreset,
  getAvailableEncoders,
  getEncoderDisplayName,
  getEncoderShortName,
  getDefaultPreset,
  getPresetDisplayName
} from '../utils/ffmpegConfig';

interface OutputSettingsPanelProps {
  videoInfo: VideoInfo | null;
  outputPath: string;
  outputFormat: string;
  ffmpegArgs: string;
  processingFormat: string;
  isProcessing: boolean;
  benchmarkMode: boolean;
  privacyMode: boolean;
  onFormatChange: (format: string) => void;
  onSelectOutputFile: () => void;
  onFfmpegArgsChange: (args: string) => void;
  onProcessingFormatChange: (format: string) => void;
  onBenchmarkModeChange: (enabled: boolean) => void;
}

export const OutputSettingsPanel = memo<OutputSettingsPanelProps>(({
  videoInfo,
  outputPath,
  outputFormat,
  ffmpegArgs,
  processingFormat,
  isProcessing,
  benchmarkMode,
  privacyMode,
  onFormatChange,
  onSelectOutputFile,
  onFfmpegArgsChange,
  onProcessingFormatChange,
  onBenchmarkModeChange,
}: OutputSettingsPanelProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  // Store advanced args separately so they persist when toggling modes
  const [storedAdvancedArgs, setStoredAdvancedArgs] = useState<string>('');

  // Load persisted expanded state on mount
  useEffect(() => {
    const loadExpandedState = async () => {
      try {
        const result = await window.electronAPI.getEncodingSettingsExpanded();
        setIsExpanded(result.expanded);
      } catch (error) {
        console.error('Failed to load encoding settings expanded state:', error);
      }
    };
    loadExpandedState();
  }, []);

  // Persist expanded state when it changes
  const handleToggleExpanded = async () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    try {
      await window.electronAPI.setEncodingSettingsExpanded(newExpanded);
    } catch (error) {
      console.error('Failed to save encoding settings expanded state:', error);
    }
  };

  // Parse current config from args (for simple mode display)
  const config = parseFfmpegArgs(ffmpegArgs);

  // When entering advanced mode, store the current args
  const handleToggleAdvancedMode = () => {
    if (!advancedMode) {
      // Entering advanced mode - if we have stored advanced args, restore them
      // Otherwise, keep the current args as the starting point
      if (storedAdvancedArgs) {
        onFfmpegArgsChange(storedAdvancedArgs);
      } else {
        setStoredAdvancedArgs(ffmpegArgs);
      }
    } else {
      // Leaving advanced mode - store current advanced args and regenerate simple args
      setStoredAdvancedArgs(ffmpegArgs);
      const simpleArgs = generateFfmpegArgs(config);
      onFfmpegArgsChange(simpleArgs);
    }
    setAdvancedMode(!advancedMode);
  };

  const handleCodecChange = (codec: Codec) => {
    const crfRange = getRecommendedCrfRange(codec);
    const availableEncodersForCodec = getAvailableEncoders(codec);
    
    // Preserve current encoder if it's available for the new codec, otherwise fall back to software
    const encoder = availableEncodersForCodec.includes(config.encoder) ? config.encoder : 'software' as Encoder;
    
    // Get appropriate default preset for the encoder and codec
    const preset = getDefaultPreset(encoder, codec);
    
    // ProRes only supports YUV422P10 and YUV444P10 - auto-select if current format is incompatible
    if (codec === 'prores') {
      const proresCompatibleFormats = ['vs.YUV422P10', 'vs.YUV444P10'];
      if (!proresCompatibleFormats.includes(processingFormat)) {
        onProcessingFormatChange('vs.YUV422P10');
      }
    }
    
    const newConfig = {
      ...config,
      codec,
      encoder,
      crf: crfRange.default,
      preset
    };
    onFfmpegArgsChange(generateFfmpegArgs(newConfig));
  };

  const handleEncoderChange = (encoder: Encoder) => {
    // Update preset to match encoder's defaults
    const preset = getDefaultPreset(encoder, config.codec);
    const newConfig = { ...config, encoder, preset };
    onFfmpegArgsChange(generateFfmpegArgs(newConfig));
  };

  const handlePresetChange = (preset: Preset) => {
    const newConfig = { ...config, preset };
    onFfmpegArgsChange(generateFfmpegArgs(newConfig));
  };

  const handleCrfChange = (crf: number) => {
    const newConfig = { ...config, crf };
    onFfmpegArgsChange(generateFfmpegArgs(newConfig));
  };

  const handleCustomArgsChange = (args: string) => {
    onFfmpegArgsChange(args);
  };

  const crfRange = getRecommendedCrfRange(config.codec);
  const availableEncoders = getAvailableEncoders(config.codec);

  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-accent-cyan" />
          <h3 className="text-base font-semibold">Output Settings</h3>
        </div>
        <button
          onClick={() => onBenchmarkModeChange(!benchmarkMode)}
          disabled={isProcessing}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            benchmarkMode
              ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 hover:bg-orange-500/30'
              : 'bg-dark-surface text-gray-400 border border-gray-700 hover:border-gray-600 hover:text-gray-300'
          }`}
          title="Benchmark mode: discard output and measure processing speed only"
        >
          <Gauge className="w-3.5 h-3.5" />
          Benchmark
        </button>
      </div>

      {/* Benchmark Mode Info */}
      {benchmarkMode && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 px-3 py-2.5 bg-orange-500/10 border border-orange-500/20 rounded-lg">
            <Gauge className="w-4 h-4 text-orange-400 flex-shrink-0" />
            <p className="text-xs text-orange-300">
              Output will be discarded. Measures processing speed only.
            </p>
          </div>
        </div>
      )}

      {/* Always Visible: Format & Save Location (hidden in benchmark mode) */}
      {!benchmarkMode && (
      <div className="px-4 py-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              Format
            </label>
            <select
              value={outputFormat}
              onChange={(e) => onFormatChange(e.target.value)}
              disabled={isProcessing}
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-base disabled:cursor-not-allowed"
            >
              <option value="mkv">MKV</option>
              <option value="mp4">MP4</option>
              <option value="mov">MOV</option>
              <option value="avi">AVI</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1.5">Save To</label>
            <button
              onClick={onSelectOutputFile}
              disabled={!videoInfo || isProcessing}
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-left hover:border-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm truncate"
            >
              {outputPath ? (
                <span className="truncate block">
                  <PrivacyText
                    enabled={privacyMode}
                    value={outputPath.split('\\').pop()?.split('/').pop() || outputPath}
                    maskLength={12}
                  />
                </span>
              ) : (
                <span className="text-gray-500">Browse...</span>
              )}
            </button>
          </div>
        </div>

        {/* Encoding Settings Expand/Collapse */}
        <button
          onClick={handleToggleExpanded}
          disabled={isProcessing}
          className="w-full flex items-center justify-between px-3 py-2.5 bg-gray-800/30 border border-gray-700/50 rounded-lg hover:bg-gray-800/50 hover:border-accent-cyan/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
        >
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-accent-cyan group-hover:text-accent-cyan transition-colors" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-accent-cyan transition-colors" />
            )}
            <span className="text-sm font-medium text-gray-300 group-hover:text-white transition-colors">
              Encoding Settings
            </span>
            {!advancedMode && (
              <>
                <span className="text-xs text-primary-purple bg-primary-purple/10 px-2 py-0.5 rounded">
                  {config.codec === 'custom' ? 'H264' : config.codec.toUpperCase()}
                </span>
                {availableEncoders.length > 1 && (
                  <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                    {getEncoderShortName(config.encoder)}
                  </span>
                )}
              </>
            )}
            {advancedMode && (
              <span className="text-xs text-accent-cyan bg-accent-cyan/10 px-2 py-0.5 rounded">
                Custom
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500 group-hover:text-gray-400 transition-colors">
            {isExpanded ? 'Hide' : 'Show'}
          </span>
        </button>
      </div>
      )}

      {/* Expandable Encoding Settings (hidden in benchmark mode) */}
      {!benchmarkMode && isExpanded && (
        <div className="px-4 pb-3 border-t border-gray-800 pt-3">
          <div className="space-y-3">
          {/* Simple Mode */}
          {!advancedMode && (
            <>
            {/* Codec Selection */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm font-medium text-gray-300">
                  Video Codec
                </label>
                {/* Advanced Mode Toggle */}
                <button
                  onClick={handleToggleAdvancedMode}
                  disabled={isProcessing}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${
                    advancedMode
                      ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30'
                      : 'bg-dark-surface text-gray-400 border border-gray-700 hover:border-gray-600 hover:text-gray-300'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" />
                  Advanced
                </button>
              </div>
              <select
                value={config.codec === 'custom' ? 'h264' : config.codec}
                onChange={(e) => handleCodecChange(e.target.value as Codec)}
                disabled={isProcessing}
                className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-base disabled:cursor-not-allowed"
              >
                <option value="h264">H.264 (AVC)</option>
                <option value="h265">H.265 (HEVC)</option>
                <option value="av1">AV1</option>
                <option value="prores">ProRes</option>
              </select>
            </div>

            {/* Pixel Format Selection (moved here) */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">
                Pixel Format
              </label>
              <select
                value={processingFormat}
                onChange={(e) => onProcessingFormatChange(e.target.value)}
                disabled={isProcessing}
                className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-base disabled:cursor-not-allowed"
              >
                <option value="vs.YUV420P8" disabled={config.codec === 'prores'}>YUV 4:2:0 8-Bit</option>
                <option value="vs.YUV420P10" disabled={config.codec === 'prores'}>YUV 4:2:0 10-Bit</option>
                <option value="vs.YUV422P10">YUV 4:2:2 10-Bit</option>
                <option value="vs.YUV444P8" disabled={config.codec === 'prores'}>YUV 4:4:4 8-Bit</option>
                <option value="vs.YUV444P10">YUV 4:4:4 10-Bit</option>
                <option value="vs.RGB24" disabled={config.codec === 'prores'}>RGB 8-Bit</option>
                <option value="match_input" disabled={config.codec === 'prores'}>Same as Input (Not Recommended)</option>
              </select>
            </div>

            {/* Encoder Selection */}
            {availableEncoders.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Encoder
                </label>
                <select
                  value={config.encoder}
                  onChange={(e) => handleEncoderChange(e.target.value as Encoder)}
                  disabled={isProcessing}
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-base disabled:cursor-not-allowed"
                >
                  {availableEncoders.map((encoder) => (
                    <option key={encoder} value={encoder}>
                      {getEncoderDisplayName(encoder)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Preset Selection (not for ProRes) */}
            {supportsPreset(config.codec) && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-300">
                    Encoding Speed
                  </label>
                  <span className="text-xs text-gray-500">
                    {getPresetDisplayName(config.preset)}
                  </span>
                </div>
                <select
                  value={config.preset}
                  onChange={(e) => handlePresetChange(e.target.value as Preset)}
                  disabled={isProcessing}
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-base disabled:cursor-not-allowed"
                >
                  {config.encoder === 'nvidia' && (
                    <>
                      <option value="p1">P1 - Fastest</option>
                      <option value="p2">P2 - Faster</option>
                      <option value="p3">P3 - Fast</option>
                      <option value="p4">P4 - Medium</option>
                      <option value="p5">P5 - Slow</option>
                      <option value="p6">P6 - Slower</option>
                      <option value="p7">P7 - Slowest (Recommended)</option>
                    </>
                  )}
                  {config.encoder === 'amd' && (
                    <>
                      <option value="speed">Speed - Fast Encode</option>
                      <option value="balanced">Balanced</option>
                      <option value="quality">Quality - Best (Recommended)</option>
                    </>
                  )}
                  {config.encoder === 'intel' && (
                    <>
                      <option value="veryfast">Very Fast</option>
                      <option value="faster">Faster</option>
                      <option value="fast">Fast</option>
                      <option value="medium">Medium</option>
                      <option value="slow">Slow</option>
                      <option value="slower">Slower</option>
                      <option value="veryslow">Very Slow (Recommended)</option>
                    </>
                  )}
                  {config.encoder === 'software' && config.codec !== 'av1' && (
                    <>
                      <option value="ultrafast">Ultra Fast</option>
                      <option value="superfast">Super Fast</option>
                      <option value="veryfast">Very Fast</option>
                      <option value="faster">Faster</option>
                      <option value="fast">Fast</option>
                      <option value="medium">Medium (Recommended)</option>
                      <option value="slow">Slow</option>
                      <option value="slower">Slower</option>
                      <option value="veryslow">Very Slow</option>
                    </>
                  )}
                  {config.encoder === 'software' && config.codec === 'av1' && (
                    <>
                      <option value="12">12 - Fastest</option>
                      <option value="11">11</option>
                      <option value="10">10</option>
                      <option value="9">9</option>
                      <option value="8">8 - Balanced (Recommended)</option>
                      <option value="7">7</option>
                      <option value="6">6</option>
                      <option value="5">5</option>
                      <option value="4">4</option>
                      <option value="3">3</option>
                      <option value="2">2</option>
                      <option value="1">1</option>
                      <option value="0">0 - Slowest (Best Quality)</option>
                    </>
                  )}
                </select>
              </div>
            )}

            {/* CRF Quality (not for ProRes) */}
            {supportsCrf(config.codec) && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-300">
                    Quality
                  </label>
                  <span className="text-sm font-medium text-accent-cyan">
                    CRF {config.crf}
                  </span>
                </div>
                <input
                  type="range"
                  min={crfRange.min}
                  max={crfRange.max}
                  value={config.crf}
                  onChange={(e) => handleCrfChange(parseInt(e.target.value, 10))}
                  disabled={isProcessing}
                  className="w-full h-2 bg-dark-surface rounded-lg appearance-none cursor-pointer accent-accent-cyan disabled:opacity-50"
                />
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>Best ({crfRange.min})</span>
                  <span>Default ({crfRange.default})</span>
                  <span>Fast ({crfRange.max})</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* Advanced Mode - Raw FFmpeg Args */}
        {advancedMode && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-gray-300">
                FFmpeg Arguments
              </label>
              {/* Advanced Mode Toggle */}
              <button
                onClick={handleToggleAdvancedMode}
                disabled={isProcessing}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${
                  advancedMode
                    ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/30'
                    : 'bg-dark-surface text-gray-400 border border-gray-700 hover:border-gray-600 hover:text-gray-300'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                Advanced
              </button>
            </div>
            <textarea
              value={ffmpegArgs}
              onChange={(e) => {
                handleCustomArgsChange(e.target.value);
                setStoredAdvancedArgs(e.target.value);
              }}
              disabled={isProcessing}
              placeholder="-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1"
              rows={3}
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-accent-cyan transition-colors disabled:opacity-50 text-sm font-mono resize-none"
            />
            <p className="text-xs text-gray-500 mt-1.5">
              Custom FFmpeg encoding arguments
            </p>
          </div>
        )}

        </div>
      </div>
      )}
    </div>
  );
});
