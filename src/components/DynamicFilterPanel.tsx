import { useState, useEffect, useRef } from 'react';
import { GripVertical, X, Plus, ChevronDown, ChevronUp, Save, Trash2, Download, Filter as LucideFilter, Info, Sparkles, ToggleLeft, ToggleRight, Copy, ChevronsDownUp, ChevronsUpDown, Settings } from 'lucide-react';
import type { Filter, FilterTemplate, ModelFile } from '../electron.d';
import { getModelDisplayName } from '../utils/modelUtils';
import { PythonCodeEditor } from './PythonCodeEditor';

interface DynamicFilterPanelProps {
  title?: string;
  filters: Filter[];
  filterTemplates: FilterTemplate[];
  isProcessing: boolean;
  availableModels?: ModelFile[];
  useDirectML?: boolean;
  onFiltersChange: (filters: Filter[]) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  onDragStart?: (filterId: string) => void;
  onDragEnd?: () => void;
  onDrop?: (targetId: string | null) => void;
  draggedFilterId?: string | null;
  onImportClick?: () => void;
  onManageModels?: () => void;
}

export function DynamicFilterPanel({
  title = 'Filters',
  filters,
  filterTemplates,
  isProcessing,
  availableModels = [],
  useDirectML = false,
  onFiltersChange,
  onSaveTemplate,
  onDeleteTemplate,
  onDragStart,
  onDragEnd,
  onDrop,
  draggedFilterId,
  onImportClick,
  onManageModels,
}: DynamicFilterPanelProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [expandedFilters, setExpandedFilters] = useState<Set<string>>(new Set());
  const [showSaveDialog, setShowSaveDialog] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [hoveredDragHandle, setHoveredDragHandle] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [newlyDuplicatedId, setNewlyDuplicatedId] = useState<string | null>(null);
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
    
    // If processing just stopped, ensure all textareas are properly interactive
    if (wasProcessing && !isProcessing) {
      // Force a small delay to ensure disabled attributes are removed
      const timeoutId = setTimeout(() => {
        // Find all textareas in expanded filters and reset their state if focused
        const textareas = document.querySelectorAll<HTMLTextAreaElement>('textarea[data-filter-textarea]');
        textareas.forEach(textarea => {
          if (document.activeElement === textarea && !textarea.disabled) {
            // Blur and refocus to reset the textarea state
            textarea.blur();
            textarea.focus();
          }
        });
      }, 0);
      
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
      f.id === id ? { ...f, preset, code: templateObj?.code || '' } : f
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
        description: presetDescription.trim() || undefined,
      });
      if (success) {
        setPresetName('');
        setPresetDescription('');
        setShowSaveDialog(null);
      }
    }
  };

  const handleImportTemplate = async () => {
    try {
      const filePath = await window.electronAPI.selectTemplateFile();
      if (!filePath) return;

      const result = await window.electronAPI.readTemplateFile(filePath);
      if (!result.success || !result.content) {
        alert(`Failed to read template file: ${result.error || 'Unknown error'}`);
        return;
      }

      const template = JSON.parse(result.content) as FilterTemplate;
      
      if (!template.name || !template.code) {
        alert('Invalid template format. Must include "name" and "code" fields.');
        return;
      }
      
      if (onSaveTemplate) {
        await onSaveTemplate(template);
      }
    } catch (err) {
      alert('Failed to import template. Please check the file format.');
      console.error('Import error:', err);
    }
  };

  const handleDeleteTemplate = async (name: string, filterId: string) => {
    if (onDeleteTemplate && confirm(`Delete template "${name}"?`)) {
      await onDeleteTemplate(name);
      // Reset selection if deleted template was selected
      const filter = pendingFilters.find(f => f.id === filterId);
      if (filter?.preset === name) {
        handlePresetChange(filterId, '');
      }
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
    <div className="bg-gray-900/50 rounded-lg border border-gray-700/70 p-3">
      <div className="space-y-2.5">
        {/* Header with Add Filter Button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-gray-300">{title}</h3>
            <div className="relative group">
              <Info className="w-4 h-4 text-gray-500 hover:text-blue-400 transition-colors cursor-help" />
              <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 w-64 bg-gray-950 border border-gray-700 rounded-lg p-3 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-[100] shadow-xl">
                <p className="text-xs text-gray-300 mb-2 font-medium">Tips:</p>
                <ul className="list-disc list-inside space-y-1 text-xs text-gray-400">
                  <li>Use <code className="bg-gray-900 px-1 rounded text-blue-400">clip</code> variable for the video stream</li>
                  <li>Use <code className="bg-gray-900 px-1 rounded text-blue-400">original_clip</code> variable to reference the original/input video stream</li>
                  <li>Filters are applied in the order shown (top to bottom)</li>
                  <li>Add AI models anywhere in the filter workflow</li>
                </ul>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Toggle All Filters Button */}
            {pendingFilters.length > 0 && (
              <>
                <button
                  onClick={handleToggleAllFilters}
                  disabled={isProcessing}
                  className="py-1 px-2.5 bg-gray-700/50 border border-gray-600 rounded-md hover:bg-gray-700 hover:border-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-gray-300"
                  title={pendingFilters.every(f => f.enabled) ? "Disable all filters" : "Enable all filters"}
                >
                  {pendingFilters.every(f => f.enabled) ? (
                    <>
                      <ToggleRight className="w-3.5 h-3.5 text-green-400" />
                      <span className="text-xs font-medium">Disable All</span>
                    </>
                  ) : (
                    <>
                      <ToggleLeft className="w-3.5 h-3.5 text-gray-400" />
                      <span className="text-xs font-medium">Enable All</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleToggleAllExpanded}
                  disabled={isProcessing}
                  className="py-1 px-2.5 bg-gray-700/50 border border-gray-600 rounded-md hover:bg-gray-700 hover:border-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-gray-300"
                  title={pendingFilters.every(f => expandedFilters.has(f.id)) ? "Collapse all filters" : "Expand all filters"}
                >
                  {pendingFilters.every(f => expandedFilters.has(f.id)) ? (
                    <>
                      <ChevronsUpDown className="w-3.5 h-3.5 text-blue-400" />
                      <span className="text-xs font-medium">Collapse All</span>
                    </>
                  ) : (
                    <>
                      <ChevronsDownUp className="w-3.5 h-3.5 text-gray-400" />
                      <span className="text-xs font-medium">Expand All</span>
                    </>
                  )}
                </button>
              </>
            )}
            {/* Add Filter Button */}
            <div className="relative">
              <button
                onClick={() => setShowAddMenu(!showAddMenu)}
                disabled={isProcessing}
                className="py-1 px-2.5 bg-blue-500/15 border border-blue-500/40 rounded-md hover:bg-blue-500/25 hover:border-blue-500/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-blue-400"
                title="Add filter"
              >
                <Plus className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">Add Filter</span>
              </button>
              {showAddMenu && (
                <div className="absolute right-0 top-full mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[160px]">
                  <button
                    onClick={handleAddAIModelFilter}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-800 transition-colors flex items-center gap-2 text-gray-200 border-b border-gray-700"
                  >
                    <Sparkles className="w-4 h-4 text-purple-400" />
                    AI Model
                  </button>
                  <button
                    onClick={handleAddCustomFilter}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-gray-800 transition-colors flex items-center gap-2 text-gray-200"
                  >
                    <LucideFilter className="w-4 h-4 text-blue-400" />
                    VS Filter
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Empty State with Drop Zone */}
        {pendingFilters.length === 0 && (
          <div 
            className="bg-gray-800/30 border border-dashed border-gray-600/60 rounded-lg p-6 text-center transition-colors hover:border-blue-500/40"
            onDrop={handleEmptyDrop}
            onDragOver={handleEmptyDragOver}
          >
            <LucideFilter className="w-10 h-10 text-gray-600 mx-auto mb-2" />
            <p className="text-gray-400 text-sm mb-1">No filters added yet</p>
            <p className="text-gray-500 text-xs">Click "+ Add Filter" to get started</p>
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

          return (
            <div
              key={filter.id}
              onDragOver={(e) => handleDragOver(e, filter.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, filter.id)}
              className={`relative ${
                isDragging ? 'opacity-40 scale-95' : 'opacity-100 scale-100'
              } ${
                isHovered && !isDragging ? 'scale-[1.01] transition-transform duration-200' : ''
              } ${
                !isDragging ? 'transition-opacity duration-200' : ''
              } ${
                isNewlyDuplicated ? 'animate-[highlight_0.33s_ease-in-out] bg-blue-500/20 border-blue-500/50 border-2 shadow-lg shadow-blue-500/50 transition-all duration-200' : ''
              }`}
            >
              {/* Drop indicator */}
              {dragOverId === filter.id && !isDragging && (
                <div className="absolute -top-1.5 left-0 right-0 h-0.5 bg-blue-500 rounded-full shadow-lg shadow-blue-500/50 z-10" />
              )}

              <div className={`bg-gray-800/60 rounded-lg border ${
                filter.enabled 
                  ? isAIModel ? 'border-purple-500/60' : 'border-gray-600/80'
                  : 'border-gray-700/50 opacity-60'
              } ${
                isHovered && !isDragging ? 'border-blue-500/50 shadow-blue-500/10 transition-all duration-200' : ''
              }`}>
                {/* Filter Header */}
                <div 
                  draggable={!isProcessing}
                  onDragStart={(e) => handleDragStart(e, filter.id)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center gap-2.5 px-3 py-2 bg-gray-700/40 cursor-grab active:cursor-grabbing ${
                    isExpanded ? 'sticky top-0 z-10 rounded-t-lg' : ''
                  }`}
                >
                  {/* Filter Order Number */}
                  <div className={`flex-shrink-0 w-5 h-5 rounded ${
                    isAIModel ? 'bg-purple-500/20 border-purple-500/50' : 'bg-blue-500/20 border-blue-500/50'
                  } border flex items-center justify-center`}>
                    <span className={`text-xs font-bold ${isAIModel ? 'text-purple-400' : 'text-blue-400'}`}>
                      {index + 1}
                    </span>
                  </div>

                  {/* Drag Handle */}
                  <div
                    className="text-gray-500 hover:text-blue-400 transition-colors flex-shrink-0 relative group pointer-events-none"
                    onMouseEnter={() => setHoveredDragHandle(filter.id)}
                    onMouseLeave={() => setHoveredDragHandle(null)}
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>

                  {/* Filter Icon */}
                  {isAIModel && (
                    <Sparkles className="w-4 h-4 text-purple-400 flex-shrink-0" />
                  )}

                  {/* Filter Title - Clickable to expand */}
                  <button
                    onClick={() => filter.enabled && toggleExpanded(filter.id)}
                    disabled={!filter.enabled}
                    className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity disabled:opacity-50 min-w-0"
                  >
                    <span className="text-sm font-medium truncate text-gray-200">
                      {isAIModel 
                        ? (availableModels.find(m => m.path === filter.modelPath)?.name || 'Select AI Model')
                        : (filter.preset || 'Custom Filter')
                      }
                    </span>
                    {filter.enabled && (
                      isExpanded 
                        ? <ChevronUp className="w-4 h-4 ml-auto flex-shrink-0 text-gray-400" /> 
                        : <ChevronDown className="w-4 h-4 ml-auto flex-shrink-0 text-gray-400" />
                    )}
                  </button>

                  {/* Enable Checkbox */}
                  <input
                    type="checkbox"
                    checked={filter.enabled}
                    onChange={(e) => handleToggleFilter(filter.id, e.target.checked)}
                    disabled={isProcessing}
                    className={`w-4 h-4 rounded border-gray-600 bg-gray-700 ${
                      isAIModel ? 'text-purple-500 focus:ring-purple-500' : 'text-blue-500 focus:ring-blue-500'
                    } focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0`}
                    title={filter.enabled ? "Disable filter" : "Enable filter"}
                  />

                  {/* Duplicate Button */}
                  <button
                    onClick={() => handleDuplicateFilter(filter.id)}
                    disabled={isProcessing}
                    className="text-blue-400 hover:text-blue-300 hover:bg-blue-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    title="Duplicate filter"
                  >
                    <Copy className="w-4 h-4" />
                  </button>

                  {/* Remove Button */}
                  <button
                    onClick={() => handleRemoveFilter(filter.id)}
                    disabled={isProcessing}
                    className="text-red-400 hover:text-red-300 hover:bg-red-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    title="Remove filter"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Filter Content - AI Model or Custom */}
                {filter.enabled && isExpanded && (
                  <div className="px-3 pb-2.5 space-y-2.5 border-t border-gray-600/50 pt-2.5 bg-gray-750/30">
                    {isAIModel ? (
                      // AI Model Filter Content
                      <>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <label className="text-sm text-gray-300 font-medium">Model Selection</label>
                            <div className="flex items-center gap-3">
                              {onImportClick && (
                                <button
                                  onClick={onImportClick}
                                  className="text-sm text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                                  disabled={isProcessing}
                                >
                                  <Download className="w-3 h-3" />
                                  Import Model
                                </button>
                              )}
                              {onManageModels && (
                                <button
                                  onClick={onManageModels}
                                  className="text-sm text-gray-400 hover:text-gray-300 transition-colors flex items-center gap-1"
                                  disabled={isProcessing}
                                >
                                  <Settings className="w-3 h-3" />
                                  Manage Models
                                </button>
                              )}
                            </div>
                          </div>
                          <select
                            value={filter.modelPath || ''}
                            onChange={(e) => handleModelChange(filter.id, e.target.value)}
                            disabled={isProcessing}
                            className="w-full bg-gray-900/90 border border-gray-600 rounded-md px-2.5 py-1.5 text-base focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-gray-200"
                          >
                            <option value="">Select a model...</option>
                            {!useDirectML && (() => {
                              const engineModels = availableModels.filter(m => m.backend === 'tensorrt');
                              const onnxModels = availableModels.filter(m => m.backend === 'onnx');
                              
                              return (
                                <>
                                  {engineModels.length > 0 && (
                                    <optgroup label="━━━ TensorRT Engines ━━━">
                                      {engineModels.map((model) => (
                                        <option key={model.path} value={model.path}>
                                          {getModelDisplayName(model, useDirectML, true)}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {onnxModels.length > 0 && (
                                    <optgroup label="━━━ ONNX Models ━━━">
                                      {onnxModels.map((model) => (
                                        <option key={model.path} value={model.path}>
                                          {getModelDisplayName(model, useDirectML, true)}
                                        </option>
                                      ))}
                                    </optgroup>
                                  )}
                                </>
                              );
                            })()}
                            {useDirectML && availableModels.map((model) => (
                              <option key={model.path} value={model.path}>
                                {getModelDisplayName(model, useDirectML, true)}
                              </option>
                            ))}
                          </select>
                        </div>
                      </>
                    ) : (
                      // Custom Filter Content
                      <>
                        {/* Save and Import Template Buttons */}
                        {onSaveTemplate && (
                          <div className="flex gap-3 pt-1">
                            <button
                              onClick={() => setShowSaveDialog(showSaveDialog === filter.id ? null : filter.id)}
                              className="text-sm text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                              disabled={isProcessing}
                            >
                              <Save className="w-3 h-3" />
                              Save Template
                            </button>
                            <button
                              onClick={handleImportTemplate}
                              className="text-sm text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1"
                              disabled={isProcessing}
                            >
                              <Download className="w-3 h-3" />
                              Import Template
                            </button>
                          </div>
                        )}

                        {/* Save Template Dialog */}
                        {showSaveDialog === filter.id && (
                          <div className="p-2.5 bg-gray-800/70 rounded-md border border-gray-600/60">
                            <h4 className="text-sm font-medium mb-2 text-gray-200">Save as Template</h4>
                            <input
                              type="text"
                              placeholder="Template name"
                              value={presetName}
                              onChange={(e) => setPresetName(e.target.value)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 mb-2 text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-gray-200"
                            />
                            <input
                              type="text"
                              placeholder="Description (optional)"
                              value={presetDescription}
                              onChange={(e) => setPresetDescription(e.target.value)}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 mb-2 text-sm focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-gray-200"
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleSaveTemplate(filter.id)}
                                disabled={!presetName.trim()}
                                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm py-1.5 rounded transition-colors"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setShowSaveDialog(null)}
                                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm py-1.5 rounded transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Template Dropdown with Delete */}
                        <div className="flex gap-2">
                          <select
                            value={filter.preset}
                            onChange={(e) => handlePresetChange(filter.id, e.target.value)}
                            disabled={isProcessing}
                            className="flex-1 bg-gray-900/90 border border-gray-600 rounded-md px-2.5 py-1.5 text-base focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-gray-200"
                          >
                            <option value="">Custom</option>
                            {filterTemplates.map((template) => (
                              <option key={template.name} value={template.name}>
                                {template.name}
                              </option>
                            ))}
                          </select>
                          {filter.preset && onDeleteTemplate && (
                            <button
                              onClick={() => handleDeleteTemplate(filter.preset, filter.id)}
                              disabled={isProcessing}
                              className="px-2.5 bg-gray-900/90 border border-gray-600 rounded-md hover:bg-red-900/30 hover:border-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Delete template"
                            >
                              <Trash2 className="w-4 h-4 text-red-400" />
                            </button>
                          )}
                        </div>

                        {/* Description */}
                        {selectedTemplate?.description && (
                          <div className="p-2.5 bg-gray-900 rounded-md border border-gray-600">
                            <p className="text-sm text-gray-200 font-medium">{selectedTemplate.description}</p>
                          </div>
                        )}

                        {/* Code Editor */}
                        <div className="relative rounded-md overflow-hidden border border-gray-600" onMouseDown={(e) => e.stopPropagation()}>
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
      </div>
    </div>
  );
}
