// src/hooks/useWorkflow.ts
import { useState, useCallback } from 'react';
import type { Filter, WorkflowData } from '../electron.d';
import { getErrorMessage } from '../types/errors';
import { getPortableModelName, resolvePortableModelName } from '../utils/modelUtils';

interface WorkflowState {
  currentWorkflow: string | null;
  previousFilters: Filter[];
  previousModel: string | null;
}

interface UseWorkflowProps {
  filters: Filter[];
  selectedModel: string | null;
  setFilters: (filters: Filter[]) => void;
  setSelectedModel: (model: string | null) => void;
  availableModels: string[];
  addConsoleLog: (message: string) => void;
  refreshFilterTemplates?: () => Promise<void>;
}

interface UseWorkflowReturn {
  currentWorkflow: string | null;
  handleLoadWorkflow: () => Promise<void>;
  handleClearWorkflow: () => Promise<void>;
  handleExportWorkflow: () => Promise<void>;
  handleImportWorkflow: () => Promise<void>;
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
  refreshFilterTemplates,
}: UseWorkflowProps): UseWorkflowReturn {
  const [workflowState, setWorkflowState] = useState<WorkflowState>({
    currentWorkflow: null,
    previousFilters: [],
    previousModel: null,
  });

  /**
   * Deep copy filters to prevent reference issues
   */
  const deepCopyFilters = useCallback((filters: Filter[]): Filter[] => {
    return JSON.parse(JSON.stringify(filters));
  }, []);

  /**
   * Save current state before loading a workflow
   */
  const saveCurrentState = useCallback(() => {
    setWorkflowState(prev => ({
      ...prev,
      previousFilters: deepCopyFilters(filters),
      previousModel: selectedModel,
    }));
    addConsoleLog('Saved current settings before loading workflow');
  }, [filters, selectedModel, deepCopyFilters, addConsoleLog]);

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
        alert(`Failed to load workflow: ${result.error}`);
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
        };
      });
      setFilters(workflowFilters);

      addConsoleLog(`Loaded workflow "${workflow.name}" with ${workflow.filters.length} filter(s)`);
      
      // Alert user if any models are missing
      if (missingModels.length > 0) {
        const modelList = missingModels.join('\n- ');
        alert(`Warning: The following model(s) could not be found and will need to be reconfigured:\n\n- ${modelList}`);
      }
    } catch (error) {
      addConsoleLog(`Error loading workflow: ${getErrorMessage(error)}`);
      alert(`Error: ${getErrorMessage(error)}`);
    }
  }, [
    workflowState.currentWorkflow,
    saveCurrentState,
    setFilters,
    deepCopyFilters,
    addConsoleLog,
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

          return {
            name: filter.filterType === 'aiModel' ? 'AI Model' : (filter.preset || `Filter ${index + 1}`),
            code: filter.code || '',
            description: undefined,
            enabled: filter.enabled,
            order: filter.order,
            filterType: filter.filterType,
            modelPath: portableModelName,
            modelType: filter.filterType === 'aiModel' ? (filter.modelType || 'tspan') : undefined,
          };
        }),
        createdAt: new Date().toISOString(),
      };
      
      const result = await window.electronAPI.exportWorkflow(workflowData, filePath);
      if (result.success) {
        addConsoleLog(`Workflow exported successfully: ${filePath}`);
      } else {
        addConsoleLog(`Error exporting workflow: ${result.error}`);
        alert(`Failed to export workflow: ${result.error}`);
      }
    } catch (error) {
      addConsoleLog(`Error exporting workflow: ${getErrorMessage(error)}`);
      alert(`Error: ${getErrorMessage(error)}`);
    }
  }, [filters, deepCopyFilters, addConsoleLog]);

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
        alert(`Failed to import workflow: ${result.error}`);
        return;
      }

      const workflow = result.workflow;

      // Permanently import custom filters as templates (skip AI model filters)
      const customFilters = workflow.filters.filter(f => f.filterType !== 'aiModel');
      for (const filter of customFilters) {
        const templateName = `${filter.name} (${workflow.name})`;
        await window.electronAPI.saveFilterTemplate({
          name: templateName,
          code: filter.code,
          description: filter.description,
        });
      }
      
      addConsoleLog(`Permanently imported ${customFilters.length} custom filter(s) from workflow "${workflow.name}"`);
      
      // Refresh the filter templates list
      if (refreshFilterTemplates) {
        await refreshFilterTemplates();
      }
      
      alert(`Successfully imported ${customFilters.length} custom filters with " (${workflow.name})" suffix.`);
    } catch (error) {
      addConsoleLog(`Error importing workflow: ${getErrorMessage(error)}`);
      alert(`Error: ${getErrorMessage(error)}`);
    }
  }, [addConsoleLog, refreshFilterTemplates]);

  return {
    currentWorkflow: workflowState.currentWorkflow,
    handleLoadWorkflow,
    handleClearWorkflow,
    handleExportWorkflow,
    handleImportWorkflow,
  };
}
