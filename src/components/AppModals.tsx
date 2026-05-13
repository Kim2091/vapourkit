// src/components/AppModals.tsx - Extracted modal renderings from App.tsx

import { memo } from 'react';
import { ImportModelModal } from './ImportModelModal';
import { AutoBuildModal } from './AutoBuildModal';
import { SettingsModal } from './SettingsModal';
import { AboutModal } from './AboutModal';
import { PluginsModal } from './PluginsModal';
import { UpdateNotificationModal } from './UpdateNotificationModal';
import { VsMlrtUpdateModal } from './VsMlrtUpdateModal';
import { FilterImportModal } from './FilterImportModal';
import type { UpdateInfo, VsMlrtVersionInfo } from '../electron';

interface AppModalsProps {
  // Import Model
  showImportModal: boolean;
  onCloseImportModal: () => void;
  isImporting: boolean;
  importForm: any;
  setImportForm: (form: any) => void;
  handleSelectOnnxFile: () => void;
  handleImportModel: () => void;
  handleCancelBuild: () => void;
  handleModelTypeChange: (type: any) => void;
  handleShapeModeChange: (mode: any) => void;
  handleFp32Change: (fp32: boolean) => void;
  handlePrecisionChange: (precision: any) => void;
  handleTemporalFramesChange: (frames: number) => void;
  importProgress: any;
  modalMode: 'import' | 'build';
  useDirectML: boolean;

  // Auto Build
  showAutoBuildModal: boolean;
  autoBuildModelName: string;
  autoBuildModelType: 'vsr' | 'image';
  autoBuildIsStatic: boolean;
  autoBuildStaticShape: any;

  // Settings
  showSettings: boolean;
  onCloseSettings: () => void;
  numStreams: number;
  onUpdateNumStreams: (streams: number) => void;
  onToggleDirectML: (value: boolean) => void;
  videoCompareArgs: string;
  onUpdateVideoCompareArgs: (args: string) => void;
  onResetVideoCompareArgs: () => void;
  defaultOutputFolder: string | null;
  onUpdateDefaultOutputFolder: (folder: string | null) => void;
  onResetDefaultOutputFolder: () => void;
  descriptiveNamingEnabled: boolean;
  onUpdateDescriptiveNamingEnabled: (enabled: boolean) => void;

  // About
  showAbout: boolean;
  onCloseAbout: () => void;

  // Plugins
  showPlugins: boolean;
  onClosePlugins: () => void;
  onInstallationComplete: () => void;

  // Update
  showUpdateModal: boolean;
  updateInfo: UpdateInfo | null;
  onCloseUpdateModal: () => void;

  // VsMlrt
  showVsMlrtModal: boolean;
  vsMlrtVersionInfo: VsMlrtVersionInfo | null;
  onCloseVsMlrtModal: () => void;
  onEnginesCleared: () => Promise<void>;

  // Filter Import
  importModalState: { isOpen: boolean; workflowName: string; filters: any[] };
  closeImportModal: () => void;
  confirmImportFilters: (selectedFilters: { name: string; code: string; description?: string; category?: string | string[] }[]) => void;
}

export const AppModals = memo(function AppModals(props: AppModalsProps) {
  return (
    <>
      <ImportModelModal
        show={props.showImportModal}
        onClose={props.onCloseImportModal}
        isImporting={props.isImporting}
        importForm={props.importForm}
        setImportForm={props.setImportForm}
        handleSelectOnnxFile={props.handleSelectOnnxFile}
        handleImportModel={props.handleImportModel}
        handleCancelBuild={props.handleCancelBuild}
        handleModelTypeChange={props.handleModelTypeChange}
        handleShapeModeChange={props.handleShapeModeChange}
        handleFp32Change={props.handleFp32Change}
        handlePrecisionChange={props.handlePrecisionChange}
        handleTemporalFramesChange={props.handleTemporalFramesChange}
        importProgress={props.importProgress}
        mode={props.modalMode}
        useDirectML={props.useDirectML}
      />

      <AutoBuildModal
        show={props.showAutoBuildModal}
        modelName={props.autoBuildModelName}
        modelType={props.autoBuildModelType}
        progress={props.importProgress}
        isStatic={props.autoBuildIsStatic}
        staticShape={props.autoBuildStaticShape}
      />

      <SettingsModal
        show={props.showSettings}
        onClose={props.onCloseSettings}
        useDirectML={props.useDirectML}
        onToggleDirectML={props.onToggleDirectML}
        numStreams={props.numStreams}
        onUpdateNumStreams={props.onUpdateNumStreams}
        videoCompareArgs={props.videoCompareArgs}
        onUpdateVideoCompareArgs={props.onUpdateVideoCompareArgs}
        onResetVideoCompareArgs={props.onResetVideoCompareArgs}
        defaultOutputFolder={props.defaultOutputFolder}
        onUpdateDefaultOutputFolder={props.onUpdateDefaultOutputFolder}
        onResetDefaultOutputFolder={props.onResetDefaultOutputFolder}
        descriptiveNamingEnabled={props.descriptiveNamingEnabled}
        onUpdateDescriptiveNamingEnabled={props.onUpdateDescriptiveNamingEnabled}
      />

      <AboutModal
        show={props.showAbout}
        onClose={props.onCloseAbout}
      />

      <PluginsModal
        show={props.showPlugins}
        onClose={props.onClosePlugins}
        onInstallationComplete={props.onInstallationComplete}
      />

      {props.showUpdateModal && props.updateInfo && (
        <UpdateNotificationModal
          updateInfo={props.updateInfo}
          onClose={props.onCloseUpdateModal}
        />
      )}

      {props.showVsMlrtModal && props.vsMlrtVersionInfo && (
        <VsMlrtUpdateModal
          versionInfo={props.vsMlrtVersionInfo}
          onClose={props.onCloseVsMlrtModal}
          onEnginesCleared={props.onEnginesCleared}
        />
      )}

      <FilterImportModal
        isOpen={props.importModalState.isOpen}
        onClose={props.closeImportModal}
        workflowName={props.importModalState.workflowName}
        filters={props.importModalState.filters}
        onImport={props.confirmImportFilters}
      />
    </>
  );
});
