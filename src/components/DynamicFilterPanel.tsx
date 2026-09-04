import { memo, useState, useEffect, useRef } from 'react';
import { GripVertical, X, Plus, ChevronDown, ChevronUp, Save, Trash2, Download, Filter as LucideFilter, Info, Sparkles, ToggleLeft, ToggleRight, Copy, ChevronsDownUp, ChevronsUpDown, Crop, Palette } from 'lucide-react';
import type { BackendId, FilterBackend, Filter, FilterTemplate, ModelFile } from '../electron.d';
import { BACKENDS, getBackendDescriptor, resolveFilterBackend } from '../utils/backends';
import { PythonCodeEditor } from './PythonCodeEditor';
import { Section, SectionButton } from './Section';
import { FilterSelectorModal } from './FilterSelectorModal';
import { ModelSelectorModal } from './ModelSelectorModal';
import { notify } from '../utils/notifications';

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
  onDragStart?: (filterId: string) => void;
  onDragEnd?: () => void;
  onDrop?: (targetId: string | null) => void;
  draggedFilterId?: string | null;
  onImportClick?: () => void;
  onModelsUpdated?: () => Promise<void>;
  /** Opens a visual editor declared by the selected .vkfilter template. */
  onOpenFilterEditor?: (filter: Filter) => void;
}

