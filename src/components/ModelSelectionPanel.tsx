import { Sparkles } from 'lucide-react';
import type { ModelFile, ColorMatrixSettings, FilterTemplate, VideoInfo, Filter } from '../electron.d';
import { DynamicFilterPanel } from './DynamicFilterPanel';
import { ColorMatrixPanel } from './ColorMatrixPanel';
import { getModelDisplayName } from '../utils/modelUtils';

interface ModelSelectionPanelProps {
  selectedModel: string | null;
  filteredModels: ModelFile[];
  isProcessing: boolean;
  advancedMode: boolean;
  useDirectML: boolean;
  colorMatrixSettings: ColorMatrixSettings;
  videoInfo: VideoInfo | null;
  filterTemplates: FilterTemplate[];
  filters: Filter[];
  onModelChange: (modelPath: string) => void;
  onImportClick: () => void;
  onManageModels?: () => void;
  onColorMatrixChange: (settings: ColorMatrixSettings) => void;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
}

export function ModelSelectionPanel({
  selectedModel,
  filteredModels,
  isProcessing,
  advancedMode,
  useDirectML,
  colorMatrixSettings,
  videoInfo,
  filterTemplates,
  filters,
  onModelChange,
  onColorMatrixChange,
  onFiltersChange,
  onSaveTemplate,
  onDeleteTemplate,
  onImportClick,
  onManageModels,
}: ModelSelectionPanelProps) {
  return (
    <>
      {/* Color Matrix Panel - Only in Advanced Mode */}
      {advancedMode && (
        <ColorMatrixPanel
          settings={colorMatrixSettings}
          isProcessing={isProcessing}
          videoInfo={videoInfo}
          onSettingsChange={onColorMatrixChange}
        />
      )}

      {/* Unified Filter Panel - Only in Advanced Mode */}
      {advancedMode && (
        <DynamicFilterPanel
          title="Filters"
          filters={filters}
          filterTemplates={filterTemplates}
          isProcessing={isProcessing}
          availableModels={filteredModels}
          useDirectML={useDirectML}
          onFiltersChange={onFiltersChange}
          onSaveTemplate={onSaveTemplate}
          onDeleteTemplate={onDeleteTemplate}
          onImportClick={onImportClick}
          onManageModels={onManageModels}
        />
      )}

      {/* Model Selection Panel - Only in Simple Mode */}
      {!advancedMode && (
        <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary-purple" />
              <h2 className="text-base font-semibold">AI Model</h2>
            </div>
          </div>
          
          <select
            value={selectedModel || ''}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={isProcessing}
            className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-base focus:outline-none focus:border-primary-purple transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Select a model...</option>
            {filteredModels.map((model) => (
              <option key={model.path} value={model.path}>
                {getModelDisplayName(model, useDirectML, advancedMode)}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}