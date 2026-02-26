import { memo } from 'react';
import type { ModelFile, ColorimetrySettings, FilterTemplate, VideoInfo, Filter } from '../electron.d';
import { DynamicFilterPanel } from './DynamicFilterPanel';
import { ColorimetryPanel } from './ColorimetryPanel';
import { SegmentSelector, type SegmentSelection } from './SegmentSelector';

interface ModelSelectionPanelProps {
  availableModels: ModelFile[];
  isProcessing: boolean;
  useDirectML: boolean;
  colorimetrySettings: ColorimetrySettings;
  videoInfo: VideoInfo | null;
  filterTemplates: FilterTemplate[];
  filters: Filter[];
  segment?: SegmentSelection;
  onImportClick: () => void;
  onModelsUpdated?: () => Promise<void>;
  onColorimetryChange: (settings: ColorimetrySettings) => void;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  onSegmentChange?: (segment: SegmentSelection) => void;
  onPreviewSegment?: (startFrame: number, endFrame: number) => void;
  onSeekFrame?: (frameNumber: number) => void;
}

export const ModelSelectionPanel = memo<ModelSelectionPanelProps>(({
  availableModels,
  isProcessing,
  useDirectML,
  colorimetrySettings,
  videoInfo,
  filterTemplates,
  filters,
  segment,
  onColorimetryChange,
  onFiltersChange,
  onSaveTemplate,
  onDeleteTemplate,
  onImportClick,
  onModelsUpdated,
  onSegmentChange,
  onPreviewSegment,
  onSeekFrame,
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

      {/* Segment Selector */}
      {segment && onSegmentChange && (
        <SegmentSelector
          videoInfo={videoInfo}
          segment={segment}
          isProcessing={isProcessing}
          onSegmentChange={onSegmentChange}
          onPreview={onPreviewSegment}
          onSeekFrame={onSeekFrame}
        />
      )}

      {/* Filter Panel */}
      <DynamicFilterPanel
        title="Filters"
        filters={filters}
        filterTemplates={filterTemplates}
        isProcessing={isProcessing}
        availableModels={availableModels}
        useDirectML={useDirectML}
        onFiltersChange={onFiltersChange}
        onSaveTemplate={onSaveTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onImportClick={onImportClick}
        onModelsUpdated={onModelsUpdated}
      />
    </>
  );
});