function defaultsForVariables(template: FilterTemplate | undefined): NonNullable<Filter['parameters']> | undefined {
  if (!template?.variables) return undefined;

  const parameters = Object.entries(template.variables).reduce<NonNullable<Filter['parameters']>>((values, [name, variable]) => {
    if (variable.default !== undefined) values[name] = variable.default;
    return values;
  }, {});

  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

/**
 * Icon button sized to sit inline with a 28px picker. Both filter branches put
 * their actions on the picker row rather than in a labelled row of their own —
 * that row cost ~28px per expanded filter to say what a tooltip already does.
 */
const PICKER_ACTION =
  'h-7 w-7 grid place-items-center rounded border border-ink-750 bg-ink-850 flex-shrink-0 ' +
  'transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500';

export const DynamicFilterPanel = memo<DynamicFilterPanelProps>(({
  title = 'Filters',
  filters,
  filterTemplates,
  isProcessing,
  availableModels = [],
  defaultBackend = 'tensorrt',
  defaultNumStreams = 2,
  showBackendOverrides = false,
  onFiltersChange,
  onSaveTemplate,
  onDeleteTemplate,
  onDragStart,
  onDragEnd,
  onDrop,
  draggedFilterId,
  onImportClick,
  onModelsUpdated,
  onOpenFilterEditor,
}: DynamicFilterPanelProps) => {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set());
  const [showSaveDialog, setShowSaveDialog] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [presetCategories, setPresetCategories] = useState<string[]>([]);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [hoveredDragHandle, setHoveredDragHandle] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newlyDuplicatedId, setNewlyDuplicatedId] = useState<string | null>(null);
  const [showFilterSelector, setShowFilterSelector] = useState<string | null>(null);
  const [showModelSelector, setShowModelSelector] = useState<string | null>(null);

  // Group filter templates by category (templates can appear in multiple categories)
  const groupedTemplates = filterTemplates.reduce((acc, template) => {
    // Support both single category and multiple categories
    const categories = Array.isArray(template.category) 
      ? template.category 
      : (template.category ? [template.category] : ['Uncategorized']);
    
    categories.forEach(category => {
      const cat = category || 'Uncategorized';
      if (!acc[cat]) {
        acc[cat] = [];
      }
      // Avoid duplicates if template is already in this category
      if (!acc[cat].find(t => t.name === template.name)) {
        acc[cat].push(template);
      }
    });
    return acc;
  }, {} as Record<string, FilterTemplate[]>);
  const [pendingFilters, setPendingFilters] = useState<Filter[]>(filters);
  const previousExpandedCountRef = useRef<number>(expandedFilters.size);
  const previousProcessingRef = useRef<boolean>(isProcessing);

  // Sync pending filters when filters prop changes from outside
  useEffect(() => {
    setPendingFilters(filters);
  }, [filters]);

  // Handle focus restoration when processing state changes
  useEffect(() => {
    const wasProcessing = previousProcessingRef.current;
    
    // If processing just stopped, ensure the window/app regains proper focus
    if (wasProcessing && !isProcessing) {
      // Force a small delay to ensure disabled attributes are removed and React has re-rendered
      const timeoutId = setTimeout(() => {
        // Ensure the window has focus (fixes Electron/Chromium focus desync)
        window.focus();
        
        // If a textarea was focused before processing, restore its interactivity
        const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea[data-filter-textarea]');
        textareas.forEach(textarea => {
          if (document.activeElement === textarea && !textarea.disabled) {
            // Clear and restore focus to reset any stuck input state
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
    }
    
    previousProcessingRef.current = isProcessing;
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

  const handleAddCustomFilter = () => {
    const newFilter: Filter = {
      id: `filter-${Date.now()}`,
      enabled: true,
      filterType: 'custom',
      preset: '',
      code: '',
      order: pendingFilters.length,
    };
    const updatedFilters = [...pendingFilters, newFilter];
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
    setExpandedFilters(prev => new Set([...prev, newFilter.id]));
    setShowAddMenu(false);
    // Immediately open the filter selector modal for the new filter
    setShowFilterSelector(newFilter.id);
  };

  const handleAddAIModelFilter = () => {
    const newFilter: Filter = {
      id: `filter-${Date.now()}`,
      enabled: true,
      filterType: 'aiModel',
      preset: 'AI Model',
      code: '',
      order: pendingFilters.length,
      modelPath: '',
      modelType: 'image',
    };
    const updatedFilters = [...pendingFilters, newFilter];
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
    setExpandedFilters(prev => new Set([...prev, newFilter.id]));
    setShowAddMenu(false);
    // Immediately open the model selector for the new AI model filter
    setShowModelSelector(newFilter.id);
  };

  const handleRemoveFilter = (id: string) => {
    const updatedFilters = pendingFilters
      .filter(f => f.id !== id)
      .map((f, index) => ({ ...f, order: index }));
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
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
    const reorderedFilters = updatedFilters.map((f, index) => ({ ...f, order: index }));
    
    setPendingFilters(reorderedFilters);
    onFiltersChange(reorderedFilters);
    setExpandedFilters(prev => new Set([...prev, newFilterId]));
    
    // Set the newly duplicated ID for animation
    setNewlyDuplicatedId(newFilterId);
    
    // Clear the animation after 0.33s + 0.2s fade
    setTimeout(() => {
      setNewlyDuplicatedId(null);
    }, 530);
  };

  const handleToggleFilter = (id: string, enabled: boolean) => {
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? { ...f, enabled } : f
    );
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handleFilterBackendChange = (id: string, backend: FilterBackend) => {
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? { ...f, backend: backend === 'auto' ? undefined : backend } : f
    );
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handleFilterStreamsChange = (id: string, value: number | undefined) => {
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? { ...f, numStreams: value } : f
    );
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handleModelChange = (id: string, modelPath: string) => {
    const selectedModel = availableModels.find(m => m.path === modelPath);
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? {
        ...f,
        modelPath,
        // Use the actual modelType from the model's metadata
        modelType: selectedModel?.modelType || 'image'
      } : f
    );
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handlePresetChange = (id: string, preset: string) => {
    const templateObj = filterTemplates.find(t => t.name === preset);
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? {
        ...f,
        preset,
        code: templateObj?.code || '',
        category: templateObj?.category,
        parameters: defaultsForVariables(templateObj),
        variables: templateObj?.variables,
        editor: templateObj?.editor,
      } : f
    );
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
  };

  const handleCodeChange = (id: string, code: string) => {
    const updatedFilters = pendingFilters.map(f =>
      f.id === id ? { ...f, code } : f
    );
    setPendingFilters(updatedFilters);
  };

  const handleCodeBlur = () => {
    // Apply pending changes when user deselects the textarea
    if (JSON.stringify(pendingFilters) !== JSON.stringify(filters)) {
      onFiltersChange(pendingFilters);
    }
  };

  const handleFilterParameterChange = (filterId: string, name: string, value: NonNullable<Filter['parameters']>[string]) => {
    const updatedFilters = pendingFilters.map(filter => {
      if (filter.id !== filterId) return filter;
      const template = filterTemplates.find(candidate => candidate.name === filter.preset);
      return {
        ...filter,
        parameters: {
          ...defaultsForVariables(template),
          ...filter.parameters,
          [name]: value,
        },
        variables: filter.variables ?? template?.variables,
        editor: filter.editor ?? template?.editor,
      };
    });
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
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
    const updatedFilters = pendingFilters.map(current => current.id === filter.id ? preparedFilter : current);
    setPendingFilters(updatedFilters);
    onFiltersChange(updatedFilters);
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


  const handleSaveTemplate = async (filterId: string) => {
    const filter = pendingFilters.find(f => f.id === filterId);
    if (onSaveTemplate && presetName.trim() && filter) {
      const success = await onSaveTemplate({
        name: presetName.trim(),
        code: filter.code,
        category: presetCategories.length > 0 ? presetCategories : undefined,
        description: presetDescription.trim() || undefined,
        variables: filter.variables,
        editor: filter.editor,
      });
      if (success) {
        setPresetName('');
        setPresetDescription('');
        setPresetCategories([]);
        setNewCategoryInput('');
        setShowSaveDialog(null);
      }
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
      
      if (onSaveTemplate) {
        await onSaveTemplate(template);
      }
    } catch (err) {
      notify.error('Import Error', 'Failed to import template. Please check the file format.');
      console.error('Import error:', err);
    }
  };

  const handleDeleteTemplate = async (name: string, filterId: string) => {
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
    
    try {
      // If name changed, delete the old template first
      if (oldName !== updatedTemplate.name && onDeleteTemplate) {
        await onDeleteTemplate(oldName);
      }
      
      // Save the updated template
      const success = await onSaveTemplate(updatedTemplate);
      
      if (success && oldName !== updatedTemplate.name) {
        // Update any filters using the old template name to use the new name
        const updatedFilters = pendingFilters.map(f =>
          f.preset === oldName ? { ...f, preset: updatedTemplate.name } : f
        );
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

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    onDragStart?.(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedId !== id && draggedFilterId !== id) {
      setDragOverId(id);
    }
  };

  const handleDragLeave = () => {
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);

    // Check if this is a cross-section drop
    if (draggedFilterId && draggedFilterId !== draggedId) {
      // This is a cross-section drop, let parent handle it
      onDrop?.(targetId);
      return;
    }

    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      return;
    }

    const draggedIndex = pendingFilters.findIndex(f => f.id === draggedId);
    const targetIndex = pendingFilters.findIndex(f => f.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedId(null);
      return;
    }

    const newFilters = [...pendingFilters];
    const [draggedFilter] = newFilters.splice(draggedIndex, 1);
    newFilters.splice(targetIndex, 0, draggedFilter);

    // Update order property
    const reorderedFilters = newFilters.map((f, index) => ({ ...f, order: index }));
    setPendingFilters(reorderedFilters);
    onFiltersChange(reorderedFilters);
    setDraggedId(null);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
    onDragEnd?.();
  };

  // Handle drop on empty section
  const handleEmptyDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedFilterId && draggedFilterId !== draggedId) {
      // Cross-section drop to empty section
      onDrop?.(null);
    }
  };

  const handleEmptyDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

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
                    onClick={handleAddAIModelFilter}
                    className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200 border-b border-ink-800"
                  >
                    <Sparkles className="w-4 h-4 text-accent-400" />
                    AI Model
                  </button>
                  <button
                    onClick={handleAddCustomFilter}
                    className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-ink-800 transition-colors flex items-center gap-2 text-ink-200"
                  >
                    <LucideFilter className="w-4 h-4 text-ink-400" />
                    VS Filter
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
            onDrop={handleEmptyDrop}
            onDragOver={handleEmptyDragOver}
          >
            <LucideFilter className="w-7 h-7 text-ink-600 mx-auto mb-2" />
            <p className="text-ink-300 text-[12.5px] mb-0.5">No filters added yet</p>
            <p className="text-ink-500 text-[11px]">Use “Add filter” above to get started</p>
          </div>
        )}

        {/* Filter List */}
        {pendingFilters.map((filter, index) => {
          const isExpanded = expandedFilters.has(filter.id);
          const selectedTemplate = filterTemplates.find(t => t.name === filter.preset);
          const isDragging = draggedId === filter.id || draggedFilterId === filter.id;
          const isHovered = hoveredDragHandle === filter.id;
          const isAIModel = filter.filterType === 'aiModel';
          const isNewlyDuplicated = newlyDuplicatedId === filter.id;
          const interactiveEditor = filter.editor ?? selectedTemplate?.editor;
          const exposedVariables = filter.variables ?? selectedTemplate?.variables;

          // Opens the save-as-template form, pre-filled from the selected
          // template so "save" over an existing one keeps its name and category.
          const toggleSaveDialog = () => {
            if (showSaveDialog === filter.id) {
              setShowSaveDialog(null);
              setPresetName('');
              setPresetDescription('');
              setPresetCategories([]);
              setNewCategoryInput('');
              return;
            }
            setShowSaveDialog(filter.id);
            const existing = filter.preset
              ? filterTemplates.find(t => t.name === filter.preset)
              : undefined;
            setPresetName(existing?.name ?? '');
            setPresetDescription(existing?.description ?? '');
            setPresetCategories(
              Array.isArray(existing?.category)
                ? existing.category
                : (existing?.category ? [existing.category] : [])
            );
            setNewCategoryInput('');
          };

          return (
            <div
              key={filter.id}
              onDragOver={(e) => handleDragOver(e, filter.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, filter.id)}
              className={`relative m-1.5 rounded ${
                isDragging ? 'opacity-40 scale-95' : 'opacity-100 scale-100'
              } ${
                isHovered && !isDragging ? 'scale-[1.01] transition-transform duration-200' : ''
              } ${
                !isDragging ? 'transition-opacity duration-200' : ''
              } ${
                isNewlyDuplicated ? 'animate-[highlight_0.33s_ease-in-out] bg-accent-500/20 border-accent-500/50 border-2 shadow-lg shadow-accent-500/50 transition-all duration-200' : ''
              }`}
            >
              {/* Drop indicator */}
              {dragOverId === filter.id && !isDragging && (
                <div className="absolute -top-1.5 left-0 right-0 h-0.5 bg-accent-500 rounded-full shadow-lg shadow-accent-500/50 z-10" />
              )}

              <div className={`bg-ink-900 rounded border border-ink-800 border-l-2 transition-colors ${
                filter.enabled
                  ? isAIModel
                    ? isExpanded ? 'border-l-accent-500' : 'border-l-accent-500/70'
                    : isExpanded ? 'border-l-ink-500' : 'border-l-ink-700'
                  : 'border-l-transparent opacity-50'
              } ${
                isHovered && !isDragging ? 'bg-ink-850' : ''
              }`}>
                {/* Filter Header */}
                <div 
                  draggable={!isProcessing}
                  onDragStart={(e) => handleDragStart(e, filter.id)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center gap-2.5 px-3 py-1.5 transition-colors cursor-grab active:cursor-grabbing rounded-t-[3px] ${
                    isExpanded
                      ? 'bg-ink-850 sticky top-9 z-[5]'
                      : 'rounded-b-[3px] hover:bg-ink-850/60'
                  }`}
                >
                  {/* Filter Order Number */}
                  <div className={`flex-shrink-0 w-5 h-5 rounded ${
                    isAIModel ? 'bg-accent-500/20 border-accent-500/45' : 'bg-ink-800 border-ink-700'
                  } border flex items-center justify-center`}>
                    <span className={`text-xs font-bold ${isAIModel ? 'text-accent-400' : 'text-ink-400'}`}>
                      {index + 1}
                    </span>
                  </div>

                  {/* Drag Handle */}
                  <div
                    className="text-ink-500 hover:text-accent-400 transition-colors flex-shrink-0 relative group pointer-events-none"
                    onMouseEnter={() => setHoveredDragHandle(filter.id)}
                    onMouseLeave={() => setHoveredDragHandle(null)}
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>

                  {/* Filter Icon */}
                  {isAIModel && (
                    <Sparkles className="w-4 h-4 text-accent-400 flex-shrink-0" />
                  )}

                  {/* Filter Title - Clickable to expand */}
                  <button
                    onClick={() => filter.enabled && toggleExpanded(filter.id)}
                    disabled={!filter.enabled}
                    className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity disabled:opacity-50 min-w-0"
                  >
                    <span className={`text-[12.5px] font-medium truncate ${isExpanded ? 'text-ink-100' : 'text-ink-200'}`}>
                      {isAIModel
                        ? (availableModels.find(m => m.path === filter.modelPath)?.name || 'Select AI Model')
                        : (filter.preset || 'Custom Filter')
                      }
                    </span>
                    {/* Backend override badge - only when this filter deviates from the app default */}
                    {isAIModel && filter.backend && filter.backend !== 'auto' && (
                      <span
                        className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent-500/20 border border-accent-500/40 text-accent-300"
                        title={`Backend override: ${getBackendDescriptor(filter.backend).label}`}
                      >
                        {getBackendDescriptor(filter.backend).shortLabel}
                      </span>
                    )}
                    {/* Streams override badge */}
                    {isAIModel && filter.numStreams != null && (
                      <span
                        className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent-500/20 border border-accent-500/40 text-accent-300 tabular-nums"
                        title={`num_streams override: ${filter.numStreams}`}
                      >
                        {filter.numStreams}s
                      </span>
                    )}
                    {filter.enabled && (
                      isExpanded 
                        ? <ChevronUp className="w-4 h-4 ml-auto flex-shrink-0 text-ink-400" /> 
                        : <ChevronDown className="w-4 h-4 ml-auto flex-shrink-0 text-ink-400" />
                    )}
                  </button>

                  {/* Enable Checkbox */}
                  <input
                    type="checkbox"
                    checked={filter.enabled}
                    onChange={(e) => handleToggleFilter(filter.id, e.target.checked)}
                    disabled={isProcessing}
                    className={`w-4 h-4 rounded border-ink-600 bg-ink-700 ${
                      isAIModel ? 'focus:ring-accent-500' : 'focus:ring-ink-500'
                    } focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0`}
                    title={filter.enabled ? "Disable filter" : "Enable filter"}
                  />

                  {/* Duplicate Button */}
                  <button
                    onClick={() => handleDuplicateFilter(filter.id)}
                    disabled={isProcessing}
                    className="text-accent-400 hover:text-accent-300 hover:bg-accent-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    title="Duplicate filter"
                  >
                    <Copy className="w-4 h-4" />
                  </button>

                  {/* Remove Button */}
                  <button
                    onClick={() => handleRemoveFilter(filter.id)}
                    disabled={isProcessing}
                    className="text-bad-400 hover:text-bad-300 hover:bg-bad-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    title="Remove filter"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Filter Content - AI Model or Custom */}
                {filter.enabled && isExpanded && (
                  <div className="px-3 pb-2.5 space-y-2.5 border-t border-ink-800 pt-2.5">
                    {isAIModel ? (
                      // AI Model Filter Content
                      <>
                        <div className="space-y-2">
                          {/* Model picker, with import riding the same row — the
                              same shape as the custom branch's template row. */}
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => !isProcessing && setShowModelSelector(filter.id)}
                              disabled={isProcessing}
                              className={`flex-1 min-w-0 h-7 bg-ink-850 border rounded px-2 text-[12.5px] text-left truncate focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                filter.modelPath
                                  ? 'border-accent-500/50 text-ink-200 hover:border-accent-500'
                                  : 'border-ink-600 text-ink-400 hover:border-ink-500'
                              }`}
                            >
                              {filter.modelPath
                                ? (availableModels.find(m => m.path === filter.modelPath)?.name || 'Unknown Model')
                                : 'Select a model...'
                              }
                            </button>
                            {onImportClick && (
                              <button
                                onClick={onImportClick}
                                disabled={isProcessing}
                                title="Import a model from a file"
                                className={`${PICKER_ACTION} text-ink-400 hover:text-accent-400 hover:border-ink-700`}
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          {/* Backend override - 'auto' inherits the app default.
                              Hidden unless enabled in Settings, but always shown
                              when an override is active so it stays clearable. */}
                          {(showBackendOverrides || (filter.backend && filter.backend !== 'auto') || filter.numStreams != null) && (
                          <div className="flex items-center gap-2">
                            <label className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Backend</label>
                            <select
                              value={filter.backend && filter.backend !== 'auto' ? filter.backend : 'auto'}
                              onChange={(e) => handleFilterBackendChange(filter.id, e.target.value as FilterBackend)}
                              disabled={isProcessing}
                              className="flex-1 bg-ink-850 border border-ink-750 rounded h-6 px-1.5 text-[11px] text-ink-300 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="auto">Auto ({getBackendDescriptor(defaultBackend).label})</option>
                              {BACKENDS.map(backend => (
                                <option key={backend.id} value={backend.id}>{backend.label}</option>
                              ))}
                            </select>
                            <label className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Streams</label>
                            <select
                              value={filter.numStreams ?? 'auto'}
                              onChange={(e) => handleFilterStreamsChange(filter.id, e.target.value === 'auto' ? undefined : Number(e.target.value))}
                              disabled={isProcessing}
                              title="Parallel inference streams for this model. Higher can be faster on high-end GPUs; TensorRT backend only."
                              className="w-[76px] flex-shrink-0 bg-ink-850 border border-ink-750 rounded h-6 px-1.5 text-[11px] text-ink-300 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="auto">Auto ({defaultNumStreams})</option>
                              {[1, 2, 3, 4].map(n => (
                                <option key={n} value={n}>{n}</option>
                              ))}
                            </select>
                          </div>
                          )}
                        </div>
                      </>
                    ) : (
                      // Custom Filter Content
                      <>
                        {/* Template picker, with save / import / delete riding the
                            same row. Delete is last and separated by its colour, so
                            it no longer reads as a second "delete this filter"
                            beside the X in the row header. */}
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => setShowFilterSelector(filter.id)}
                            disabled={isProcessing}
                            className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-ink-200 text-left flex items-center justify-between gap-2 hover:border-ink-700"
                          >
                            <span className={`truncate ${filter.preset ? 'text-ink-200' : 'text-ink-500'}`}>
                              {filter.preset || 'Custom - Click to select template'}
                            </span>
                            <LucideFilter className="w-4 h-4 text-ink-400 flex-shrink-0" />
                          </button>
                          {onSaveTemplate && (
                            <>
                              <button
                                onClick={toggleSaveDialog}
                                disabled={isProcessing}
                                title={filter.preset ? `Save changes to “${filter.preset}”, or as a new template` : 'Save this filter as a template'}
                                className={`${PICKER_ACTION} ${
                                  showSaveDialog === filter.id
                                    ? 'text-accent-400 border-accent-500/50 bg-accent-500/15'
                                    : 'text-ink-400 hover:text-accent-400 hover:border-ink-700'
                                }`}
                              >
                                <Save className="w-4 h-4" />
                              </button>
                              <button
                                onClick={handleImportTemplate}
                                disabled={isProcessing}
                                title="Import a template from a file"
                                className={`${PICKER_ACTION} text-ink-400 hover:text-accent-400 hover:border-ink-700`}
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {filter.preset && onDeleteTemplate && (
                            <button
                              onClick={() => handleDeleteTemplate(filter.preset!, filter.id)}
                              disabled={isProcessing}
                              title={`Delete the “${filter.preset}” template`}
                              className={`${PICKER_ACTION} text-bad-400 hover:bg-bad-900/30 hover:border-bad-600`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>

                        {/* A .vkfilter opts into a visual editor with [editor]
                            metadata. The button is intentionally generic here;
                            the preview surface selects the matching editor type. */}
                        {interactiveEditor && onOpenFilterEditor && (
                          <button
                            onClick={() => handleOpenInteractiveEditor(filter, selectedTemplate)}
                            disabled={isProcessing}
                            className="w-full h-7 px-2 rounded inline-flex items-center justify-center gap-1.5 text-[11.5px] font-semibold bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 hover:border-accent-500/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title={interactiveEditor.label
                              || (interactiveEditor.type === 'colorGrade' ? 'Open the grading dock' : 'Open visual crop editor')}
                          >
                            {interactiveEditor.type === 'colorGrade'
                              ? <Palette className="w-3.5 h-3.5" />
                              : <Crop className="w-3.5 h-3.5" />}
                            {interactiveEditor.label
                              || (interactiveEditor.type === 'colorGrade' ? 'Open grade' : 'Edit crop')}
                          </button>
                        )}

                        {/* Template variables are intentionally surfaced in the
                            normal filter panel too: the visual editor is an
                            accelerator, while values remain inspectable and
                            editable in a saved .vkfilter configuration. */}
                        {exposedVariables && Object.keys(exposedVariables).length > 0 && (
                          <div className="grid grid-cols-2 gap-1.5 rounded-md border border-ink-800 bg-ink-950/40 p-2">
                            {Object.entries(exposedVariables).map(([name, variable]) => {
                              const value = filter.parameters?.[name] ?? variable.default ?? '';
                              return (
                                <label key={name} className="min-w-0" title={variable.description}>
                                  <span className="mb-0.5 block truncate text-[10px] font-display font-semibold uppercase tracking-[0.07em] text-ink-500">{name}</span>
                                  {variable.type === 'boolean' ? (
                                    <select
                                      value={value === true ? 'true' : 'false'}
                                      onChange={(event) => handleFilterParameterChange(filter.id, name, event.target.value === 'true')}
                                      disabled={isProcessing}
                                      className="h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] text-ink-200 focus:outline-none focus:border-accent-500 disabled:opacity-50"
                                    >
                                      <option value="true">True</option>
                                      <option value="false">False</option>
                                    </select>
                                  ) : (
                                    <input
                                      type={variable.type === 'number' ? 'number' : 'text'}
                                      value={String(value)}
                                      onChange={(event) => {
                                        const nextValue = variable.type === 'number' ? Number(event.target.value) : event.target.value;
                                        if (variable.type !== 'number' || Number.isFinite(nextValue)) {
                                          handleFilterParameterChange(filter.id, name, nextValue);
                                        }
                                      }}
                                      disabled={isProcessing}
                                      className="h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] tabular-nums text-ink-200 focus:outline-none focus:border-accent-500 disabled:opacity-50"
                                    />
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {/* Save Template Dialog */}
                        {showSaveDialog === filter.id && (
                          <div className="p-2.5 bg-ink-800/70 rounded-md border border-ink-600/60">
                            <h4 className="text-[12px] font-medium mb-2 text-ink-200">Save as Template</h4>
                            <input
                              type="text"
                              placeholder="Template name"
                              value={presetName}
                              onChange={(e) => setPresetName(e.target.value)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full bg-ink-900 border border-ink-600 rounded px-2 py-1 mb-2 text-[12px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-ink-200"
                            />
                            
                            {/* Categories */}
                            <div className="mb-2">
                              {presetCategories.length > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                  {presetCategories.map((cat, index) => (
                                    <span
                                      key={index}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent-600/20 border border-accent-500/50 rounded text-xs text-accent-300"
                                    >
                                      {cat}
                                      <button
                                        onClick={() => setPresetCategories(prev => prev.filter((_, i) => i !== index))}
                                        className="hover:text-bad-400 transition-colors"
                                        type="button"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="flex gap-1">
                                <input
                                  type="text"
                                  placeholder="Add category (press Enter)"
                                  value={newCategoryInput}
                                  onChange={(e) => setNewCategoryInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && newCategoryInput.trim()) {
                                      e.preventDefault();
                                      if (!presetCategories.includes(newCategoryInput.trim())) {
                                        setPresetCategories([...presetCategories, newCategoryInput.trim()]);
                                      }
                                      setNewCategoryInput('');
                                    }
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  list="category-suggestions"
                                  className="flex-1 bg-ink-900 border border-ink-600 rounded px-2 py-1 text-[12px] focus:outline-none focus:border-accent-500 transition-colors text-ink-200"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (newCategoryInput.trim() && !presetCategories.includes(newCategoryInput.trim())) {
                                      setPresetCategories([...presetCategories, newCategoryInput.trim()]);
                                      setNewCategoryInput('');
                                    }
                                  }}
                                  disabled={!newCategoryInput.trim()}
                                  className="px-2 bg-accent-600 hover:bg-accent-700 disabled:bg-ink-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                              </div>
                              <datalist id="category-suggestions">
                                {Object.keys(groupedTemplates).sort().map(category => (
                                  <option key={category} value={category} />
                                ))}
                              </datalist>
                            </div>
                            
                            <input
                              type="text"
                              placeholder="Description (optional)"
                              value={presetDescription}
                              onChange={(e) => setPresetDescription(e.target.value)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full bg-ink-900 border border-ink-600 rounded px-2 py-1 mb-2 text-[12px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-ink-200"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleSaveTemplate(filter.id)}
                                disabled={!presetName.trim()}
                                className="flex-1 bg-accent-600 hover:bg-accent-500 disabled:bg-ink-700 disabled:cursor-not-allowed text-white text-[11.5px] py-1 rounded transition-colors"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => {
                                  setShowSaveDialog(null);
                                  setPresetName('');
                                  setPresetDescription('');
                                  setPresetCategories([]);
                                  setNewCategoryInput('');
                                }}
                                className="flex-1 bg-ink-700 hover:bg-ink-600 text-white text-[11.5px] py-1 rounded transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Description */}
                        {selectedTemplate?.description && (
                          <div className="p-2 bg-ink-900 rounded border border-ink-800">
                            <p className="text-[11.5px] text-ink-400 leading-snug">{selectedTemplate.description}</p>
                          </div>
                        )}

                        {/* Code Editor */}
                        <div className="relative rounded-md overflow-hidden border border-ink-600" onMouseDown={(e) => e.stopPropagation()} style={{ contain: 'layout' }}>
                          <PythonCodeEditor
                            value={pendingFilters.find(f => f.id === filter.id)?.code || ''}
                            onChange={(code) => handleCodeChange(filter.id, code)}
                            onBlur={handleCodeBlur}
                            disabled={isProcessing}
                            placeholder="# Enter custom VapourSynth code here&#10;# Example: clip = core.resize.Bilinear(clip, width=720, height=540)"
                            minHeight="120px"
                            className=""
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
    </Section>

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
