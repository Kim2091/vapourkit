import { memo } from 'react';
import type { BackendId, ModelFile, ColorimetrySettings, FilterTemplate, VideoInfo, Filter } from '../electron.d';
import { DynamicFilterPanel } from './DynamicFilterPanel';
import { ColorimetryPanel } from './ColorimetryPanel';

interface ModelSelectionPanelProps {
  availableModels: ModelFile[];
  isProcessing: boolean;
  defaultBackend: BackendId;
  showBackendOverrides: boolean;
  numStreams: number;
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
  onOpenFilterEditor?: (filter: Filter) => void;
}

export const ModelSelectionPanel = memo<ModelSelectionPanelProps>(({
  availableModels,
  isProcessing,
  defaultBackend,
  showBackendOverrides,
  numStreams,
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
  onOpenFilterEditor,
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
        defaultNumStreams={numStreams}
        onFiltersChange={onFiltersChange}
        onSaveTemplate={onSaveTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onImportClick={onImportClick}
        onModelsUpdated={onModelsUpdated}
        onOpenFilterEditor={onOpenFilterEditor}
      />
    </>
  );
});
