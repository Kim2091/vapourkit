import { Fragment, memo, useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Filter as LucideFilter, Info, Sparkles, ToggleLeft, ToggleRight, ChevronsDownUp, ChevronsUpDown, Film } from 'lucide-react';
import type { BackendId, FilterBackend, Filter, FilterTemplate, ModelFile } from '../electron.d';
import { resolveFilterBackend } from '../utils/backends';
import { Section, SectionButton } from './Section';
import { FilterSelectorModal } from './FilterSelectorModal';
import { TemplateEditDialog } from './TemplateEditDialog';
import { ModelSelectorModal } from './ModelSelectorModal';
import { StepCard, type StepCardActions, type StepCardContext } from './StepCard';
import type { SaveTemplateFields } from './SaveTemplateForm';
import { useDragReorder } from './useDragReorder';
import { notify } from '../utils/notifications';
import { toCategories } from '../utils/categories';
import { ask } from '../utils/dialogs';
import { onBeforeClose } from '../utils/beforeClose';
import { LoadVideoCard } from './LoadVideoCard';
import { isSideChainHead, layoutChains, normalizeChainOrder, stepTag } from '../../electron/chainGraph';
import type { LutJob } from '../hooks/useLutSteps';

interface DynamicFilterPanelProps {
  title?: string;
  filters: Filter[];
  filterTemplates: FilterTemplate[];
  isProcessing: boolean;
  availableModels?: ModelFile[];
  defaultBackend?: BackendId;
  /** App-level num_streams — what an unset per-filter value inherits. */
  defaultNumStreams?: number;
  /** Shows the per-filter backend selector (Settings toggle, off by default). */
  showBackendOverrides?: boolean;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  /** Puts back deleted built-in filters; answers the files restored */
  onRestoreTemplates?: () => Promise<string[]>;
  onImportClick?: () => void;
  onModelsUpdated?: () => Promise<void>;
  /** Opens a visual editor declared by the selected .vkfilter template. */
  onOpenFilterEditor?: (filter: Filter) => void;
  /** What the chain's LUT steps can do, and the state of doing it. */
  lut?: LutPanelActions;
  /** Apply a long job's result to a step as the chain is when it ends (useFilterConfig). */
  beginStepPatch?: (stepId: string) => (patch: (step: Filter) => Filter) => boolean;
  /** Changes when a different chain is swapped in (a queue item's, the project's). */
  chainEpoch?: number;
  /** The main video, which a side chain is aligned against. */
  mainVideoPath?: string;
}

/**
 * Everything a Create LUT or Load LUT card needs from the app, in one object.
 *
 * `pickFile` installs a table from disk and returns where it landed, or null
 * if the pick was cancelled or the file could not be read. The rest is the
 * generator: one job per step id, so two Load LUT steps can each show their
 * own outcome.
 */
export interface LutPanelActions {
  pickFile: () => Promise<string | null>;
  restore: (loadId: string) => void;
  bake: (markerId: string) => void;
  clear: (id: string) => void;
  jobs: Record<string, LutJob>;
  previewOpen: boolean;
}

