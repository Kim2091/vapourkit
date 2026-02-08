// src/hooks/useWorkflow.ts
import { useState, useCallback } from 'react';
import type { Filter, FilterTemplate, WorkflowData, SegmentSelection, ColorimetrySettings } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { getPortableModelName, resolvePortableModelName } from '../utils/modelUtils';
import { notify } from '../utils/notifications';

interface ImportWorkflowModalState {
  isOpen: boolean;
  workflowName: string;
  filters: {
    name: string;
    code: string;
    description?: string;
    filterType: 'aiModel' | 'custom';
    category?: string | string[];
  }[];
}

interface WorkflowState {
  currentWorkflow: string | null;
  previousFilters: Filter[];
  previousModel: string | null;
  previousEncodingSettings?: {
    ffmpegArgs: string;
    processingFormat: string;
    outputFormat: string;
    videoCompareArgs: string;
    numStreams: number;
    segment: SegmentSelection;
    colorimetry: ColorimetrySettings;
  };
}

interface UseWorkflowProps {
  filters: Filter[];
  selectedModel: string | null;
  setFilters: (filters: Filter[]) => void;
  setSelectedModel: (model: string | null) => void;
  availableModels: string[];
  addConsoleLog: (message: string) => void;
  filterTemplates?: FilterTemplate[];
  refreshFilterTemplates?: () => Promise<void>;
  // Encoding settings
  ffmpegArgs?: string;
  processingFormat?: string;
  outputFormat?: string;
  videoCompareArgs?: string;
  useDirectML?: boolean;
  numStreams?: number;
  segment?: SegmentSelection;
  colorimetry?: ColorimetrySettings;
  setFfmpegArgs?: (args: string) => void;
  setProcessingFormat?: (format: string) => void;
  setOutputFormat?: (format: string) => void;
  setVideoCompareArgs?: (args: string) => void;
  toggleDirectML?: (value: boolean) => void;
  updateNumStreams?: (streams: number) => void;
  setSegment?: (segment: SegmentSelection) => void;
  handleColorimetryChange?: (settings: ColorimetrySettings) => void;
}

interface UseWorkflowReturn {
  currentWorkflow: string | null;
  handleLoadWorkflow: () => Promise<void>;
  handleClearWorkflow: () => Promise<void>;
  handleExportWorkflow: () => Promise<void>;
  handleImportWorkflow: () => Promise<void>;
  importModalState: ImportWorkflowModalState;
  closeImportModal: () => void;
  confirmImportFilters: (selectedFilters: { name: string; code: string; description?: string }[]) => Promise<void>;
}

/**
 * Custom hook to manage workflow loading, clearing, importing, and exporting
 * with proper state isolation to prevent edge cases.
 */
