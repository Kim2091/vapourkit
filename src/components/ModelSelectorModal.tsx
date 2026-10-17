import { memo, useState, useRef, useMemo } from 'react';
import { X, Cpu, Trash2, Edit3, Download } from 'lucide-react';
import type { BackendId, ModelFile } from '../electron.d';
import { ask } from '../utils/dialogs';
import { notify } from '../utils/notifications';
import { getModelDisplayName, filterModels, getPortableModelName } from '../utils/modelUtils';
import { getBackendDescriptor } from '../utils/backends';
import { ModalShell } from './ModalShell';
import { PickerChip, PickerModal, PickerRow, PickerSidebarSection } from './PickerModal';
import { groupByCategories, matchesQuery, sortByName } from './pickerFilters';
import { useFavoritesAndRecents } from './useFavoritesAndRecents';

interface ModelSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableModels: ModelFile[];
  backendId: BackendId;
  onSelectModel: (modelPath: string) => void;
  onEditModel?: (model: ModelFile) => void;
  onImportModel?: () => void;
  onModelsUpdated?: () => Promise<void>;
  currentSelection?: string;
}

const STORE = {
  favoritesKey: 'vapourkit_favorite_models',
  recentKey: 'vapourkit_recent_models',
  field: 'path',
  what: 'model',
};

// Backend labels that should NOT appear as user-facing categories
const BACKEND_LABELS = new Set(['onnx', 'tensorrt', 'trt', 'directml']);

/** Filter out backend labels from a category value */
function filterCategoryBadges(category: string | string[] | undefined): string[] {
  if (!category) return [];
  const cats = Array.isArray(category) ? category : [category];
  return cats.filter(c => !BACKEND_LABELS.has(c.toLowerCase()));
}

const isEngineFile = (modelPath: string): boolean => /\.engine$/i.test(modelPath);

/** The model type label (VSR or Image). */
function getModelType(model: ModelFile): string {
  if (model.modelType === 'vsr') return 'VSR';
  if (model.modelType === 'image') return 'Image';
  return 'Other';
}

