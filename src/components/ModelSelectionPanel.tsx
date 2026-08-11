import { memo } from 'react';
import type { BackendId, ModelFile, ColorimetrySettings, FilterTemplate, VideoInfo, Filter } from '../electron.d';
import { DynamicFilterPanel } from './DynamicFilterPanel';
import { ColorimetryPanel } from './ColorimetryPanel';

interface ModelSelectionPanelProps {
  availableModels: ModelFile[];
  isProcessing: boolean;
  defaultBackend: BackendId;
  showBackendOverrides: boolean;
  colorimetrySettings: ColorimetrySettings;
  videoInfo: VideoInfo | null;
  filterTemplates: FilterTemplate[];
  filters: Filter[];
  onImportClick: () => void;
  onModelsUpdated?: () => Promise<void>;
  onColorimetryChange: (settings: ColorimetrySettings) => void;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
}

export const ModelSelectionPanel = memo<ModelSelectionPanelProps>(({
  availableModels,
  isProcessing,
  defaultBackend,
  showBackendOverrides,
  colorimetrySettings,
  videoInfo,
  filterTemplates,
  filters,
  onColorimetryChange,
  onFiltersChange,
  onSaveTemplate,
  onDeleteTemplate,
  onImportClick,
  onModelsUpdated,
}: ModelSelectionPanelProps) => {
  return (
    <>
      {/* Colorimetry Panel */}
      <ColorimetryPanel
        settings={colorimetrySettings}
        isProcessing={isProcessing}
        videoInfo={videoInfo}
        onSettingsChange={onColorimetryChange}
      />



      {/* Filter Panel */}
      <DynamicFilterPanel
        title="Filters"
        filters={filters}
        filterTemplates={filterTemplates}
        isProcessing={isProcessing}
        availableModels={availableModels}
        defaultBackend={defaultBackend}
        showBackendOverrides={showBackendOverrides}
        onFiltersChange={onFiltersChange}
        onSaveTemplate={onSaveTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onImportClick={onImportClick}
        onModelsUpdated={onModelsUpdated}
      />
    </>
  );
});
