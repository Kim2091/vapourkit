import type { ModelFile, ColorimetrySettings, FilterTemplate, VideoInfo, Filter } from '../electron.d';
import { DynamicFilterPanel } from './DynamicFilterPanel';
import { ColorimetryPanel } from './ColorimetryPanel';
import { SegmentSelector, type SegmentSelection } from './SegmentSelector';

interface ModelSelectionPanelProps {
  filteredModels: ModelFile[];
  isProcessing: boolean;
  useDirectML: boolean;
  colorimetrySettings: ColorimetrySettings;
  videoInfo: VideoInfo | null;
  filterTemplates: FilterTemplate[];
  filters: Filter[];
  segment?: SegmentSelection;
  onImportClick: () => void;
  onManageModels?: () => void;
  onColorimetryChange: (settings: ColorimetrySettings) => void;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  onSegmentChange?: (segment: SegmentSelection) => void;
  onPreviewSegment?: (startFrame: number, endFrame: number) => void;
  onSeekFrame?: (frameNumber: number) => void;
}

export function ModelSelectionPanel({
  filteredModels,
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
  onManageModels,
  onSegmentChange,
  onPreviewSegment,
  onSeekFrame,
}: ModelSelectionPanelProps) {
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
        availableModels={filteredModels}
        useDirectML={useDirectML}
        onFiltersChange={onFiltersChange}
        onSaveTemplate={onSaveTemplate}
        onDeleteTemplate={onDeleteTemplate}
        onImportClick={onImportClick}
        onManageModels={onManageModels}
      />
    </>
  );
}
