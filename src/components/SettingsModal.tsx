import { memo, useState, useEffect } from 'react';
import { Settings, Info, Terminal, FolderOpen, X, Package, FileCode, RotateCcw, Cpu, Play, ChevronDown, ChevronUp, HardDrive, Palette } from 'lucide-react';
import type { BackendId } from '../electron.d';
import { BACKENDS } from '../utils/backends';
import { DEFAULT_ACCENT_COLOR } from '../hooks/useAccentColor';
import { DEFAULT_MAIN_COLOR } from '../hooks/useMainColor';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  defaultBackend: BackendId;
  onChangeBackend: (backend: BackendId) => void;
  showBackendOverrides: boolean;
  onToggleBackendOverrides: (value: boolean) => void;
  numStreams: number;
  onUpdateNumStreams: (value: number) => void;
  videoCompareArgs: string;
  onUpdateVideoCompareArgs: (args: string) => void;
  onResetVideoCompareArgs: () => void;
  defaultOutputFolder: string | null;
  onUpdateDefaultOutputFolder: (folder: string | null) => void;
  onResetDefaultOutputFolder: () => void;
  descriptiveNamingEnabled: boolean;
  onUpdateDescriptiveNamingEnabled: (enabled: boolean) => void;
  mainColor: string;
  onChangeMainColor: (color: string) => void;
  onResetMainColor: () => void;
  accentColor: string;
  onChangeAccentColor: (color: string) => void;
  onResetAccentColor: () => void;
}

type Tab = 'general' | 'processing';