function defaultsForVariables(template: FilterTemplate | undefined): NonNullable<Filter['parameters']> | undefined {
  if (!template?.variables) return undefined;

  const parameters = Object.entries(template.variables).reduce<NonNullable<Filter['parameters']>>((values, [name, variable]) => {
    if (variable.default !== undefined) values[name] = variable.default;
    return values;
  }, {});

  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

/** What a step takes from its template: the code, category, variable defaults, variables and editor. */
function fromTemplate(template: FilterTemplate | undefined): Pick<Filter, 'code' | 'category' | 'parameters' | 'variables' | 'editor'> {
  return {
    code: template?.code || '',
    category: template?.category,
    parameters: defaultsForVariables(template),
    variables: template?.variables,
    editor: template?.editor,
  };
}

export const DynamicFilterPanel = memo<DynamicFilterPanelProps>(({
  title = 'Filters',
  filters,
  filterTemplates,
  isProcessing,
  availableModels = [],
  defaultBackend = 'tensorrt',
  defaultNumStreams = 2,
  showBackendOverrides = false,
  onFiltersChange: onFiltersChangeProp,
  onSaveTemplate,
  onDeleteTemplate,
  onRestoreTemplates,
  onImportClick,
  onModelsUpdated,
  onOpenFilterEditor,
  lut,
  beginStepPatch,
  chainEpoch = 0,
  mainVideoPath,
}: DynamicFilterPanelProps) => {
  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set());
  const [showSaveDialog, setShowSaveDialog] = useState<string | null>(null);
  // The template open in the Edit Filter dialog from a step's card.
  const [editingTemplate, setEditingTemplate] = useState<FilterTemplate | null>(null);
  const [hoveredDragHandle, setHoveredDragHandle] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newlyDuplicatedId, setNewlyDuplicatedId] = useState<string | null>(null);
  const [showFilterSelector, setShowFilterSelector] = useState<string | null>(null);
  const [showModelSelector, setShowModelSelector] = useState<string | null>(null);
  /** Side chains folded shut in the rail, by Load Video id. */
  const [collapsedChains, setCollapsedChains] = useState<Set<string>>(new Set());

  // Every category the templates use, offered when saving a step as a template.
  const categorySuggestions = useMemo(() => [...new Set(filterTemplates.flatMap(template =>
    toCategories(template.category, ['Uncategorized']).map(category => category || 'Uncategorized')
  ))].sort(), [filterTemplates]);
  const [pendingFilters, setPendingFilters] = useState<Filter[]>(filters);
  const previousExpandedCountRef = useRef<number>(expandedFilters.size);
  const previousProcessingRef = useRef<boolean>(isProcessing);

  // Code typed into a step and not committed yet, by step id. A step's code
  // is committed when its editor loses focus (so the script is not rebuilt on
  // every keystroke), which leaves the typing exposed in between: to the chain
  // changing underneath it, and to the window closing.
  const dirtyCodeRef = useRef(new Map<string, string>());
  const pendingRef = useRef(pendingFilters);
  pendingRef.current = pendingFilters;

  /** Every commit goes through here; whatever was typed is in it. */
  const onFiltersChange = (updated: Filter[]) => {
    dirtyCodeRef.current.clear();
    onFiltersChangeProp(updated);
  };
  const commitRef = useRef(onFiltersChangeProp);
  commitRef.current = onFiltersChangeProp;

  // Closing the window does not take focus from the editor first, so commit
  // the typing before the queue and chain are written on the way out.
  useEffect(() => onBeforeClose('commit', () => {
    if (dirtyCodeRef.current.size === 0) return;
    dirtyCodeRef.current.clear();
    commitRef.current(pendingRef.current);
  }), []);

  // Sync pending filters when filters prop changes from outside. Normalized,
  // because a list from a workflow or an older version may not be in the
  // order the rail shows chains in, and every handler here relies on it.
  // Typing not yet committed stays on its step when the change comes from
  // elsewhere (a finished Align or LUT, an imported model), but not when a
  // different chain was swapped in, where the same id is another item's step.
  const syncedEpochRef = useRef(chainEpoch);
  useEffect(() => {
    if (syncedEpochRef.current !== chainEpoch) {
      syncedEpochRef.current = chainEpoch;
      dirtyCodeRef.current.clear();
    }
    const dirty = dirtyCodeRef.current;
    setPendingFilters(normalizeChainOrder(filters).map(filter =>
      dirty.has(filter.id) ? { ...filter, code: dirty.get(filter.id)! } : filter));
  }, [filters, chainEpoch]);

  // When processing stops, put focus back where it was: Electron and Chromium
  // can leave the window or a re-enabled textarea not taking input.
  useEffect(() => {
    const wasProcessing = previousProcessingRef.current;
    previousProcessingRef.current = isProcessing;
    if (!wasProcessing || isProcessing) return;

    // After React has re-rendered and removed the disabled attributes
    const timeoutId = setTimeout(() => {
      window.focus();

      // A textarea that kept focus is blurred and refocused to reset its input state
      const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea[data-filter-textarea]');
      textareas.forEach(textarea => {
        if (document.activeElement === textarea && !textarea.disabled) {
          const scrollPos = textarea.scrollTop;
          const selectionStart = textarea.selectionStart;
          const selectionEnd = textarea.selectionEnd;
          textarea.blur();
          requestAnimationFrame(() => {
            textarea.focus();
            textarea.scrollTop = scrollPos;
            textarea.setSelectionRange(selectionStart, selectionEnd);
          });
        }
      });
    }, 50);

    return () => clearTimeout(timeoutId);
  }, [isProcessing]);

  // Auto-evaluate when all filters are collapsed
  useEffect(() => {
    const currentExpandedCount = expandedFilters.size;
    const previousExpandedCount = previousExpandedCountRef.current;

    // Check if we just collapsed the last filter (went from 1 to 0 expanded)
    if (previousExpandedCount > 0 && currentExpandedCount === 0) {
      // Immediately apply pending changes
      if (JSON.stringify(pendingFilters) !== JSON.stringify(filters)) {
        onFiltersChange(pendingFilters);
      }
    }

    previousExpandedCountRef.current = currentExpandedCount;
  }, [expandedFilters.size]);

  /**
   * Every change that adds, removes or moves a step goes through here, so the
   * array stays in the order the rail shows it (normalizeChainOrder) and an
   * array position keeps meaning one place in one chain.
   */
  const commitOrder = (updated: Filter[]) => {
    const normalized = normalizeChainOrder(updated);
    setPendingFilters(normalized);
    onFiltersChange(normalized);
    return normalized;
  };

  /** Replaces the chain this panel shows, ahead of the next render. */
  const setPending = (updated: Filter[]) => {
    pendingRef.current = updated;
    setPendingFilters(updated);
  };

  /**
   * Applies `patch` to one step and commits the chain. It works on the chain
   * as it is now (pendingRef), not as the render that made the handler saw
   * it, so two patches in one handler both land.
   */
  const patchStep = (id: string, patch: (step: Filter) => Filter) => {
    const updated = pendingRef.current.map(step => (step.id === id ? patch(step) : step));
    setPending(updated);
    onFiltersChange(updated);
  };

  /** Past every existing order, so normalizing puts it last in its chain. */
  const nextOrder = () => pendingFilters.reduce((max, f) => Math.max(max, f.order), -1) + 1;

  /** A new, enabled step, numbered to go last in its chain. */
  const newStep = (filterType: Filter['filterType'], preset: string, fields: Partial<Filter> = {}): Filter => ({
    id: `filter-${Date.now()}`,
    enabled: true,
    filterType,
    preset,
    code: '',
    order: nextOrder(),
    ...fields,
  });

  /** Adds a step and opens it, with its picker over it. */
  const addStep = (step: Filter, openPicker: (id: string) => void) => {
    commitOrder([...pendingFilters, step]);
    setExpandedFilters(prev => new Set([...prev, step.id]));
    setShowAddMenu(false);
    openPicker(step.id);
  };

  const handleAddCustomFilter = (chain?: string) => {
    addStep(newStep('custom', '', chain ? { chain } : {}), setShowFilterSelector);
  };

  const handleAddAIModelFilter = (chain?: string) => {
    addStep(newStep('aiModel', 'AI Model', { modelPath: '', modelType: 'image', ...(chain ? { chain } : {}) }), setShowModelSelector);
  };

  /** A new side chain: a Load Video, below any others, with its file chosen up front. */
  const handleAddVideoSource = async () => {
    setShowAddMenu(false);
    const path = await window.electronAPI.selectReferenceVideo();
    if (!path) return;
    // Normalizing sorts Load Videos among themselves by order, so the
    // largest puts this one below the others and above the main chain.
    commitOrder([...pendingFilters, newStep('videoSource', 'Load Video', { sourcePath: path })]);
  };

  /**
   * A Load Video and its side chain cannot be separated: the steps below it
   * work on its video and nothing else's, so they go with it rather than being
   * left behind to run nowhere.
   */
  const handleRemoveFilter = (id: string) => {
    const target = pendingFilters.find(f => f.id === id);
    const removing = target !== undefined && isSideChainHead(target);
    commitOrder(pendingFilters.filter(f => f.id !== id && !(removing && f.chain === id)));
    setExpandedFilters(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleDuplicateFilter = (id: string) => {
    const filterToDuplicate = pendingFilters.find(f => f.id === id);
    if (!filterToDuplicate) return;

    const duplicateIndex = pendingFilters.findIndex(f => f.id === id);
    const newFilterId = `filter-${Date.now()}`;

    const newFilter: Filter = {
      ...filterToDuplicate,
      id: newFilterId,
      order: duplicateIndex + 1,
    };

    // Insert the new filter right after the original
    const updatedFilters = [...pendingFilters];
    updatedFilters.splice(duplicateIndex + 1, 0, newFilter);

    // Update order property for all filters
    commitOrder(updatedFilters.map((f, index) => ({ ...f, order: index })));
    setExpandedFilters(prev => new Set([...prev, newFilterId]));

    // Set the newly duplicated ID for animation
    setNewlyDuplicatedId(newFilterId);

    // Clear the animation after 0.33s + 0.2s fade
    setTimeout(() => {
      setNewlyDuplicatedId(null);
    }, 530);
  };

  const handleToggleFilter = (id: string, enabled: boolean) => {
    patchStep(id, f => ({ ...f, enabled }));
  };

  const handleModelChange = (id: string, modelPath: string) => {
    const selectedModel = availableModels.find(m => m.path === modelPath);
    // The step's type is the model's own, from its metadata
    patchStep(id, f => ({ ...f, modelPath, modelType: selectedModel?.modelType || 'image' }));
  };

  const handlePresetChange = (id: string, preset: string) => {
    const template = filterTemplates.find(t => t.name === preset);
    patchStep(id, f => ({ ...f, preset, ...fromTemplate(template) }));
  };

  /**
   * Add the Load LUT that puts a Create LUT's colour back.
   *
   * At the end of the chain, already pointed at the marker, because the one
   * thing known about where it belongs is "below whatever changes the
   * colour" — and the end is the only position that is certainly that.
   * Expanded, so the card saying what to do next is the next thing seen.
   */
  const handleAddLoader = (markerId: string) => {
    const template = filterTemplates.find(t => t.name === 'Load LUT');
    if (!template) return;
    const fields = fromTemplate(template);
    const step = newStep('custom', template.name, {
      ...fields,
      parameters: { ...fields.parameters, source_id: markerId },
    });
    commitOrder([...pendingFilters, step]);
    setExpandedFilters(prev => new Set([...prev, step.id]));
  };

  const handleCodeChange = (id: string, code: string) => {
    dirtyCodeRef.current.set(id, code);
    setPending(pendingRef.current.map(f => (f.id === id ? { ...f, code } : f)));
  };

  const handleCodeBlur = () => {
    dirtyCodeRef.current.clear();
    // Apply pending changes when user deselects the textarea
    if (JSON.stringify(pendingFilters) !== JSON.stringify(filters)) {
      onFiltersChange(pendingFilters);
    }
  };

  /** Writes several of a step's parameters in one commit. */
  const handleFilterParametersChange = (filterId: string, changes: NonNullable<Filter['parameters']>) => {
    patchStep(filterId, filter => {
      const template = filterTemplates.find(candidate => candidate.name === filter.preset);
      return {
        ...filter,
        parameters: {
          ...defaultsForVariables(template),
          ...filter.parameters,
          ...changes,
        },
        variables: filter.variables ?? template?.variables,
        editor: filter.editor ?? template?.editor,
      };
    });
  };

  const handleOpenInteractiveEditor = (filter: Filter, selectedTemplate?: FilterTemplate) => {
    const editor = filter.editor ?? selectedTemplate?.editor;
    if (!editor || !onOpenFilterEditor) return;

    // Older saved filters did not retain template editor metadata. Hydrate them
    // when opened so the edited values survive filter configuration, workflows,
    // and queue operations from this point onward.
    const variables = filter.variables ?? selectedTemplate?.variables;
    const parameters = {
      ...defaultsForVariables(selectedTemplate),
      ...filter.parameters,
    };
    const preparedFilter: Filter = {
      ...filter,
      editor,
      variables,
      parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
    };
    patchStep(filter.id, () => preparedFilter);
    onOpenFilterEditor(preparedFilter);
  };

  const toggleExpanded = (id: string) => {
    setExpandedFilters(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * Saving a template under a name another template has replaces that one's
   * file, which may be a built-in the user edited or one of their own. Ask
   * first. except is the name being saved over on purpose (the step's own).
   */
  const confirmReplaceTemplate = async (name: string, except?: string): Promise<boolean> => {
    if (name === except || !filterTemplates.some(template => template.name === name)) return true;
    return ask({
      title: 'Replace filter',
      message: `A filter called "${name}" already exists. Replace it?`,
      confirmLabel: 'Replace',
      tone: 'danger',
    });
  };

  const handleSaveTemplate = async (filterId: string, fields: SaveTemplateFields) => {
    const filter = pendingFilters.find(f => f.id === filterId);
    const name = fields.name.trim();
    if (onSaveTemplate && name && filter) {
      if (!(await confirmReplaceTemplate(name, filter.preset))) return;
      const success = await onSaveTemplate({
        name,
        code: filter.code,
        category: fields.categories.length > 0 ? fields.categories : undefined,
        description: fields.description.trim() || undefined,
        variables: filter.variables,
        editor: filter.editor,
      });
      if (success) setShowSaveDialog(null);
    }
  };

  const handleImportTemplate = async () => {
    try {
      const filePath = await window.electronAPI.selectTemplateFile();
      if (!filePath) return;

      const result = await window.electronAPI.importTemplateFile(filePath);
      if (!result.success || !result.template) {
        notify.error('Import Error', `Failed to import template: ${result.error || 'Unknown error'}`);
        return;
      }

      const template = result.template;
      if (!(await confirmReplaceTemplate(template.name))) return;

      if (onSaveTemplate) {
        await onSaveTemplate(template);
      }
    } catch (err) {
      notify.error('Import Error', 'Failed to import template. Please check the file format.');
      console.error('Import error:', err);
    }
  };

  const handleDeleteTemplate = async (name: string, filterId: string) => {
    // A deleted built-in filter never comes back with an update, so ask first.
    if (!(await ask({
      title: 'Delete template',
      message: `Delete template "${name}"?\n\nA built-in filter can be restored from the bottom of the filter picker.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    }))) {
      return;
    }
    if (onDeleteTemplate) {
      await onDeleteTemplate(name);
      // Reset selection if deleted template was selected
      const filter = pendingFilters.find(f => f.id === filterId);
      if (filter?.preset === name) {
        handlePresetChange(filterId, '');
      }
    }
  };

  const handleEditTemplate = async (oldName: string, updatedTemplate: FilterTemplate): Promise<boolean> => {
    if (!onSaveTemplate) return false;
    if (oldName !== updatedTemplate.name && !(await confirmReplaceTemplate(updatedTemplate.name))) return false;

    const previousCode = filterTemplates.find(template => template.name === oldName)?.code;
    try {
      // Saved under the new name before the old one is deleted, so a failed
      // save leaves the template where it was.
      const success = await onSaveTemplate(updatedTemplate);
      if (success && oldName !== updatedTemplate.name && onDeleteTemplate) {
        await onDeleteTemplate(oldName);
      }

      if (success) {
        // Steps using it follow: the new name, and the new code where the step
        // still had the template's code unchanged. A step whose code was
        // edited keeps it; that edit is the user's, not the template's.
        const updatedFilters = pendingFilters.map(f => {
          if (f.preset !== oldName) return f;
          const followsCode = previousCode !== undefined && f.code === previousCode;
          return { ...f, preset: updatedTemplate.name, ...(followsCode ? { code: updatedTemplate.code } : {}) };
        });
        if (JSON.stringify(updatedFilters) !== JSON.stringify(pendingFilters)) {
          setPendingFilters(updatedFilters);
          onFiltersChange(updatedFilters);
        }
      }

      return success;
    } catch (error) {
      console.error('Error editing template:', error);
      return false;
    }
  };

  const revealChain = (chainId: string) =>
    setCollapsedChains(prev => { const next = new Set(prev); next.delete(chainId); return next; });

  const drag = useDragReorder({ steps: pendingFilters, commit: commitOrder, reveal: revealChain });

  const handleToggleAllFilters = () => {
    const allEnabled = pendingFilters.every(f => f.enabled);
    const updatedFilters = pendingFilters.map(f => ({ ...f, enabled: !allEnabled }));
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handleToggleAllExpanded = () => {
    const allExpanded = pendingFilters.every(f => expandedFilters.has(f.id));
    if (allExpanded) {
      setExpandedFilters(new Set());
    } else {
      setExpandedFilters(new Set(pendingFilters.map(f => f.id)));
    }
  };

  const stepContext: StepCardContext = {
    isProcessing,
    availableModels,
    filterTemplates,
    categorySuggestions,
    defaultBackend,
    defaultNumStreams,
    showBackendOverrides,
    lut,
    onImportClick,
    canSaveTemplate: !!onSaveTemplate,
    canDeleteTemplate: !!onDeleteTemplate,
    canOpenEditor: !!onOpenFilterEditor,
  };

  const stepActions: StepCardActions = {
    hoverHandle: setHoveredDragHandle,
    toggleExpanded,
    toggle: handleToggleFilter,
    duplicate: handleDuplicateFilter,
    remove: handleRemoveFilter,
    openModelSelector: setShowModelSelector,
    openFilterSelector: setShowFilterSelector,
    setBackend: (id: string, backend: FilterBackend) =>
      patchStep(id, f => ({ ...f, backend: backend === 'auto' ? undefined : backend })),
    setStreams: (id: string, numStreams: number | undefined) => patchStep(id, f => ({ ...f, numStreams })),
    // The form opens pre-filled from the step's template, so saving over it
    // keeps its name and categories.
    toggleSaveForm: (id: string) => setShowSaveDialog(open => (open === id ? null : id)),
    saveTemplate: (id, fields) => { void handleSaveTemplate(id, fields); },
    importTemplate: () => { void handleImportTemplate(); },
    editTemplate: setEditingTemplate,
    deleteTemplate: (name, id) => { void handleDeleteTemplate(name, id); },
    setParameters: handleFilterParametersChange,
    setParameter: (id, name, value) => handleFilterParametersChange(id, { [name]: value }),
    addLoader: handleAddLoader,
    openEditor: handleOpenInteractiveEditor,
    changeCode: handleCodeChange,
    commitCode: handleCodeBlur,
  };

  // Side chains in the rail: where the "Main chain" label goes.
  const layout = layoutChains(pendingFilters);
  const hasSideChains = layout.side.length > 0;
  const firstMainId = layout.main.steps[0]?.id;
  const toggleChainFold = (id: string) => setCollapsedChains(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * Under a side chain. Empty, it says how to fill it and offers the two
   * adds. While a step is being dragged, every open side chain shows one, so
   * there is somewhere to drop a step at the end of it.
   */
  const chainDropZone = (chainId: string, empty: boolean) => {
    const dragging = drag.draggingStep;
    if (!empty && !dragging) return null;
    const over = drag.dragOverId === `end:${chainId}`;
    const letter = stepTag(pendingFilters, chainId);
    return (
      <div
        onDragOver={(e) => drag.onChainEndDragOver(e, chainId)}
        onDragLeave={drag.onDragLeave}
        onDrop={(e) => drag.onDropAtChainEnd(e, chainId)}
        className={`relative ml-7 mr-1.5 mb-1.5 h-7 px-2 rounded border border-dashed flex items-center gap-1.5 text-[11px] transition-colors ${
          over ? 'border-chain-400 bg-chain-500/15 text-chain-200' : 'border-chain-700/70 text-ink-500'
        }`}
      >
        <div className="absolute -left-3.5 -top-1.5 bottom-1/2 w-0.5 bg-chain-500/35 rounded-full" aria-hidden="true" />
        {dragging ? (
          <span>Drop to add to the end of side chain {letter}</span>
        ) : (
          <>
            <span className="truncate">Drag steps here to run them on this video, or add</span>
            <button
              type="button"
              onClick={() => handleAddCustomFilter(chainId)}
              disabled={isProcessing}
              className="text-chain-300 hover:text-chain-200 font-semibold flex-shrink-0 disabled:opacity-50"
            >
              VS Filter
            </button>
            <span className="text-ink-600">/</span>
            <button
              type="button"
              onClick={() => handleAddAIModelFilter(chainId)}
              disabled={isProcessing}
              className="text-chain-300 hover:text-chain-200 font-semibold flex-shrink-0 disabled:opacity-50"
            >
              AI Model
            </button>
          </>
        )}
      </div>
    );
  };

  /** The last row of each open side chain, which the drop zone follows. */
  const zoneAfter = new Map<string, { chain: string; empty: boolean }>();
  for (const chain of layout.side) {
    if (collapsedChains.has(chain.id)) continue;
    const last = chain.steps[chain.steps.length - 1];
    zoneAfter.set(last?.id ?? chain.id, { chain: chain.id, empty: !last });
  }

  return (
    <>
    <Section
      title={title}
      meta={pendingFilters.length > 0
        ? `${pendingFilters.filter(f => f.enabled).length}/${pendingFilters.length} on`
        : undefined}
      actions={<>
          <div className="relative group flex items-center">
            <Info className="w-3.5 h-3.5 text-ink-500 hover:text-accent-400 transition-colors cursor-help" />
            <div className="absolute right-0 top-full mt-2 w-64 bg-ink-950 border border-ink-750 rounded-lg p-3 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-[100] shadow-xl">
              <p className="text-xs text-ink-300 mb-2 font-medium">Tips:</p>
              <ul className="list-disc list-inside space-y-1 text-xs text-ink-400">
                <li>Use <code className="bg-ink-900 px-1 rounded text-accent-400">clip</code> variable for the video stream</li>
                <li>Use <code className="bg-ink-900 px-1 rounded text-accent-400">original_clip</code> variable to reference the original/input video stream</li>
                <li>Filters are applied in the order shown (top to bottom)</li>
                <li>Add AI models anywhere in the filter workflow</li>
              </ul>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Toggle All Filters Button */}
            {pendingFilters.length > 0 && (
              <>
                <SectionButton
                  onClick={handleToggleAllFilters}
                  disabled={isProcessing}
                  title={pendingFilters.every(f => f.enabled) ? "Disable all filters" : "Enable all filters"}
                >
                  {pendingFilters.every(f => f.enabled) ? (
                    <><ToggleRight className="w-3 h-3" />Disable all</>
                  ) : (
                    <><ToggleLeft className="w-3 h-3" />Enable all</>
                  )}
                </SectionButton>
                <SectionButton
                  onClick={handleToggleAllExpanded}
                  disabled={isProcessing}
                  title={pendingFilters.every(f => expandedFilters.has(f.id)) ? "Collapse all filters" : "Expand all filters"}
                >
                  {pendingFilters.every(f => expandedFilters.has(f.id)) ? (
                    <><ChevronsUpDown className="w-3 h-3" />Collapse</>
                  ) : (
                    <><ChevronsDownUp className="w-3 h-3" />Expand</>
                  )}
                </SectionButton>
              </>
            )}
            {/* Add Filter Button — the section's one accented control */}
            <div className="relative">
              <SectionButton
                onClick={() => setShowAddMenu(!showAddMenu)}
                disabled={isProcessing}
                active
                title="Add filter"
              >
                <Plus className="w-3 h-3" />
                Add filter
              </SectionButton>
              {showAddMenu && (
                <div className="absolute right-0 top-full mt-1 bg-ink-850 border border-ink-750 rounded-lg shadow-xl shadow-black/50 z-50 min-w-[160px] overflow-hidden">
                  <button
                    onClick={() => handleAddAIModelFilter()}
                    className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200 border-b border-ink-800"
                  >
                    <Sparkles className="w-4 h-4 text-accent-400" />
                    AI Model
                  </button>
                  <button
                    onClick={() => handleAddCustomFilter()}
                    className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200 border-b border-ink-800"
                  >
                    <LucideFilter className="w-4 h-4 text-ink-400" />
                    VS Filter
                  </button>
                  <button
                    onClick={() => { void handleAddVideoSource(); }}
                    title="Load a second video with its own steps — a side chain another step can read from"
                    className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200"
                  >
                    <Film className="w-4 h-4 text-chain-400" />
                    Load Video
                  </button>
                </div>
              )}
            </div>
          </div>
        </>}
      >

        {/* Empty State with Drop Zone */}
        {pendingFilters.length === 0 && (
          <div 
            className="m-1.5 rounded border border-dashed border-ink-700 bg-ink-900 px-3 py-6 text-center transition-colors hover:bg-ink-850 hover:border-ink-600"
            onDrop={(e) => e.preventDefault()}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
          >
            <LucideFilter className="w-7 h-7 text-ink-600 mx-auto mb-2" />
            <p className="text-ink-300 text-[12.5px] mb-0.5">No filters added yet</p>
            <p className="text-ink-500 text-[11px]">Use “Add filter” above to get started</p>
          </div>
        )}

        {/* Filter List */}
        {pendingFilters.map((filter, index) => {
          const isHead = isSideChainHead(filter);
          const inSide = !isHead && Boolean(filter.chain);
          // A folded side chain shows its Load Video and nothing below it.
          if (inSide && collapsedChains.has(filter.chain!)) return null;
          const tag = stepTag(pendingFilters, filter.id) || String(index + 1);
          const mainLabel = hasSideChains && filter.id === firstMainId && (
            <div className="mx-2 mt-2 -mb-0.5 text-[10px] font-display font-semibold uppercase tracking-[0.08em] text-ink-500">
              Main chain
            </div>
          );

          if (isHead) {
            const chain = layout.side.find(c => c.id === filter.id);
            return (
              <Fragment key={filter.id}>
                <div
                  onDragOver={(e) => drag.onDragOver(e, filter.id)}
                  onDragLeave={drag.onDragLeave}
                  onDrop={(e) => drag.onDrop(e, filter.id)}
                  className={`relative m-1.5 rounded ${drag.draggedId === filter.id ? 'opacity-40' : ''}`}
                >
                  {drag.dragOverId === filter.id && drag.draggedId !== filter.id && (
                    drag.draggingHead
                      ? <div className="absolute -top-1.5 left-0 right-0 h-0.5 bg-chain-400 rounded-full z-10" />
                      : <div className="absolute inset-0 rounded ring-2 ring-chain-400 pointer-events-none z-10" />
                  )}
                  <LoadVideoCard
                    filter={filter}
                    tag={tag}
                    stepCount={chain?.steps.length ?? 0}
                    folded={collapsedChains.has(filter.id)}
                    disabled={isProcessing}
                    onFold={() => toggleChainFold(filter.id)}
                    onToggle={(enabled) => handleToggleFilter(filter.id, enabled)}
                    onRemove={() => handleRemoveFilter(filter.id)}
                    onRename={(name) => patchStep(filter.id, f => ({ ...f, preset: name }))}
                    onPickVideo={() => window.electronAPI.selectReferenceVideo()}
                    // A new file makes the old alignment a measurement of something else.
                    onChooseVideo={(path) => patchStep(filter.id, f => ({ ...f, sourcePath: path, align: undefined }))}
                    mainVideoPath={mainVideoPath}
                    onAlignStart={() => {
                      if (beginStepPatch) {
                        const commit = beginStepPatch(filter.id);
                        return (align) => commit(f => ({ ...f, align }));
                      }
                      return (align) => {
                        if (!pendingRef.current.some(f => f.id === filter.id)) return false;
                        patchStep(filter.id, f => ({ ...f, align }));
                        return true;
                      };
                    }}
                    dragProps={{
                      draggable: !isProcessing,
                      onDragStart: (e) => drag.onDragStart(e, filter.id),
                      onDragEnd: drag.onDragEnd,
                    }}
                  />
                </div>
                {zoneAfter.get(filter.id) && chainDropZone(zoneAfter.get(filter.id)!.chain, zoneAfter.get(filter.id)!.empty)}
              </Fragment>
            );
          }

          return (
            <Fragment key={filter.id}>
            {mainLabel}
            <StepCard
              filter={filter}
              tag={tag}
              inSide={inSide}
              steps={pendingFilters}
              isExpanded={expandedFilters.has(filter.id)}
              isDragging={drag.draggedId === filter.id}
              isHovered={hoveredDragHandle === filter.id}
              isNewlyDuplicated={newlyDuplicatedId === filter.id}
              dropTarget={drag.dragOverId === filter.id}
              saveFormOpen={showSaveDialog === filter.id}
              context={stepContext}
              actions={stepActions}
              drag={{
                onDragOver: (e) => drag.onDragOver(e, filter.id),
                onDragLeave: drag.onDragLeave,
                onDrop: (e) => drag.onDrop(e, filter.id),
                onDragStart: (e) => drag.onDragStart(e, filter.id),
                onDragEnd: drag.onDragEnd,
              }}
            />
            {zoneAfter.get(filter.id) && chainDropZone(zoneAfter.get(filter.id)!.chain, zoneAfter.get(filter.id)!.empty)}
            </Fragment>
          );
        })}
    </Section>

      {/* Edit Filter, opened from a step's card */}
      {editingTemplate && (
        <TemplateEditDialog
          template={editingTemplate}
          onSave={updated => handleEditTemplate(editingTemplate.name, updated)}
          onClose={() => setEditingTemplate(null)}
        />
      )}

      {/* Filter Selector Modal */}
      {showFilterSelector && (
        <FilterSelectorModal
          isOpen={true}
          onClose={() => setShowFilterSelector(null)}
          filterTemplates={filterTemplates}
          currentSelection={pendingFilters.find(f => f.id === showFilterSelector)?.preset || ''}
          onSelectTemplate={(templateName) => {
            if (showFilterSelector) {
              handlePresetChange(showFilterSelector, templateName);
            }
          }}
          onRestoreTemplates={onRestoreTemplates}
          onDeleteTemplate={onDeleteTemplate ? async (name: string) => {
            const success = await onDeleteTemplate(name);
            if (success && showFilterSelector) {
              // Reset selection if deleted template was selected
              const filter = pendingFilters.find(f => f.id === showFilterSelector);
              if (filter?.preset === name) {
                handlePresetChange(showFilterSelector, '');
              }
            }
            return success;
          } : undefined}
          onEditTemplate={onSaveTemplate ? handleEditTemplate : undefined}
        />
      )}

      {/* Model Selector Modal - lists models for the edited filter's effective backend */}
      {showModelSelector && (
        <ModelSelectorModal
          isOpen={true}
          onClose={() => setShowModelSelector(null)}
          availableModels={availableModels}
          backendId={resolveFilterBackend(pendingFilters.find(f => f.id === showModelSelector)?.backend, defaultBackend)}
          currentSelection={pendingFilters.find(f => f.id === showModelSelector)?.modelPath || ''}
          onSelectModel={(modelPath) => {
            if (showModelSelector) {
              handleModelChange(showModelSelector, modelPath);
            }
          }}
          onImportModel={onImportClick}
          onModelsUpdated={onModelsUpdated}
        />
      )}
    </>
  );
});
