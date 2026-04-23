import { memo, useState, useEffect } from 'react';
import { Settings, Info, Terminal, FolderOpen, X, Package, FileCode, RotateCcw, Cpu, Play, ChevronDown, ChevronUp, HardDrive } from 'lucide-react';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  useDirectML: boolean;
  onToggleDirectML: (value: boolean) => void;
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
}

type Tab = 'general' | 'processing';

export const SettingsModal = memo<SettingsModalProps>(({ 
  show, 
  onClose, 
  useDirectML, 
  onToggleDirectML,
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <Settings className="w-6 h-6 text-primary-blue" />
            <h2 className="text-2xl font-bold">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800 px-6">
          <button
            onClick={() => setActiveTab('general')}
            className={`py-4 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'general'
                ? 'border-primary-blue text-primary-blue'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Settings className="w-4 h-4" />
            General
          </button>
          <button
            onClick={() => setActiveTab('processing')}
            className={`py-4 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'processing'
                ? 'border-primary-blue text-primary-blue'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Cpu className="w-4 h-4" />
            Processing
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 flex-1 overflow-y-auto">
          {activeTab === 'general' && (
            <>
              {/* Inference Backend Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Cpu className="w-5 h-5 text-primary-blue" />
                  Inference Backend
                </h3>
                
                {/* DirectML Toggle */}
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useDirectML}
                      onChange={(e) => onToggleDirectML(e.target.checked)}
                      className="w-5 h-5 rounded border-gray-600 bg-dark-bg text-primary-blue focus:ring-2 focus:ring-primary-blue mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">Use DirectML (ONNX Runtime)</p>
                      <p className="text-xs text-gray-400 mt-1">
                        Enable DirectML backend for broader GPU compatibility (AMD, Intel, NVIDIA). Uses ONNX models directly without requiring TensorRT engine conversion.
                      </p>
                      {!useDirectML && (
                        <p className="text-xs text-blue-400 mt-2 flex items-center gap-1">
                          <Info className="w-3 h-3" />
                          Currently using TensorRT (NVIDIA only, requires engine conversion)
                        </p>
                      )}
                    </div>
                  </label>
                </div>

                {/* TensorRT num_streams setting - only show when DirectML is disabled */}
                {!useDirectML && (
                  <div className="bg-dark-surface rounded-lg p-4 border border-gray-700 mt-4">
                    <label className="block">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-white">Number of Streams (num_streams)</p>
                        <span className="text-sm text-primary-blue font-semibold">{numStreams}</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="4"
                        value={numStreams}
                        onChange={(e) => onUpdateNumStreams(parseInt(e.target.value, 10))}
                        className="w-full h-2 bg-dark-bg rounded-lg appearance-none cursor-pointer"
                        style={{
                          background: `linear-gradient(to right, rgb(59 130 246) 0%, rgb(59 130 246) ${((numStreams - 1) / 3) * 100}%, rgb(31 41 55) ${((numStreams - 1) / 3) * 100}%, rgb(31 41 55) 100%)`
                        }}
                      />
                      <p className="text-xs text-gray-400 mt-2">
                        Controls the number of concurrent inference streams in TensorRT. Higher values may improve performance on powerful GPUs but increase VRAM usage. Default is 2.
                      </p>
                    </label>
                  </div>
                )}

                {/* Info Box */}
                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mt-4">
                  <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                    <div className="text-xs text-gray-300">
                      <p className="font-medium mb-2">Backend Comparison:</p>
                      <ul className="space-y-1.5 text-[11px] text-gray-400">
                        <li><strong className="text-white">TensorRT:</strong> Fastest performance on NVIDIA GPUs, requires engine conversion</li>
                        <li><strong className="text-white">DirectML:</strong> Works on AMD/Intel/NVIDIA GPUs, uses ONNX directly, but is much slower. Prefer TensorRT for NVIDIA GPUs.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* Folders Grid - VapourSynth and Application Folders side by side */}
              <div className="grid grid-cols-2 gap-6">
                {/* VapourSynth Folders Section */}
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Package className="w-5 h-5 text-primary-purple" />
                    VapourSynth
                  </h3>
                  
                  <div className="space-y-2">
                    {/* Open VS Plugins Folder */}
                    <button
                      onClick={handleOpenVSPluginsFolder}
                      className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-purple rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
                    >
                      <Package className="w-5 h-5 text-gray-400 group-hover:text-primary-purple transition-colors" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium text-white">VS Plugins</p>
                      </div>
                      <FolderOpen className="w-4 h-4 text-gray-600 group-hover:text-primary-purple transition-colors" />
                    </button>

                    {/* Open VS Scripts Folder */}
                    <button
                      onClick={handleOpenVSScriptsFolder}
                      className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-primary-purple rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
                    >
                      <FileCode className="w-5 h-5 text-gray-400 group-hover:text-primary-purple transition-colors" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium text-white">VS Scripts</p>
                      </div>
                      <FolderOpen className="w-4 h-4 text-gray-600 group-hover:text-primary-purple transition-colors" />
                    </button>
                  </div>
                </div>

                {/* Application Folders Section */}
                <div>
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <FolderOpen className="w-5 h-5 text-accent-cyan" />
                    Application Folders
                  </h3>
                  
                  <div className="space-y-2">
                    {/* Open Config Folder */}
                    <button
                      onClick={handleOpenConfigFolder}
                      className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-accent-cyan rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
                    >
                      <Settings className="w-5 h-5 text-gray-400 group-hover:text-accent-cyan transition-colors" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium text-white">Config</p>
                      </div>
                      <FolderOpen className="w-4 h-4 text-gray-600 group-hover:text-accent-cyan transition-colors" />
                    </button>

                    {/* Open Logs Folder */}
                    <button
                      onClick={handleOpenLogsFolder}
                      className="w-full bg-dark-surface hover:bg-dark-bg border border-gray-700 hover:border-accent-cyan rounded-lg px-4 py-3 transition-all duration-300 flex items-center gap-3 group"
                    >
                      <Terminal className="w-5 h-5 text-gray-400 group-hover:text-accent-cyan transition-colors" />
                      <div className="flex-1 text-left">
                        <p className="text-sm font-medium text-white">Logs</p>
                      </div>
                      <FolderOpen className="w-4 h-4 text-gray-600 group-hover:text-accent-cyan transition-colors" />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'processing' && (
            <>
              {/* Default Output Folder Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <HardDrive className="w-5 h-5 text-orange-500" />
                  Output Location
                </h3>
                
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-white">Default Output Folder</p>
                      <button
                        onClick={onResetDefaultOutputFolder}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
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
                        className="flex-1 bg-dark-bg border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                        placeholder="Not set (use input video folder)"
                      />
                      <button
                        onClick={handleSelectDefaultOutputFolder}
                        className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                      >
                        <FolderOpen className="w-4 h-4" />
                        Browse
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      Set a default folder for all processed videos. If not set, videos will be saved in the same folder as the input video.
                    </p>
                  </label>
                </div>

                {/* Descriptive Naming Toggle */}
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700 mt-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={descriptiveNamingEnabled}
                      onChange={(e) => onUpdateDescriptiveNamingEnabled(e.target.checked)}
                      className="w-5 h-5 rounded border-gray-600 bg-dark-bg text-primary-blue focus:ring-2 focus:ring-primary-blue mt-0.5"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">Descriptive Output Filenames</p>
                      <p className="text-xs text-gray-400 mt-1">
                        Include workflow details in auto-generated output filenames (e.g., EpisodeName-colorimetry_denoise_4x_resize2160.mkv). When disabled, uses the legacy "_processed" suffix.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Video Compare Configuration Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Play className="w-5 h-5 text-green-500" />
                  Video Compare
                </h3>
                
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-white">Command Line Arguments</p>
                      <button
                        onClick={onResetVideoCompareArgs}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Reset to Default
                      </button>
                    </div>
                    <input
                      type="text"
                      value={videoCompareArgs}
                      onChange={(e) => onUpdateVideoCompareArgs(e.target.value)}
                      className="w-full bg-dark-bg border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-green-500 font-mono"
                      placeholder="-W"
                    />
                    <p className="text-xs text-gray-400 mt-2">
                      Arguments passed to video-compare when launching comparison view. Default: <code className="text-green-400">-W</code> (window fit display)
                    </p>
                    
                    {/* Collapsible Options Reference */}
                    <div className="mt-3">
                      <button
                        onClick={() => setShowVideoCompareOptions(!showVideoCompareOptions)}
                        className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        {showVideoCompareOptions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {showVideoCompareOptions ? 'Hide' : 'Show'} available options
                      </button>
                      
                      {showVideoCompareOptions && (
                        <div className="mt-3 p-3 bg-dark-bg rounded border border-gray-700 max-h-64 overflow-y-auto">
                          <p className="text-xs font-medium text-white mb-2">Available Options:</p>
                          <ul className="text-xs text-gray-400 space-y-1.5 font-mono">
                            <li><code className="text-green-400">-c, --show-controls</code> - show controls</li>
                            <li><code className="text-green-400">-v, --verbose</code> - enable verbose output</li>
                            <li><code className="text-green-400">-d, --high-dpi</code> - allow high DPI mode for UHD content</li>
                            <li><code className="text-green-400">-b, --10-bpc</code> - use 10 bits per color component</li>
                            <li><code className="text-green-400">-F, --fast-alignment</code> - fast bilinear scaling for alignment</li>
                            <li><code className="text-green-400">-I, --bilinear-texture</code> - bilinear video texture interpolation</li>
                            <li><code className="text-green-400">-n, --display-number</code> - open on specific display (0, 1, 2)</li>
                            <li><code className="text-green-400">-m, --mode</code> - display mode: split, vstack, hstack</li>
                            <li><code className="text-green-400">-w, --window-size</code> - window size [width]x[height]</li>
                            <li><code className="text-green-400">-W, --window-fit-display</code> - fit window within display bounds</li>
                            <li><code className="text-green-400">-a, --auto-loop-mode</code> - auto-loop: off, on, pp (ping-pong)</li>
                            <li><code className="text-green-400">-f, --frame-buffer-size</code> - frame buffer size (default: 50)</li>
                            <li><code className="text-green-400">-t, --time-shift</code> - shift right video timestamps</li>
                            <li><code className="text-green-400">-s, --wheel-sensitivity</code> - mouse wheel sensitivity</li>
                            <li><code className="text-green-400">-C, --color-space</code> - color space matrix (e.g. bt709, bt2020nc)</li>
                            <li><code className="text-green-400">-A, --color-range</code> - color range (tv, pc)</li>
                            <li><code className="text-green-400">-P, --color-primaries</code> - color primaries (bt709, bt2020)</li>
                            <li><code className="text-green-400">-N, --color-trc</code> - transfer characteristics</li>
                            <li><code className="text-green-400">-T, --tone-map-mode</code> - HDR tone mapping: auto, off, on, rel</li>
                            <li><code className="text-green-400">-L, --left-peak-nits</code> - left video peak luminance</li>
                            <li><code className="text-green-400">-R, --right-peak-nits</code> - right video peak luminance</li>
                            <li><code className="text-green-400">-B, --boost-tone</code> - tone-mapping strength factor</li>
                            <li><code className="text-green-400">-i, --filters</code> - FFmpeg filters for both sides</li>
                            <li><code className="text-green-400">-l, --left-filters</code> - FFmpeg filters for left video</li>
                            <li><code className="text-green-400">-r, --right-filters</code> - FFmpeg filters for right video</li>
                            <li><code className="text-green-400">--demuxer</code> - FFmpeg demuxer name</li>
                            <li><code className="text-green-400">--decoder</code> - FFmpeg decoder name</li>
                            <li><code className="text-green-400">--hwaccel</code> - hardware acceleration (cuda, vulkan, etc.)</li>
                            <li><code className="text-green-400">--libvmaf-options</code> - libvmaf filter options</li>
                            <li><code className="text-green-400">--no-auto-filters</code> - disable automatic filters</li>
                          </ul>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end p-6 border-t border-gray-800">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <kbd className="px-2 py-0.5 bg-dark-elevated border border-gray-700 rounded text-gray-300">Esc</kbd>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>
  );
});