export const SettingsModal = memo<SettingsModalProps>(({
  show,
  onClose,
  defaultBackend,
  onChangeBackend,
  showBackendOverrides,
  onToggleBackendOverrides,
  numStreams,
  onUpdateNumStreams,
  videoCompareArgs,
  onUpdateVideoCompareArgs,
  onResetVideoCompareArgs,
  defaultOutputFolder,
  onUpdateDefaultOutputFolder,
  onResetDefaultOutputFolder,
  descriptiveNamingEnabled,
  onUpdateDescriptiveNamingEnabled,
  mainColor,
  onChangeMainColor,
  onResetMainColor,
  accentColor,
  onChangeAccentColor,
  onResetAccentColor,
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [showVideoCompareOptions, setShowVideoCompareOptions] = useState(false);

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

  const handleOpenLogsFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openLogsFolder();
    } catch (error) {
      console.error('Error opening logs folder:', error);
    }
  };

  const handleOpenConfigFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openConfigFolder();
    } catch (error) {
      console.error('Error opening config folder:', error);
    }
  };

  const handleOpenVSPluginsFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openVSPluginsFolder();
    } catch (error) {
      console.error('Error opening VS plugins folder:', error);
    }
  };

  const handleOpenVSScriptsFolder = async (): Promise<void> => {
    try {
      await window.electronAPI.openVSScriptsFolder();
    } catch (error) {
      console.error('Error opening VS scripts folder:', error);
    }
  };

  const handleSelectDefaultOutputFolder = async (): Promise<void> => {
    try {
      const folder = await window.electronAPI.selectFolder();
      if (folder) {
        onUpdateDefaultOutputFolder(folder);
      }
    } catch (error) {
      console.error('Error selecting default output folder:', error);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Settings className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Settings</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="h-9 flex-shrink-0 flex items-stretch gap-1 border-b border-ink-800 px-3">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-3 text-[11.5px] font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 ${
              activeTab === 'general'
                ? 'border-accent-500 text-accent-400'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            General
          </button>
          <button
            onClick={() => setActiveTab('processing')}
            className={`px-3 text-[11.5px] font-semibold border-b-2 transition-colors inline-flex items-center gap-1.5 ${
              activeTab === 'processing'
                ? 'border-accent-500 text-accent-400'
                : 'border-transparent text-ink-400 hover:text-ink-200'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            Processing
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'general' && (
            <>
              {/* Inference Backend Section */}
              <section className="mt-2 border-t border-ink-700 first:mt-0 first:border-t-0">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Cpu className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Inference Backend</h3>
                  </div>
                </div>

                {/* Default backend selection (options from the backend registry) */}
                <p className="px-4 pt-2.5 pb-1 text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Default Backend</p>
                {BACKENDS.map(backend => (
                  <label key={backend.id} className="flex items-start gap-3 cursor-pointer px-4 py-2 border-b border-ink-900 hover:bg-ink-850 transition-colors">
                    <input
                      type="radio"
                      name="default-backend"
                      checked={defaultBackend === backend.id}
                      onChange={() => onChangeBackend(backend.id)}
                      className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12.5px] text-ink-200">{backend.label}</p>
                      <p className="text-[11px] text-ink-500 mt-0.5">{backend.description}</p>
                    </div>
                  </label>
                ))}
                <label className="flex items-start gap-3 cursor-pointer px-4 py-2 border-b border-ink-900 hover:bg-ink-850 transition-colors">
                  <input
                    type="checkbox"
                    checked={showBackendOverrides}
                    onChange={(e) => onToggleBackendOverrides(e.target.checked)}
                    className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] text-ink-200">Per-filter backend overrides</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">
                      Adds a backend selector to each AI model filter so individual filters can deviate from the default. Filters that already have an override keep working (and show a badge) even when this is off.
                    </p>
                  </div>
                </label>

                {/* num_streams setting */}
                {(
                  <div className="px-4 py-2.5 border-b border-ink-900">
                    <label className="block">
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Number of Streams (num_streams)</p>
                        <span className="text-[12px] font-mono tabular-nums text-accent-400">{numStreams}</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="4"
                        value={numStreams}
                        onChange={(e) => onUpdateNumStreams(parseInt(e.target.value, 10))}
                        className="w-full h-1.5 cursor-pointer"
                      />
                      <p className="text-[11px] text-ink-500 mt-1.5">
                        Controls the number of concurrent inference streams. Higher values may improve performance on powerful GPUs but increase VRAM usage. Default is 2.
                      </p>
                    </label>
                  </div>
                )}

                {/* Backend comparison hint */}
                <div className="flex items-start gap-2.5 px-4 py-2.5">
                  <Info className="w-3.5 h-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
                  <div className="text-[11px] text-ink-500 min-w-0">
                    <p className="font-medium text-ink-400 mb-1">Backend Comparison:</p>
                    <ul className="space-y-1">
                      {BACKENDS.map(backend => (
                        <li key={backend.id}><strong className="text-ink-300 font-medium">{backend.label}:</strong> {backend.description}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>

              {/* Accent Color Section */}
              <section className="mt-2 border-t border-ink-700">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Palette className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Appearance</h3>
                  </div>
                </div>

                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-ink-900">
                  <label htmlFor="main-color" className="flex-1 min-w-0 cursor-pointer">
                    <p className="text-[12.5px] text-ink-200">Main Color</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">Tint the interface surfaces while keeping the application dark.</p>
                  </label>
                  <input
                    id="main-color"
                    type="color"
                    value={mainColor}
                    onChange={(event) => onChangeMainColor(event.target.value)}
                    aria-label="Choose main color"
                    className="w-9 h-7 p-0.5 rounded bg-ink-850 border border-ink-750 cursor-pointer"
                  />
                  <code className="w-[68px] text-[11px] font-mono text-ink-400 uppercase">{mainColor}</code>
                  <button
                    type="button"
                    onClick={onResetMainColor}
                    disabled={mainColor === DEFAULT_MAIN_COLOR}
                    className="text-[11px] text-accent-400 hover:text-accent-300 transition-colors disabled:text-ink-600 disabled:cursor-not-allowed"
                  >
                    Reset
                  </button>
                </div>

                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-ink-900">
                  <label htmlFor="accent-color" className="flex-1 min-w-0 cursor-pointer">
                    <p className="text-[12.5px] text-ink-200">Accent Color</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">Customize highlights, controls, and active states throughout Vapourkit.</p>
                  </label>
                  <input
                    id="accent-color"
                    type="color"
                    value={accentColor}
                    onChange={(event) => onChangeAccentColor(event.target.value)}
                    aria-label="Choose accent color"
                    className="w-9 h-7 p-0.5 rounded bg-ink-850 border border-ink-750 cursor-pointer"
                  />
                  <code className="w-[68px] text-[11px] font-mono text-ink-400 uppercase">{accentColor}</code>
                  <button
                    type="button"
                    onClick={onResetAccentColor}
                    disabled={accentColor === DEFAULT_ACCENT_COLOR}
                    className="text-[11px] text-accent-400 hover:text-accent-300 transition-colors disabled:text-ink-600 disabled:cursor-not-allowed"
                  >
                    Reset
                  </button>
                </div>
              </section>

              {/* VapourSynth Folders Section */}
              <section className="mt-2 border-t border-ink-700">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Package className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">VapourSynth</h3>
                  </div>
                </div>

                {/* Open VS Plugins Folder */}
                <button
                  onClick={handleOpenVSPluginsFolder}
                  className="w-full h-8 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
                >
                  <Package className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
                  <span className="flex-1 truncate">VS Plugins</span>
                  <FolderOpen className="w-3.5 h-3.5 text-ink-600 group-hover:text-ink-400 transition-colors" />
                </button>

                {/* Open VS Scripts Folder */}
                <button
                  onClick={handleOpenVSScriptsFolder}
                  className="w-full h-8 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
                >
                  <FileCode className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
                  <span className="flex-1 truncate">VS Scripts</span>
                  <FolderOpen className="w-3.5 h-3.5 text-ink-600 group-hover:text-ink-400 transition-colors" />
                </button>
              </section>

              {/* Application Folders Section */}
              <section className="mt-2 border-t border-ink-700">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <FolderOpen className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Application Folders</h3>
                  </div>
                </div>

                {/* Open Config Folder */}
                <button
                  onClick={handleOpenConfigFolder}
                  className="w-full h-8 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
                >
                  <Settings className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
                  <span className="flex-1 truncate">Config</span>
                  <FolderOpen className="w-3.5 h-3.5 text-ink-600 group-hover:text-ink-400 transition-colors" />
                </button>

                {/* Open Logs Folder */}
                <button
                  onClick={handleOpenLogsFolder}
                  className="w-full h-8 flex items-center gap-2.5 px-4 border-b border-ink-900 text-left text-[12.5px] text-ink-300 hover:bg-ink-850 hover:text-ink-200 transition-colors group"
                >
                  <Terminal className="w-4 h-4 text-ink-500 group-hover:text-ink-400 transition-colors" />
                  <span className="flex-1 truncate">Logs</span>
                  <FolderOpen className="w-3.5 h-3.5 text-ink-600 group-hover:text-ink-400 transition-colors" />
                </button>
              </section>
            </>
          )}

          {activeTab === 'processing' && (
            <>
              {/* Default Output Folder Section */}
              <section className="mt-2 border-t border-ink-700 first:mt-0 first:border-t-0">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <HardDrive className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Output Location</h3>
                  </div>
                </div>

                <div className="px-4 py-2.5 border-b border-ink-900">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Default Output Folder</p>
                    <button
                      onClick={onResetDefaultOutputFolder}
                      className="text-[11px] text-accent-400 hover:text-accent-300 transition-colors flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset to Default
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={defaultOutputFolder || ''}
                      readOnly
                      className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] text-ink-300 placeholder-ink-500 focus:outline-none focus:border-accent-500 transition-colors"
                      placeholder="Not set (use input video folder)"
                    />
                    <button
                      onClick={handleSelectDefaultOutputFolder}
                      className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors flex-shrink-0"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Browse
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-500 mt-1.5">
                    Set a default folder for all processed videos. If not set, videos will be saved in the same folder as the input video.
                  </p>
                </div>

                {/* Descriptive Naming Toggle */}
                <label className="flex items-start gap-3 cursor-pointer px-4 py-2 border-b border-ink-900 hover:bg-ink-850 transition-colors">
                  <input
                    type="checkbox"
                    checked={descriptiveNamingEnabled}
                    onChange={(e) => onUpdateDescriptiveNamingEnabled(e.target.checked)}
                    className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12.5px] text-ink-200">Descriptive Output Filenames</p>
                    <p className="text-[11px] text-ink-500 mt-0.5">
                      Include workflow details in auto-generated output filenames (e.g., EpisodeName-colorimetry_denoise_4x_resize2160.mkv). When disabled, uses the legacy "_processed" suffix.
                    </p>
                  </div>
                </label>
              </section>

              {/* Video Compare Configuration Section */}
              <section className="mt-2 border-t border-ink-700">
                <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                  <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Play className="w-3.5 h-3.5 text-ink-500" />
                    <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Video Compare</h3>
                  </div>
                </div>

                <div className="px-4 py-2.5">
                  <div className="block">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Command Line Arguments</p>
                      <button
                        onClick={onResetVideoCompareArgs}
                        className="text-[11px] text-accent-400 hover:text-accent-300 transition-colors flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Reset to Default
                      </button>
                    </div>
                    <input
                      type="text"
                      value={videoCompareArgs}
                      onChange={(e) => onUpdateVideoCompareArgs(e.target.value)}
                      className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] text-ink-200 font-mono focus:outline-none focus:border-accent-500 transition-colors"
                      placeholder="-W"
                    />
                    <p className="text-[11px] text-ink-500 mt-1.5">
                      Arguments passed to video-compare when launching comparison view. Default: <code className="font-mono text-ink-300">-W</code> (window fit display)
                    </p>

                    {/* Collapsible Options Reference */}
                    <div className="mt-2">
                      <button
                        onClick={() => setShowVideoCompareOptions(!showVideoCompareOptions)}
                        className="flex items-center gap-1.5 text-[11px] text-accent-400 hover:text-accent-300 transition-colors"
                      >
                        {showVideoCompareOptions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {showVideoCompareOptions ? 'Hide' : 'Show'} available options
                      </button>

                      {showVideoCompareOptions && (
                        <div className="mt-2 px-3 py-2 bg-ink-950 rounded border border-ink-800 max-h-64 overflow-y-auto">
                          <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1.5">Available Options:</p>
                          <ul className="text-[11px] text-ink-500 space-y-1 font-mono">
                            <li><code className="text-ink-300">-c, --show-controls</code> - show controls</li>
                            <li><code className="text-ink-300">-v, --verbose</code> - enable verbose output</li>
                            <li><code className="text-ink-300">-d, --high-dpi</code> - allow high DPI mode for UHD content</li>
                            <li><code className="text-ink-300">-b, --10-bpc</code> - use 10 bits per color component</li>
                            <li><code className="text-ink-300">-F, --fast-alignment</code> - fast bilinear scaling for alignment</li>
                            <li><code className="text-ink-300">-I, --bilinear-texture</code> - bilinear video texture interpolation</li>
                            <li><code className="text-ink-300">-n, --display-number</code> - open on specific display (0, 1, 2)</li>
                            <li><code className="text-ink-300">-m, --mode</code> - display mode: split, vstack, hstack</li>
                            <li><code className="text-ink-300">-w, --window-size</code> - window size [width]x[height]</li>
                            <li><code className="text-ink-300">-W, --window-fit-display</code> - fit window within display bounds</li>
                            <li><code className="text-ink-300">-a, --auto-loop-mode</code> - auto-loop: off, on, pp (ping-pong)</li>
                            <li><code className="text-ink-300">-f, --frame-buffer-size</code> - frame buffer size (default: 50)</li>
                            <li><code className="text-ink-300">-t, --time-shift</code> - shift right video timestamps</li>
                            <li><code className="text-ink-300">-s, --wheel-sensitivity</code> - mouse wheel sensitivity</li>
                            <li><code className="text-ink-300">-C, --color-space</code> - color space matrix (e.g. bt709, bt2020nc)</li>
                            <li><code className="text-ink-300">-A, --color-range</code> - color range (tv, pc)</li>
                            <li><code className="text-ink-300">-P, --color-primaries</code> - color primaries (bt709, bt2020)</li>
                            <li><code className="text-ink-300">-N, --color-trc</code> - transfer characteristics</li>
                            <li><code className="text-ink-300">-T, --tone-map-mode</code> - HDR tone mapping: auto, off, on, rel</li>
                            <li><code className="text-ink-300">-L, --left-peak-nits</code> - left video peak luminance</li>
                            <li><code className="text-ink-300">-R, --right-peak-nits</code> - right video peak luminance</li>
                            <li><code className="text-ink-300">-B, --boost-tone</code> - tone-mapping strength factor</li>
                            <li><code className="text-ink-300">-i, --filters</code> - FFmpeg filters for both sides</li>
                            <li><code className="text-ink-300">-l, --left-filters</code> - FFmpeg filters for left video</li>
                            <li><code className="text-ink-300">-r, --right-filters</code> - FFmpeg filters for right video</li>
                            <li><code className="text-ink-300">--demuxer</code> - FFmpeg demuxer name</li>
                            <li><code className="text-ink-300">--decoder</code> - FFmpeg decoder name</li>
                            <li><code className="text-ink-300">--hwaccel</code> - hardware acceleration (cuda, vulkan, etc.)</li>
                            <li><code className="text-ink-300">--libvmaf-options</code> - libvmaf filter options</li>
                            <li><code className="text-ink-300">--no-auto-filters</code> - disable automatic filters</li>
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}
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