export function useWorkflow({
  filters,
  selectedModel,
  setFilters,
  setSelectedModel,
  addConsoleLog,
  filterTemplates,
  refreshFilterTemplates,
  ffmpegArgs,
  processingFormat,
  outputFormat,
  videoCompareArgs,
  numStreams,
  segment,
  colorimetry,
  setFfmpegArgs,
  setProcessingFormat,
  setOutputFormat,
  setVideoCompareArgs,
  updateNumStreams,
  setSegment,
  handleColorimetryChange,
}: UseWorkflowProps): UseWorkflowReturn {
  const [workflowState, setWorkflowState] = useState<WorkflowState>({
    currentWorkflow: null,
    previousFilters: [],
    previousModel: null,
  });

  const [importModalState, setImportModalState] = useState<ImportWorkflowModalState>({
    isOpen: false,
    workflowName: '',
    filters: [],
  });

  /**
   * Deep copy filters to prevent reference issues
   */
  const deepCopyFilters = useCallback((filters: Filter[]): Filter[] => {
    return structuredClone(filters);
  }, []);

  /**
   * Save current state before loading a workflow
   */
  const saveCurrentState = useCallback(() => {
    setWorkflowState(prev => ({
      ...prev,
      previousFilters: deepCopyFilters(filters),
      previousModel: selectedModel,
      previousEncodingSettings: ffmpegArgs !== undefined && processingFormat !== undefined && 
        outputFormat !== undefined && videoCompareArgs !== undefined && 
        numStreams !== undefined && segment !== undefined && colorimetry !== undefined
        ? {
            ffmpegArgs,
            processingFormat,
            outputFormat,
            videoCompareArgs,
            numStreams,
            segment,
            colorimetry,
          }
        : undefined,
    }));
    addConsoleLog('Saved current settings before loading workflow');
  }, [filters, selectedModel, deepCopyFilters, addConsoleLog, ffmpegArgs, processingFormat, 
      outputFormat, videoCompareArgs, numStreams, segment, colorimetry]);

  /**
   * Load a workflow from file
   */
  const handleLoadWorkflow = useCallback(async (): Promise<void> => {
    try {
      const filePath = await window.electronAPI.selectWorkflowFile('open');
      if (!filePath) return;

      const result = await window.electronAPI.importWorkflow(filePath);
      if (!result.success || !result.workflow) {
        addConsoleLog(`Error loading workflow: ${result.error}`);
        notify.error('Workflow Error', `Failed to load workflow: ${result.error}`);
        return;
      }

      const workflow = result.workflow;

      // Only save previous settings if no workflow is currently active
      if (!workflowState.currentWorkflow) {
        saveCurrentState();
      } else {
        addConsoleLog(`Replacing active workflow "${workflowState.currentWorkflow}" with "${workflow.name}"`);
      }

      // Set the workflow name first (strip .vkworkflow extension if present)
      const displayName = workflow.name.replace(/\.vkworkflow$/i, '');
      setWorkflowState(prev => ({ ...prev, currentWorkflow: displayName }));

      // Get available models for resolution
      const availableModelObjects = await window.electronAPI.getAvailableModels();

      // Track missing models to alert the user
      const missingModels: string[] = [];

      const workflowFilters: Filter[] = workflow.filters.map((wf, index) => {
        let resolvedModelPath = wf.modelPath;
        
        // If this is an AI model filter with a modelPath, try to resolve it
        if (wf.filterType === 'aiModel' && wf.modelPath) {
          const resolved = resolvePortableModelName(wf.modelPath, availableModelObjects);
          if (resolved) {
            resolvedModelPath = resolved;
          } else {
            addConsoleLog(`Warning: Could not find model "${wf.modelPath}" - filter will need reconfiguration`);
            missingModels.push(wf.modelPath);
          }
        }

        return {
          id: `filter-${Date.now()}-${index}`,
          enabled: wf.enabled,
          filterType: wf.filterType || 'custom',
          preset: wf.filterType === 'aiModel' ? 'AI Model' : wf.name,
          code: wf.code || '',
          order: wf.order,
          modelPath: resolvedModelPath,
          modelType: wf.modelType,
          category: wf.category,
        };
      });
      setFilters(workflowFilters);

      // Apply encoding settings if present
      if (workflow.encodingSettings) {
        if (workflow.encodingSettings.ffmpegArgs && setFfmpegArgs) {
          setFfmpegArgs(workflow.encodingSettings.ffmpegArgs);
          addConsoleLog(`Applied FFmpeg args from workflow`);
        }
        if (workflow.encodingSettings.processingFormat && setProcessingFormat) {
          setProcessingFormat(workflow.encodingSettings.processingFormat);
          addConsoleLog(`Applied processing format: ${workflow.encodingSettings.processingFormat}`);
        }
        if (workflow.encodingSettings.outputFormat && setOutputFormat) {
          setOutputFormat(workflow.encodingSettings.outputFormat);
          addConsoleLog(`Applied output format: ${workflow.encodingSettings.outputFormat}`);
        }
        if (workflow.encodingSettings.videoCompareArgs && setVideoCompareArgs) {
          setVideoCompareArgs(workflow.encodingSettings.videoCompareArgs);
          addConsoleLog(`Applied video compare args from workflow`);
        }
        if (workflow.encodingSettings.numStreams && updateNumStreams) {
          updateNumStreams(workflow.encodingSettings.numStreams);
          addConsoleLog(`Applied num streams: ${workflow.encodingSettings.numStreams}`);
        }
        if (workflow.encodingSettings.segment && setSegment) {
          setSegment(workflow.encodingSettings.segment);
          addConsoleLog(`Applied segment settings from workflow`);
        }
        if (workflow.encodingSettings.colorimetry && handleColorimetryChange) {
          handleColorimetryChange(workflow.encodingSettings.colorimetry);
          addConsoleLog(`Applied colorimetry settings from workflow`);
        }
      }

      addConsoleLog(`Loaded workflow "${workflow.name}" with ${workflow.filters.length} filter(s)`);
      
      // Alert user if any models are missing
      if (missingModels.length > 0) {
        const modelList = missingModels.join('\n- ');
        notify.warning('Missing Models', `The following model(s) could not be found and will need to be reconfigured:\n\n- ${modelList}`);
      }
    } catch (error) {
      addConsoleLog(`Error loading workflow: ${getErrorMessage(error)}`);
      notify.error('Workflow Error', getErrorMessage(error));
    }
  }, [
    workflowState.currentWorkflow,
    saveCurrentState,
    setFilters,
    deepCopyFilters,
    addConsoleLog,
    setFfmpegArgs,
    setProcessingFormat,
    setOutputFormat,
    setVideoCompareArgs,
    updateNumStreams,
    setSegment,
    handleColorimetryChange,
  ]);

  /**
   * Clear the current workflow and restore previous settings
   */
  const handleClearWorkflow = useCallback(async (): Promise<void> => {
    const workflowName = workflowState.currentWorkflow;
    
    if (!workflowName) {
      addConsoleLog('No workflow is currently loaded');
      return;
    }

    // Restore previous state using deep copies
    const restoredFilters = deepCopyFilters(workflowState.previousFilters);
    setFilters(restoredFilters);
    
    if (workflowState.previousModel) {
      setSelectedModel(workflowState.previousModel);
    }

    // Restore previous encoding settings if available
    if (workflowState.previousEncodingSettings) {
      const prev = workflowState.previousEncodingSettings;
      if (setFfmpegArgs) setFfmpegArgs(prev.ffmpegArgs);
      if (setProcessingFormat) setProcessingFormat(prev.processingFormat);
      if (setOutputFormat) setOutputFormat(prev.outputFormat);
      if (setVideoCompareArgs) setVideoCompareArgs(prev.videoCompareArgs);
      if (updateNumStreams) updateNumStreams(prev.numStreams);
      if (setSegment) setSegment(prev.segment);
      if (handleColorimetryChange) handleColorimetryChange(prev.colorimetry);
      addConsoleLog('Restored previous encoding settings');
    }

    // Clear workflow state and reset previous state to defaults
    setWorkflowState({
      currentWorkflow: null,
      previousFilters: [],
      previousModel: null,
    });

    addConsoleLog(`Cleared workflow "${workflowName}" and restored previous settings`);
  }, [
    workflowState,
    setFilters,
    setSelectedModel,
    deepCopyFilters,
    addConsoleLog,
    setFfmpegArgs,
    setProcessingFormat,
    setOutputFormat,
    setVideoCompareArgs,
    updateNumStreams,
    setSegment,
    handleColorimetryChange,
  ]);

  /**
   * Export current settings as a workflow
   */
  const handleExportWorkflow = useCallback(async (): Promise<void> => {
    try {
      const filePath = await window.electronAPI.selectWorkflowFile('save');
      if (!filePath) return;

      // Get the workflow name from the file path
      const workflowName = filePath.split(/[\\/]/).pop()?.replace('.vkworkflow', '') || 'Untitled';

      const workflowData: WorkflowData = {
        name: workflowName,
        version: '1.0',
        filters: deepCopyFilters(filters).map((filter, index) => {
          // For AI model filters, save the portable model name instead of full path
          let portableModelName: string | undefined = undefined;
          if (filter.filterType === 'aiModel' && filter.modelPath) {
            portableModelName = getPortableModelName(filter.modelPath);
          }

          // Look up category from filter templates by matching the preset name
          const matchedTemplate = filter.preset && filterTemplates
            ? filterTemplates.find(t => t.name === filter.preset)
            : undefined;
          const category = matchedTemplate?.category ?? filter.category;

          return {
            name: filter.filterType === 'aiModel' ? 'AI Model' : (filter.preset || `Filter ${index + 1}`),
            code: filter.code || '',
            description: undefined,
            enabled: filter.enabled,
            order: filter.order,
            filterType: filter.filterType,
            modelPath: portableModelName,
            modelType: filter.filterType === 'aiModel' ? (filter.modelType || 'image') : undefined,
            category,
          };
        }),
        createdAt: new Date().toISOString(),
        encodingSettings: ffmpegArgs !== undefined && processingFormat !== undefined && 
          outputFormat !== undefined && videoCompareArgs !== undefined &&
          numStreams !== undefined && segment !== undefined && colorimetry !== undefined
          ? {
              ffmpegArgs,
              processingFormat,
              outputFormat,
              videoCompareArgs,
              numStreams,
              segment,
              colorimetry,
            }
          : undefined,
      };
      
      const result = await window.electronAPI.exportWorkflow(workflowData, filePath);
      if (result.success) {
        addConsoleLog(`Workflow exported successfully: ${filePath}`);
      } else {
        addConsoleLog(`Error exporting workflow: ${result.error}`);
        notify.error('Export Error', `Failed to export workflow: ${result.error}`);
      }
    } catch (error) {
      addConsoleLog(`Error exporting workflow: ${getErrorMessage(error)}`);
      notify.error('Export Error', getErrorMessage(error));
    }
  }, [filters, deepCopyFilters, addConsoleLog, filterTemplates, ffmpegArgs, processingFormat, outputFormat, 
      videoCompareArgs, numStreams, segment, colorimetry]);

  /**
   * Import filters from a workflow file permanently
   */
  const handleImportWorkflow = useCallback(async (): Promise<void> => {
    try {
      const filePath = await window.electronAPI.selectWorkflowFile('open');
      if (!filePath) return;

      const result = await window.electronAPI.importWorkflow(filePath);
      if (!result.success || !result.workflow) {
        addConsoleLog(`Error importing workflow: ${result.error}`);
        notify.error('Import Error', `Failed to import workflow: ${result.error}`);
        return;
      }

      const workflow = result.workflow;

      // Show the import modal with all filters from the workflow
      setImportModalState({
        isOpen: true,
        workflowName: workflow.name,
        filters: workflow.filters,
      });
    } catch (error) {
      addConsoleLog(`Error importing workflow: ${getErrorMessage(error)}`);
      notify.error('Import Error', getErrorMessage(error));
    }
  }, [addConsoleLog]);

  /**
   * Close the import modal
   */
  const closeImportModal = useCallback(() => {
    setImportModalState({
      isOpen: false,
      workflowName: '',
      filters: [],
    });
  }, []);

  /**
   * Confirm and import selected filters
   */
  const confirmImportFilters = useCallback(async (
    selectedFilters: { name: string; code: string; description?: string; category?: string | string[] }[]
  ): Promise<void> => {
    try {
      // Save selected filters as templates
      for (const filter of selectedFilters) {
        await window.electronAPI.saveFilterTemplate({
          name: filter.name,
          code: filter.code,
          description: filter.description,
          category: filter.category,
        });
      }
      
      addConsoleLog(`Permanently imported ${selectedFilters.length} filter(s)`);
      
      // Refresh the filter templates list
      if (refreshFilterTemplates) {
        await refreshFilterTemplates();
      }
      
      notify.success('Filters Imported', `Successfully imported ${selectedFilters.length} filter(s).`);
      
      // Close the modal
      closeImportModal();
    } catch (error) {
      addConsoleLog(`Error saving imported filters: ${getErrorMessage(error)}`);
      notify.error('Import Error', getErrorMessage(error));
    }
  }, [addConsoleLog, refreshFilterTemplates, closeImportModal]);

  return {
    currentWorkflow: workflowState.currentWorkflow,
    handleLoadWorkflow,
    handleClearWorkflow,
    handleExportWorkflow,
    handleImportWorkflow,
    importModalState,
    closeImportModal,
    confirmImportFilters,
  };
}
