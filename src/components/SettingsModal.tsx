import React, { useState } from 'react';
import { Settings, Info, Terminal, FolderOpen, X, Package, FileCode, RotateCcw, Cpu, Layers } from 'lucide-react';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  useDirectML: boolean;
  onToggleDirectML: (value: boolean) => void;
  numStreams: number;
  onUpdateNumStreams: (value: number) => void;
  ffmpegArgs: string;
  onUpdateFfmpegArgs: (args: string) => void;
  onResetFfmpegArgs: () => void;
  processingFormat: string;
  onUpdateProcessingFormat: (format: string) => void;
}

type Tab = 'general' | 'processing';

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  show, 
  onClose, 
  useDirectML, 
  onToggleDirectML,
  numStreams,
  onUpdateNumStreams,
  ffmpegArgs,
  onUpdateFfmpegArgs,
  onResetFfmpegArgs,
  processingFormat,
  onUpdateProcessingFormat
}) => {
  const [activeTab, setActiveTab] = useState<Tab>('general');

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
              {/* VapourSynth Output Format Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-primary-purple" />
                  VapourSynth Output Format
                </h3>
                
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-white">Output Pixel Format</p>
                    </div>
                    <select
                      value={processingFormat}
                      onChange={(e) => onUpdateProcessingFormat(e.target.value)}
                      className="w-full bg-dark-bg border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-purple"
                    >
                      <option value="vs.YUV420P8">YUV 4:2:0 8-Bit</option>
                      <option value="vs.YUV420P10">YUV 4:2:0 10-Bit</option>
                      <option value="vs.YUV444P8">YUV 4:4:4 8-Bit</option>
                      <option value="vs.YUV444P10">YUV 4:4:4 10-Bit</option>
                      <option value="vs.RGB24">RGB 8-Bit</option>
                      <option value="match_input">Same as Input (experimental)</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-2">
                      YUV is the color family, 4:2:0 the chroma subsampling, and 8-Bit the bit depth. The default video is typically YUV 4:2:0 8-Bit.
                    </p>
                  </label>
                </div>
              </div>

              {/* FFmpeg Configuration Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-accent-cyan" />
                  FFmpeg Encoding
                </h3>
                
                <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
                  <label className="block">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-white">Video Encoding Arguments</p>
                      <button
                        onClick={onResetFfmpegArgs}
                        className="text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Reset to Default
                      </button>
                    </div>
                    <input
                      type="text"
                      value={ffmpegArgs}
                      onChange={(e) => onUpdateFfmpegArgs(e.target.value)}
                      className="w-full bg-dark-bg border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent-cyan font-mono"
                      placeholder="FFmpeg encoding arguments"
                    />
                    <p className="text-xs text-gray-400 mt-2">
                      FFmpeg arguments for video encoding. Control output quality, speed, and behavior.
                    </p>
                    <div className="mt-3 p-3 bg-dark-bg rounded border border-gray-700">
                      <p className="text-xs font-medium text-white mb-2">Recommended options:</p>
                      <ul className="text-xs text-gray-400 space-y-1">
                        <li><code className="text-blue-400">-map_metadata 1</code> - Copy metadata from input</li>
                      </ul>
                    </div>
                  </label>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-gray-800">
          <button
            onClick={onClose}
            className="flex-1 bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 text-white font-semibold py-3 px-6 rounded-lg transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