export const ModelSelectorModal = memo<ModelSelectorModalProps>(({
  isOpen,
  onClose,
  availableModels,
  backendId,
  onSelectModel,
  onEditModel,
  onImportModel,
  onModelsUpdated,
  currentSelection = '',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedUserCategory, setSelectedUserCategory] = useState<string>('All');
  const [selectedBackend, setSelectedBackend] = useState<'all' | 'tensorrt' | 'onnx'>('all');
  const { favorites, recents, toggleFavorite, addRecent, forget, rename } = useFavoritesAndRecents(STORE);
  const [editingModel, setEditingModel] = useState<ModelFile | null>(null);
  const [editDisplayTag, setEditDisplayTag] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [editModelType, setEditModelType] = useState<'vsr' | 'image'>('image');
  const [editTemporalFrames, setEditTemporalFrames] = useState<number | undefined>(undefined);
  const [editUseFp32, setEditUseFp32] = useState(false);
  const [editUseBf16, setEditUseBf16] = useState(false);
  const [editModelName, setEditModelName] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);

  // All unique user-defined categories across all models
  const allExistingCategories = useMemo(() => {
    const catSet = new Set<string>();
    availableModels.forEach(m => {
      const cats = Array.isArray(m.category) ? m.category : (m.category ? [m.category] : []);
      cats.forEach(c => {
        if (c && !BACKEND_LABELS.has(c.toLowerCase())) catSet.add(c);
      });
    });
    return [...catSet].sort();
  }, [availableModels]);

  // Filter models based on backend setting (ONNX mode hides TensorRT engines, etc.)
  const globalFilteredModels = useMemo(() => filterModels(availableModels, backendId), [availableModels, backendId]);
  const backendFilteredModels = useMemo(() => {
    // Apply the user's local backend filter within the modal
    if (selectedBackend === 'all') return globalFilteredModels;
    if (selectedBackend === 'onnx') {
      // Explicitly hide TensorRT engine files in ONNX view (legacy metadata can label engines as ONNX)
      return globalFilteredModels.filter(m => m.backend === 'onnx' && !isEngineFile(m.path));
    }
    return globalFilteredModels.filter(m => m.backend === selectedBackend);
  }, [globalFilteredModels, selectedBackend]);

  // Backend counts for the filter buttons
  const backendCounts = useMemo(() => ({
    all: globalFilteredModels.length,
    tensorrt: globalFilteredModels.filter(m => m.backend === 'tensorrt').length,
    onnx: globalFilteredModels.filter(m => m.backend === 'onnx' && !isEngineFile(m.path)).length,
  }), [globalFilteredModels]);

  const engineModelsByPortableName = useMemo(() => {
    const map = new Map<string, ModelFile[]>();
    availableModels.forEach(model => {
      const isEngine = model.backend === 'tensorrt' || isEngineFile(model.path);
      if (!isEngine) return;

      const portableName = getPortableModelName(model.path);
      const existing = map.get(portableName) || [];
      existing.push(model);
      map.set(portableName, existing);
    });
    return map;
  }, [availableModels]);

  // Models by model type (VSR / Image)
  const groupedByType = useMemo(() => groupByCategories(
    backendFilteredModels,
    model => [getModelType(model)],
    model => model.path,
  ), [backendFilteredModels]);

  const modelTypes = useMemo(() => {
    return ['All', ...Object.keys(groupedByType).sort()];
  }, [groupedByType]);

  // Models after model-type filter applied
  const typeFilteredModels = useMemo(() => {
    if (selectedCategory === 'All') return backendFilteredModels;
    return backendFilteredModels.filter(m => getModelType(m) === selectedCategory);
  }, [backendFilteredModels, selectedCategory]);

  // Models by user category (independent of model type filter)
  const groupedByUserCategory = useMemo(() => groupByCategories(
    backendFilteredModels,
    model => filterCategoryBadges(model.category),
    model => model.path,
  ), [backendFilteredModels]);

  const userCategories = useMemo(() => {
    return ['All', ...Object.keys(groupedByUserCategory).sort()];
  }, [groupedByUserCategory]);

  // Models of the selected type and category that match the search, by name
  const filteredModels = useMemo(() => {
    let models = typeFilteredModels;

    if (selectedUserCategory !== 'All') {
      models = models.filter(m => filterCategoryBadges(m.category).includes(selectedUserCategory));
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      models = models.filter(m =>
        matchesQuery(query, m.name, m.displayTag, m.description, m.category, m.backend, m.precision, m.modelType)
      );
    }

    return sortByName(models);
  }, [typeFilteredModels, selectedUserCategory, searchQuery]);

  // Recent models that still exist
  const recentModelFiles = useMemo(() => {
    return recents
      .map(entry => backendFilteredModels.find(m => m.path === entry.key))
      .filter(Boolean) as ModelFile[];
  }, [recents, backendFilteredModels]);

  const favoriteModelFiles = useMemo(() => {
    return sortByName(backendFilteredModels.filter(m => favorites.has(m.path)));
  }, [backendFilteredModels, favorites]);

  const handleSelectModel = (modelPath: string) => {
    addRecent(modelPath);
    onSelectModel(modelPath);
    onClose();
  };

  const handleClearSelection = () => {
    onSelectModel('');
    onClose();
  };

  const handleDeleteModel = async (model: ModelFile) => {
    if (!(await ask({
      title: 'Delete model',
      message: `Delete model "${model.name}"?\n\nThis cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    }))) {
      return;
    }

    try {
      const result = await window.electronAPI.deleteModel(model.path, model.metadataId || model.id);
      if (result.success) {
        forget(model.path);

        // If we were editing this model, close the edit dialog
        if (editingModel?.path === model.path) {
          handleCancelEdit();
        }

        await onModelsUpdated?.();
      }
    } catch (error) {
      console.error('Failed to delete model:', error);
    }
  };

  const handleEditModel = async (model: ModelFile) => {
    setEditingModel(model);
    setEditModelName(model.name);
    setEditDisplayTag(model.displayTag || '');
    setEditDescription(model.description || '');
    const cats = Array.isArray(model.category)
      ? model.category
      : (model.category ? [model.category] : []);
    setEditCategories(cats);
    setEditModelType(model.modelType || 'image');
    setEditTemporalFrames(undefined);
    setEditUseFp32(false);
    setEditUseBf16(false);
    setNewCategoryInput('');

    try {
      const metadata = await window.electronAPI.getModelMetadata(model.metadataId || model.id);
      if (metadata) {
        setEditDisplayTag(metadata.displayTag || model.displayTag || '');
        setEditDescription(metadata.description || model.description || '');
        const metadataCats = Array.isArray(metadata.category)
          ? metadata.category
          : (metadata.category ? [metadata.category] : cats);
        setEditCategories(metadataCats);
        setEditModelType(metadata.modelType || model.modelType || 'image');
        setEditTemporalFrames(metadata.temporalFrames);
        setEditUseFp32(metadata.useFp32 || false);
        setEditUseBf16(metadata.useBf16 || false);
      }
    } catch (error) {
      console.error('Failed to load model metadata:', error);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingModel) return;

    try {
      setIsSavingEdit(true);
      let metadataId = editingModel.metadataId || editingModel.id;

      // Handle rename if name changed
      const trimmedName = editModelName.trim();
      if (trimmedName && trimmedName !== editingModel.name) {
        try {
          const renameResult = await window.electronAPI.renameModel(
            editingModel.path,
            metadataId,
            trimmedName
          );
          if (!renameResult.success) {
            notify.error('Rename failed', renameResult.error || 'Failed to rename model');
            setIsSavingEdit(false);
            return;
          }
          if (renameResult.newPath) rename(editingModel.path, renameResult.newPath);
          // Update metadataId to the new name for the metadata update below
          metadataId = renameResult.newId!;
        } catch (renameError) {
          console.error('Failed to rename model:', renameError);
          notify.error('Rename failed', 'Failed to rename model. Please restart the app and try again.');
          setIsSavingEdit(false);
          return;
        }
      }

      const updates: Record<string, any> = {
        displayTag: editDisplayTag.trim() || undefined,
        description: editDescription.trim() || undefined,
        category: editCategories.length > 0 ? editCategories : undefined,
        modelType: editModelType,
        temporalFrames: editModelType === 'vsr' ? editTemporalFrames : undefined,
        useFp32: editUseFp32,
        useBf16: editingModel.backend === 'tensorrt' ? editUseBf16 : false,
      };

      const result = await window.electronAPI.updateModelMetadata(metadataId, updates);
      if (result.success) {
        setEditingModel(null);
        setEditModelName('');
        setEditDisplayTag('');
        setEditDescription('');
        setEditCategories([]);
        setNewCategoryInput('');
        setEditModelType('image');
        setEditTemporalFrames(undefined);
        setEditUseFp32(false);
        setEditUseBf16(false);
        await onModelsUpdated?.();
      }
    } catch (error) {
      console.error('Failed to update model metadata:', error);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingModel(null);
    setEditModelName('');
    setEditDisplayTag('');
    setEditDescription('');
    setEditCategories([]);
    setNewCategoryInput('');
    setEditModelType('image');
    setEditTemporalFrames(undefined);
    setEditUseFp32(false);
    setEditUseBf16(false);
    setIsSavingEdit(false);
    setShowCategoryDropdown(false);
  };

  const handleAddCategory = (cat: string) => {
    const trimmed = cat.trim();
    if (trimmed && !editCategories.includes(trimmed)) {
      setEditCategories(prev => [...prev, trimmed]);
    }
    setNewCategoryInput('');
    setShowCategoryDropdown(false);
    categoryInputRef.current?.focus();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Edit Dialog Overlay */}
      {editingModel && (
        <ModalShell
          title="Edit Model"
          icon={Edit3}
          onClose={handleCancelEdit}
          closeLabel="Close edit dialog"
          closeOnBackdrop
          padded={false}
          layer={60}
          className="w-[500px] max-w-[90vw]"
        >
          <div className="p-4 space-y-3">
            <div>
              <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                Model Name
              </label>
              <input
                type="text"
                value={editModelName}
                onChange={(e) => setEditModelName(e.target.value)}
                placeholder="Model name"
                className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                Display Tag
              </label>
              <input
                type="text"
                value={editDisplayTag}
                onChange={(e) => setEditDisplayTag(e.target.value)}
                placeholder="Optional display name"
                className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                  Model Type
                </label>
                <select
                  value={editModelType}
                  onChange={(e) => setEditModelType(e.target.value as 'vsr' | 'image')}
                  className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors"
                >
                  <option value="vsr">Video</option>
                  <option value="image">Image</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                  Inference Precision
                </label>
                {editingModel.backend === 'tensorrt' ? (
                  <select
                    value={editUseFp32 ? 'fp32' : editUseBf16 ? 'bf16' : 'fp16'}
                    onChange={(e) => {
                      const precision = e.target.value;
                      setEditUseFp32(precision === 'fp32');
                      setEditUseBf16(precision === 'bf16');
                    }}
                    className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors"
                  >
                    <option value="fp16">FP16 (RGBH)</option>
                    <option value="bf16">BF16 (RGBH)</option>
                    <option value="fp32">FP32 (RGBS)</option>
                  </select>
                ) : (
                  <select
                    value={editUseFp32 ? 'fp32' : 'fp16'}
                    onChange={(e) => {
                      setEditUseFp32(e.target.value === 'fp32');
                      setEditUseBf16(false);
                    }}
                    className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors"
                  >
                    <option value="fp16">FP16 (RGBH)</option>
                    <option value="fp32">FP32 (RGBS)</option>
                  </select>
                )}
              </div>
            </div>

            {editModelType === 'vsr' && (
              <div>
                <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                  Temporal Frames
                </label>
                <input
                  type="number"
                  min="1"
                  max="99"
                  step="2"
                  value={editTemporalFrames ?? 5}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10);
                    setEditTemporalFrames(Number.isNaN(value) ? undefined : value);
                  }}
                  className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                Categories
              </label>
              <div className="space-y-2">
                {/* Selected category chips */}
                {editCategories.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {editCategories.map((cat, index) => (
                      <span
                        key={index}
                        className="inline-flex items-center gap-1 h-[18px] px-1.5 bg-accent-500/10 border border-accent-500/40 rounded text-accent-300 text-[10px]"
                      >
                        {cat}
                        <button
                          onClick={() => setEditCategories(prev => prev.filter((_, i) => i !== index))}
                          className="hover:text-bad-400 transition-colors"
                          type="button"
                          aria-label={`Remove category ${cat}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Combobox input */}
                <div className="relative" ref={categoryDropdownRef}>
                  <input
                    ref={categoryInputRef}
                    type="text"
                    value={newCategoryInput}
                    onChange={(e) => {
                      setNewCategoryInput(e.target.value);
                      setShowCategoryDropdown(true);
                    }}
                    onFocus={() => setShowCategoryDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const filtered = allExistingCategories.filter(
                          c => !editCategories.includes(c) &&
                            c.toLowerCase().includes(newCategoryInput.toLowerCase())
                        );
                        // Prefer exact match or first suggestion, else create new
                        const exact = allExistingCategories.find(
                          c => c.toLowerCase() === newCategoryInput.trim().toLowerCase()
                        );
                        if (exact) {
                          handleAddCategory(exact);
                        } else if (newCategoryInput.trim()) {
                          handleAddCategory(newCategoryInput);
                        } else if (filtered.length > 0) {
                          handleAddCategory(filtered[0]);
                        }
                      } else if (e.key === 'Escape' && showCategoryDropdown) {
                        e.stopPropagation();
                        setShowCategoryDropdown(false);
                      }
                    }}
                    onBlur={() => {
                      // Delay so click on a dropdown item registers first
                      setTimeout(() => setShowCategoryDropdown(false), 150);
                    }}
                    placeholder="Search or add a category…"
                    className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
                  />

                  {/* Dropdown */}
                  {showCategoryDropdown && (() => {
                    const suggestions = allExistingCategories.filter(
                      c => !editCategories.includes(c) &&
                        c.toLowerCase().includes(newCategoryInput.toLowerCase())
                    );
                    const canCreate = newCategoryInput.trim() &&
                      !allExistingCategories.some(c => c.toLowerCase() === newCategoryInput.trim().toLowerCase()) &&
                      !editCategories.includes(newCategoryInput.trim());

                    if (suggestions.length === 0 && !canCreate) return null;

                    return (
                      <div className="absolute z-10 top-full mt-1 w-full bg-ink-850 border border-ink-750 rounded-md shadow-xl shadow-black/50 overflow-hidden">
                        {suggestions.length > 0 && (
                          <div className="max-h-40 overflow-y-auto">
                            {suggestions.map(cat => (
                              <button
                                key={cat}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => handleAddCategory(cat)}
                                className="w-full text-left px-2.5 py-1.5 text-[12px] text-ink-200 hover:bg-ink-800 hover:text-ink-100 transition-colors"
                              >
                                {cat}
                              </button>
                            ))}
                          </div>
                        )}
                        {canCreate && (
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleAddCategory(newCategoryInput)}
                            className="w-full text-left px-2.5 py-1.5 text-[12px] text-accent-300 hover:bg-ink-800 transition-colors border-t border-ink-800 flex items-center gap-1.5"
                          >
                            <span className="text-accent-400">+</span> Create &ldquo;{newCategoryInput.trim()}&rdquo;
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
            
            <div>
              <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                Description
              </label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Describe what this model does..."
                rows={3}
                className="w-full bg-ink-850 border border-ink-750 rounded px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500 resize-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-800">
            <button
              onClick={() => {
                if (editingModel) handleDeleteModel(editingModel);
              }}
              disabled={isSavingEdit}
              className="w-8 h-8 rounded-md grid place-items-center border border-bad-500/50 text-bad-400 hover:bg-bad-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              title="Delete model"
              aria-label="Delete model"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleSaveEdit}
              disabled={isSavingEdit || !editModelName.trim()}
              className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSavingEdit ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={handleCancelEdit}
              disabled={isSavingEdit}
              className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </ModalShell>
      )}

      <PickerModal
        title="Select Model"
        icon={Cpu}
        closeLabel="Close model selector"
        onClose={onClose}
        headerActions={onImportModel && (
          <button
            onClick={() => {
              onImportModel();
              onClose();
            }}
            className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Import Model
          </button>
        )}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search models by name, category, type, or description..."
        sidebar={
          <>
            {/* File-kind filter - only for engine-building backends with both kinds present */}
            {getBackendDescriptor(backendId).requiresEngineBuild && backendCounts.tensorrt > 0 && backendCounts.onnx > 0 && (
              <PickerSidebarSection
                label="Backend"
                className="mb-1"
                options={[
                  { key: 'all', label: 'All Backends', count: backendCounts.all },
                  { key: 'tensorrt', label: 'TensorRT', count: backendCounts.tensorrt },
                  { key: 'onnx', label: 'ONNX', count: backendCounts.onnx },
                ].filter(b => b.count > 0)}
                selected={selectedBackend}
                onSelect={key => setSelectedBackend(key as 'all' | 'tensorrt' | 'onnx')}
              />
            )}
            <PickerSidebarSection
              label="Model Type"
              className="mb-1"
              options={modelTypes.map(type => ({
                key: type,
                label: type,
                count: type === 'All' ? backendFilteredModels.length : (groupedByType[type]?.length || 0),
              }))}
              selected={selectedCategory}
              onSelect={setSelectedCategory}
            />
            <PickerSidebarSection
              label="Categories"
              options={userCategories.map(cat => ({
                key: cat,
                label: cat,
                count: cat === 'All'
                  ? typeFilteredModels.length
                  : typeFilteredModels.filter(model => filterCategoryBadges(model.category).includes(cat)).length,
              }))}
              selected={selectedUserCategory}
              onSelect={setSelectedUserCategory}
            />
          </>
        }
        current={currentSelection ? {
          label: availableModels.find(m => m.path === currentSelection)?.name || currentSelection,
          clearLabel: 'Clear Selection',
          onClear: handleClearSelection,
        } : null}
        showPinned={!searchQuery && selectedCategory === 'All'}
        favorites={favoriteModelFiles}
        recents={recentModelFiles}
        items={filteredModels}
        itemsTitle={searchQuery ? 'Search Results' : selectedCategory === 'All' ? 'All Models' : selectedCategory}
        emptyText="No models found"
        emptyExtra={!searchQuery && onImportModel && (
          <button
            onClick={() => {
              onImportModel();
              onClose();
            }}
            className="mt-3 h-8 px-3 rounded-md inline-flex items-center gap-2 text-[12.5px] font-semibold bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 transition-colors"
          >
            <Download className="w-4 h-4" />
            Import a Model
          </button>
        )}
        renderItem={model => (
          <ModelItem
            key={model.path}
            model={model}
            matchingEngineModels={model.backend === 'onnx' ? (engineModelsByPortableName.get(getPortableModelName(model.path)) || []) : []}
            backendId={backendId}
            isFavorite={favorites.has(model.path)}
            onToggleFavorite={toggleFavorite}
            onSelect={handleSelectModel}
            isSelected={currentSelection === model.path}
            onDelete={handleDeleteModel}
            onEdit={onEditModel || handleEditModel}
          />
        )}
        noun="models"
        favoriteCount={favorites.size}
      />
    </>
  );
});

ModelSelectorModal.displayName = 'ModelSelectorModal';

interface ModelItemProps {
  model: ModelFile;
  matchingEngineModels: ModelFile[];
  backendId: BackendId;
  isFavorite: boolean;
  isSelected: boolean;
  onToggleFavorite: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete?: (model: ModelFile) => void;
  onEdit?: (model: ModelFile) => void;
}

const ModelItem = memo<ModelItemProps>(({
  model,
  matchingEngineModels,
  backendId,
  isFavorite,
  isSelected,
  onToggleFavorite,
  onSelect,
  onDelete,
  onEdit,
}) => {
  const [showMatchingEngines, setShowMatchingEngines] = useState(false);
  const hasMatchingEngines = matchingEngineModels.length > 0;
  const displayName = getModelDisplayName(model, backendId);
  const isUnbuilt = displayName.startsWith('[Unbuilt] ') && !hasMatchingEngines;
  const cleanDisplayName = displayName.startsWith('[Unbuilt] ') ? displayName.replace(/^\[Unbuilt\]\s+/, '') : displayName;
  const userCategoryBadges = filterCategoryBadges(model.category);

  return (
    <PickerRow
      title={cleanDisplayName}
      badges={
        <>
          {isUnbuilt && (
            <span className="inline-flex items-center h-[18px] px-1.5 rounded border border-bad-500/40 bg-bad-500/10 text-bad-400 text-[10px] flex-shrink-0">
              Unbuilt
            </span>
          )}
          <span className={`inline-flex items-center h-[18px] px-1.5 rounded border text-[10px] flex-shrink-0 ${
            model.backend === 'tensorrt'
              ? 'border-ok-700/50 bg-ok-900/40 text-ok-400'
              : 'border-ink-750 bg-ink-850 text-ink-300'
          }`}>
            {model.backend === 'tensorrt' ? 'TensorRT' : 'ONNX'}
          </span>
          {model.modelType && (
            <PickerChip className="text-ink-300">
              {model.modelType === 'vsr' ? 'VSR' : 'Image'}
            </PickerChip>
          )}
          <PickerChip className="font-mono text-ink-400">
            {model.precision}
          </PickerChip>
          {userCategoryBadges.map((cat, index) => (
            <PickerChip key={index}>{cat}</PickerChip>
          ))}

          {model.backend === 'onnx' && hasMatchingEngines && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMatchingEngines(prev => !prev);
              }}
              className={`inline-flex items-center h-[18px] px-1.5 rounded border text-[10px] flex-shrink-0 transition-colors ${
                showMatchingEngines
                  ? 'bg-ink-800 text-ink-200 border-ink-700'
                  : 'bg-ink-850 text-ink-400 border-ink-750 hover:border-ink-700 hover:text-ink-300'
              }`}
              title="Show matching built TensorRT engines"
            >
              Engines {matchingEngineModels.length}
            </button>
          )}
        </>
      }
      description={model.description}
      details={model.backend === 'onnx' && showMatchingEngines && hasMatchingEngines && (
        <div className="mt-1.5 mb-0.5 pl-2 border-l-2 border-ink-800">
          <div className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-0.5">Built engines</div>
          <div className="space-y-0.5">
            {matchingEngineModels.map(engine => (
              <div
                key={engine.path}
                className="text-[10.5px] font-mono text-ink-400 truncate"
                title={engine.path}
              >
                {engine.name}
              </div>
            ))}
          </div>
        </div>
      )}
      noun="model"
      isSelected={isSelected}
      isFavorite={isFavorite}
      onSelect={() => onSelect(model.path)}
      onToggleFavorite={() => onToggleFavorite(model.path)}
      onEdit={onEdit && (() => onEdit(model))}
      onDelete={onDelete && (() => onDelete(model))}
    />
  );
});

ModelItem.displayName = 'ModelItem';
