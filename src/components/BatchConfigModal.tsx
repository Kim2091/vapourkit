import { memo, useState } from 'react';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import type { SegmentSelection } from '../electron.d';

export interface BatchVideoConfig {
  videoPath: string;
  videoName: string;
  outputPath: string;
  workflow: {
    selectedModel: string | null;
    filters: any[];
    outputFormat: string;
    useDirectML: boolean;
    numStreams: number;
    segment?: SegmentSelection;
  };
}

interface BatchConfigModalProps {
  videos: BatchVideoConfig[];
  onConfirm: (configs: BatchVideoConfig[]) => void;
  onClose: () => void;
}

export const BatchConfigModal = memo<BatchConfigModalProps>(({
  videos,
  onConfirm,
  onClose,
}: BatchConfigModalProps) => {
  const [configs, setConfigs] = useState<BatchVideoConfig[]>(videos);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);

  const updateConfig = (index: number, updates: Partial<BatchVideoConfig>) => {
    const newConfigs = [...configs];
    newConfigs[index] = { ...newConfigs[index], ...updates };
    setConfigs(newConfigs);
  };


  const handleSelectOutputPath = async (index: number) => {
    try {
      const selected = await window.electronAPI.selectOutputFile(configs[index].outputPath);
      if (selected) {
        updateConfig(index, { outputPath: selected });
      }
    } catch (error) {
      console.error('Error selecting output path:', error);
    }
  };


  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div>
            <h2 className="text-xl font-semibold">Add Videos to Queue</h2>
            <p className="text-sm text-gray-400 mt-1">
              {configs.length} video{configs.length !== 1 ? 's' : ''} selected - Review and adjust output paths
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-dark-surface rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content - Scrollable video list */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {configs.map((config, index) => (
            <div
              key={index}
              className="bg-dark-surface border border-gray-800 rounded-xl overflow-hidden"
            >
              {/* Video Header - Always visible */}
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-dark-bg transition-colors"
                onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{config.videoName}</p>
                  <p className="text-xs text-gray-500 truncate mt-1">
                    {config.outputPath.split(/[\\/]/).pop()}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <span className="text-xs text-gray-500">#{index + 1}</span>
                  {expandedIndex === index ? (
                    <ChevronUp className="w-5 h-5 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-400" />
                  )}
                </div>
              </div>

              {/* Expanded Configuration */}
              {expandedIndex === index && (
                <div className="p-4 pt-0 space-y-4 border-t border-gray-800/50">
                  {/* Output Path */}
                  <div>
                    <label className="block text-xs font-medium mb-2 text-gray-400">Output Path</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={config.outputPath}
                        onChange={(e) => updateConfig(index, { outputPath: e.target.value })}
                        className="flex-1 bg-dark-elevated border border-gray-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary-blue"
                        placeholder="Output file path"
                      />
                      <button
                        onClick={() => handleSelectOutputPath(index)}
                        className="px-3 py-2 bg-dark-elevated hover:bg-dark-bg border border-gray-800 rounded-lg transition-colors text-xs"
                      >
                        Browse
                      </button>
                    </div>
                  </div>

                  {/* Workflow Summary (Read-only) */}
                  <div className="bg-dark-elevated rounded-lg p-3 border border-gray-800/50">
                    <h3 className="text-xs font-medium mb-2 text-gray-400">Current Workflow</h3>
                    <div className="space-y-1 text-xs text-gray-500">
                      <p>Format: {config.workflow.outputFormat.toUpperCase()}</p>
                      <p>Backend: {config.workflow.useDirectML ? 'DirectML' : 'TensorRT'}</p>
                      {!config.workflow.useDirectML && (
                        <p>Num Streams: {config.workflow.numStreams}</p>
                      )}
                      <p>Filters: {config.workflow.filters.filter(f => f.enabled).length} enabled</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-gray-800">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-dark-surface hover:bg-dark-bg rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(configs)}
            className="flex-1 px-4 py-2 bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 rounded-lg transition-colors font-medium"
          >
            Add {configs.length} Video{configs.length !== 1 ? 's' : ''} to Queue
          </button>
        </div>
      </div>
    </div>
  );
});
