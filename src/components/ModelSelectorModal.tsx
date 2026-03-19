import { memo, useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, Star, Clock, Cpu, ChevronRight, Trash2, Edit3, Download } from 'lucide-react';
import type { ModelFile } from '../electron.d';
import { getModelDisplayName, filterModels, getPortableModelName } from '../utils/modelUtils';

interface ModelSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableModels: ModelFile[];
  useDirectML: boolean;
  onSelectModel: (modelPath: string) => void;
  onEditModel?: (model: ModelFile) => void;
  onImportModel?: () => void;
  onModelsUpdated?: () => Promise<void>;
  currentSelection?: string;
}

interface RecentModel {
  path: string;
  lastUsed: number;
}

function normalizeRecentModels(value: unknown): RecentModel[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: RecentModel[] = [];

  value.forEach(item => {
    const path = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string'
          ? (item as { path: string }).path
          : '');

    if (!path || seen.has(path)) return;

    const lastUsed = item && typeof item === 'object' && typeof (item as { lastUsed?: unknown }).lastUsed === 'number'
      ? (item as { lastUsed: number }).lastUsed
      : 0;

    normalized.push({ path, lastUsed });
    seen.add(path);
  });

  return normalized
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RECENT);
}

const STORAGE_KEY_RECENT = 'vapourkit_recent_models';
const STORAGE_KEY_FAVORITES = 'vapourkit_favorite_models';
const MAX_RECENT = 10;

// Backend labels that should NOT appear as user-facing categories
const BACKEND_LABELS = new Set(['onnx', 'tensorrt', 'trt', 'directml']);

/** Filter out backend labels from a category value */
function filterCategoryBadges(category: string | string[] | undefined): string[] {
  if (!category) return [];
  const cats = Array.isArray(category) ? category : [category];
  return cats.filter(c => !BACKEND_LABELS.has(c.toLowerCase()));
}

export const ModelSelectorModal = memo<ModelSelectorModalProps>(({
  isOpen,
  onClose,
  availableModels,
  useDirectML,
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
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recentModels, setRecentModels] = useState<RecentModel[]>([]);
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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

  const isEngineFile = (modelPath: string): boolean => /\.engine$/i.test(modelPath);

  // Filter models based on backend setting (ONNX mode hides TensorRT engines, etc.)
  const globalFilteredModels = useMemo(() => filterModels(availableModels, useDirectML), [availableModels, useDirectML]);
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

  // Load favorites and recent from localStorage
  useEffect(() => {
    try {
      const storedFavorites = localStorage.getItem(STORAGE_KEY_FAVORITES);
      if (storedFavorites) {
        setFavorites(new Set(JSON.parse(storedFavorites)));
      }
      const storedRecent = localStorage.getItem(STORAGE_KEY_RECENT);
      if (storedRecent) {
        const normalized = normalizeRecentModels(JSON.parse(storedRecent));
        setRecentModels(normalized);
        localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(normalized));
      }
    } catch (error) {
      console.error('Failed to load model preferences:', error);
    }
  }, []);

  // Focus search input when modal opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Helper: get the model type label (VSR or Image)
  const getModelType = (model: ModelFile): string => {
    if (model.modelType === 'vsr') return 'VSR';
    if (model.modelType === 'image') return 'Image';
    return 'Other';
  };

  // Helper: get user-defined categories from model metadata
  const getModelUserCategories = (model: ModelFile): string[] => {
    const cats = filterCategoryBadges(model.category);
    return cats.length > 0 ? cats : [];
  };

  // Group models by model type (VSR / Image)
  const groupedByType = useMemo(() => {
    return backendFilteredModels.reduce((acc, model) => {
      const type = getModelType(model);
      if (!acc[type]) acc[type] = [];
      if (!acc[type].find(m => m.path === model.path)) acc[type].push(model);
      return acc;
    }, {} as Record<string, ModelFile[]>);
  }, [backendFilteredModels]);

  const modelTypes = useMemo(() => {
    return ['All', ...Object.keys(groupedByType).sort()];
  }, [groupedByType]);

  // Models after model-type filter applied
  const typeFilteredModels = useMemo(() => {
    if (selectedCategory === 'All') return backendFilteredModels;
    return backendFilteredModels.filter(m => getModelType(m) === selectedCategory);
  }, [backendFilteredModels, selectedCategory]);

  // Group backend-filtered models by user category (independent of model type filter)
  const groupedByUserCategory = useMemo(() => {
    return backendFilteredModels.reduce((acc, model) => {
      const cats = getModelUserCategories(model);
      cats.forEach(cat => {
        if (!acc[cat]) acc[cat] = [];
        if (!acc[cat].find(m => m.path === model.path)) acc[cat].push(model);
      });
      return acc;
    }, {} as Record<string, ModelFile[]>);
  }, [backendFilteredModels]);

  const userCategories = useMemo(() => {
    return ['All', ...Object.keys(groupedByUserCategory).sort()];
  }, [groupedByUserCategory]);

  // Filter models based on search, model type, and user category
  const filteredModels = useMemo(() => {
    let models = typeFilteredModels;

    // Filter by user category (second tier)
    if (selectedUserCategory !== 'All') {
      models = models.filter(m => getModelUserCategories(m).includes(selectedUserCategory));
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const categoryMatches = (cat: string | string[] | undefined) => {
        if (!cat) return false;
        if (Array.isArray(cat)) return cat.some(c => c.toLowerCase().includes(query));
        return cat.toLowerCase().includes(query);
      };
      
      models = models.filter(m => 
        m.name.toLowerCase().includes(query) ||
        (m.displayTag?.toLowerCase().includes(query)) ||
        (m.description?.toLowerCase().includes(query)) ||
        categoryMatches(m.category) ||
        m.backend.toLowerCase().includes(query) ||
        m.precision.toLowerCase().includes(query) ||
        (m.modelType?.toLowerCase().includes(query))
      );
    }

    // Sort alphabetically
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }, [typeFilteredModels, selectedUserCategory, searchQuery]);

  // Get recent models that still exist
  const recentModelFiles = useMemo(() => {
    return recentModels
      .map(rm => backendFilteredModels.find(m => m.path === rm.path))
      .filter(Boolean) as ModelFile[];
  }, [recentModels, backendFilteredModels]);

  // Get favorite model files
  const favoriteModelFiles = useMemo(() => {
    return backendFilteredModels
      .filter(m => favorites.has(m.path))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [backendFilteredModels, favorites]);

  const toggleFavorite = (modelPath: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(modelPath)) {
        next.delete(modelPath);
      } else {
        next.add(modelPath);
      }
      try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...next]));
      } catch (error) {
        console.error('Failed to save favorites:', error);
      }
      return next;
    });
  };

  const addToRecent = (modelPath: string) => {
    setRecentModels(prev => {
      const filtered = prev.filter(rm => rm.path !== modelPath);
      const updated = [{ path: modelPath, lastUsed: Date.now() }, ...filtered];
      const trimmed = updated.slice(0, MAX_RECENT);
      try {
        localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(trimmed));
      } catch (error) {
        console.error('Failed to save recent models:', error);
      }
      return trimmed;
    });
  };

  const handleSelectModel = (modelPath: string) => {
    addToRecent(modelPath);
    onSelectModel(modelPath);
    onClose();
  };

  const handleClearSelection = () => {
    onSelectModel('');
    onClose();
  };

  const handleDeleteModel = async (model: ModelFile) => {
    if (!confirm(`Delete model "${model.name}"?\n\nThis action cannot be undone.`)) {
      return;
    }

    try {
      const result = await window.electronAPI.deleteModel(model.path, model.metadataId || model.id);
      if (result.success) {
        setFavorites(prev => {
          const next = new Set(prev);
          next.delete(model.path);
          try {
            localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...next]));
          } catch (error) {
            console.error('Failed to update favorites:', error);
          }
          return next;
        });

        setRecentModels(prev => {
          const filtered = prev.filter(rm => rm.path !== model.path);
          try {
            localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(filtered));
          } catch (error) {
            console.error('Failed to update recent models:', error);
          }
          return filtered;
        });

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
            alert(renameResult.error || 'Failed to rename model');
            setIsSavingEdit(false);
            return;
          }
          // Update metadataId to the new name for the metadata update below
          metadataId = renameResult.newId!;
        } catch (renameError) {
          console.error('Failed to rename model:', renameError);
          alert('Failed to rename model. Please restart the app and try again.');
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
        <div 
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={handleCancelEdit}
        >
          <div 
            className="bg-dark-elevated rounded-xl shadow-2xl w-[500px] max-w-[90vw] border border-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-purple-300" />
                <h3 className="text-xl font-semibold">Edit Model</h3>
              </div>
              <button
                onClick={handleCancelEdit}
                className="p-2 hover:bg-dark-surface rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-300">
                  Model Name
                </label>
                <input
                  type="text"
                  value={editModelName}
                  onChange={(e) => setEditModelName(e.target.value)}
                  placeholder="Model name"
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-300">
                  Display Tag
                </label>
                <input
                  type="text"
                  value={editDisplayTag}
                  onChange={(e) => setEditDisplayTag(e.target.value)}
                  placeholder="Optional display name"
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors placeholder-gray-500"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-300">
                    Model Type
                  </label>
                  <select
                    value={editModelType}
                    onChange={(e) => setEditModelType(e.target.value as 'vsr' | 'image')}
                    className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors"
                  >
                    <option value="vsr">Video</option>
                    <option value="image">Image</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-300">
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
                      className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors"
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
                      className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors"
                    >
                      <option value="fp16">FP16 (RGBH)</option>
                      <option value="fp32">FP32 (RGBS)</option>
                    </select>
                  )}
                </div>
              </div>

              {editModelType === 'vsr' && (
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-gray-300">
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
                    className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-300">
                  Categories
                </label>
                <div className="space-y-2">
                  {/* Selected category chips */}
                  {editCategories.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {editCategories.map((cat, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-purple-500/10 border border-purple-400/35 rounded-lg text-purple-300 text-sm"
                        >
                          {cat}
                          <button
                            onClick={() => setEditCategories(prev => prev.filter((_, i) => i !== index))}
                            className="hover:text-red-400 transition-colors ml-0.5"
                            type="button"
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
                        } else if (e.key === 'Escape') {
                          setShowCategoryDropdown(false);
                        }
                      }}
                      onBlur={() => {
                        // Delay so click on a dropdown item registers first
                        setTimeout(() => setShowCategoryDropdown(false), 150);
                      }}
                      placeholder="Search or add a category…"
                      className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors placeholder-gray-500 text-sm"
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
                        <div className="absolute z-10 top-full mt-1 w-full bg-dark-elevated border border-gray-700 rounded-lg shadow-xl overflow-hidden">
                          {suggestions.length > 0 && (
                            <div className="max-h-40 overflow-y-auto">
                              {suggestions.map(cat => (
                                <button
                                  key={cat}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => handleAddCategory(cat)}
                                  className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-purple-500/20 hover:text-purple-200 transition-colors"
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
                              className="w-full text-left px-3 py-2 text-sm text-purple-300 hover:bg-purple-500/20 transition-colors border-t border-gray-700 flex items-center gap-2"
                            >
                              <span className="text-purple-400">+</span> Create &ldquo;{newCategoryInput.trim()}&rdquo;
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-300">
                  Description
                </label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Describe what this model does..."
                  rows={3}
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-purple-300 transition-colors placeholder-gray-500 resize-none"
                />
              </div>
            </div>
            
            <div className="flex items-center gap-2 p-4 border-t border-gray-800 bg-dark-surface">
              <button
                onClick={() => {
                  if (editingModel) handleDeleteModel(editingModel);
                }}
                disabled={isSavingEdit}
                className="p-2 rounded-lg transition-colors text-gray-500 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Delete model"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={isSavingEdit || !editModelName.trim()}
                className="flex-1 bg-purple-500/65 hover:bg-purple-500/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm py-2 rounded-lg transition-colors font-medium"
              >
                {isSavingEdit ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                onClick={handleCancelEdit}
                disabled={isSavingEdit}
                className="flex-1 bg-dark-surface hover:bg-dark-bg disabled:opacity-50 disabled:cursor-not-allowed border border-gray-700 text-white text-sm py-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Modal */}
      <div 
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div 
          ref={modalRef}
          className="bg-dark-elevated rounded-xl shadow-2xl w-[90vw] max-w-5xl h-[80vh] max-h-[800px] flex flex-col border border-gray-800"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <Cpu className="w-5 h-5 text-purple-300" />
              <h2 className="text-xl font-semibold">Select Model</h2>
            </div>
            <div className="flex items-center gap-2">
              {onImportModel && (
                <button
                  onClick={() => {
                    onImportModel();
                    onClose();
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-400/25 text-purple-300 text-sm rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Import Model
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 hover:bg-dark-surface rounded-lg transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="p-4 border-b border-gray-800">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models by name, category, type, or description..."
                className="w-full bg-dark-surface border border-gray-700 rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:border-purple-300 transition-colors placeholder-gray-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-dark-surface rounded transition-colors"
                >
                  <X className="w-4 h-4 text-gray-400" />
                </button>
              )}
            </div>
          </div>

          {/* Main Content */}
          <div className="flex flex-1 overflow-hidden">
            {/* Category Sidebar */}
            <div className="w-56 border-r border-gray-800 overflow-y-auto bg-dark-surface">
              <div className="p-3">
                {/* Backend Filter - only show when multiple backends are available */}
                {!useDirectML && backendCounts.tensorrt > 0 && backendCounts.onnx > 0 && (
                  <>
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                      Backend
                    </div>
                    <div className="space-y-0.5 mb-4">
                      {([
                        { key: 'all' as const, label: 'All Backends', count: backendCounts.all },
                        { key: 'tensorrt' as const, label: 'TensorRT', count: backendCounts.tensorrt },
                        { key: 'onnx' as const, label: 'ONNX', count: backendCounts.onnx },
                      ]).filter(b => b.count > 0).map(backend => (
                        <button
                          key={backend.key}
                          onClick={() => setSelectedBackend(backend.key)}
                          className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between group ${
                            selectedBackend === backend.key
                              ? 'bg-purple-500/65 text-white'
                              : 'text-gray-300 hover:bg-dark-elevated hover:text-white'
                          }`}
                        >
                          <span className="truncate">{backend.label}</span>
                          <span className={`text-xs ${
                            selectedBackend === backend.key
                              ? 'text-purple-200'
                              : 'text-gray-500 group-hover:text-gray-400'
                          }`}>
                            {backend.count}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Model Type
                </div>
                <div className="space-y-0.5 mb-4">
                  {modelTypes.map(type => {
                    const count = type === 'All'
                      ? backendFilteredModels.length
                      : (groupedByType[type]?.length || 0);
                    return (
                      <button
                        key={type}
                        onClick={() => setSelectedCategory(type)}
                        className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between group ${
                          selectedCategory === type
                            ? 'bg-purple-500/65 text-white'
                            : 'text-gray-300 hover:bg-dark-elevated hover:text-white'
                        }`}
                      >
                        <span className="truncate">{type}</span>
                        <span className={`text-xs ${
                          selectedCategory === type
                            ? 'text-purple-200'
                            : 'text-gray-500 group-hover:text-gray-400'
                        }`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Categories
                </div>
                <div className="space-y-0.5">
                  {userCategories.map(cat => {
                    const count = cat === 'All'
                      ? typeFilteredModels.length
                      : typeFilteredModels.filter(model => getModelUserCategories(model).includes(cat)).length;
                    return (
                      <button
                        key={cat}
                        onClick={() => setSelectedUserCategory(cat)}
                        className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between group ${
                          selectedUserCategory === cat
                            ? 'bg-purple-500/65 text-white'
                            : 'text-gray-300 hover:bg-dark-elevated hover:text-white'
                        }`}
                      >
                        <span className="truncate">{cat}</span>
                        <span className={`text-xs ${
                          selectedUserCategory === cat
                            ? 'text-purple-200'
                            : 'text-gray-500 group-hover:text-gray-400'
                        }`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Model List */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* Current Selection */}
              {currentSelection && (
                <div className="mb-4 p-3 bg-dark-surface border border-purple-400/35 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Current Selection</div>
                      <div className="font-medium text-purple-300">
                        {availableModels.find(m => m.path === currentSelection)?.name || currentSelection}
                      </div>
                    </div>
                    <button
                      onClick={handleClearSelection}
                      className="px-3 py-1.5 bg-dark-elevated hover:bg-dark-bg border border-gray-700 text-white text-xs rounded-lg transition-colors"
                    >
                      Clear Selection
                    </button>
                  </div>
                </div>
              )}

              {/* Favorites Section */}
              {!searchQuery && selectedCategory === 'All' && favoriteModelFiles.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                    <h3 className="font-semibold text-gray-200">Favorites</h3>
                    <span className="text-sm text-gray-500">({favoriteModelFiles.length})</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {favoriteModelFiles.map(model => (
                      <ModelItem
                        key={model.path}
                        model={model}
                        matchingEngineModels={model.backend === 'onnx' ? (engineModelsByPortableName.get(getPortableModelName(model.path)) || []) : []}
                        useDirectML={useDirectML}
                        isFavorite={true}
                        onToggleFavorite={toggleFavorite}
                        onSelect={handleSelectModel}
                        isSelected={currentSelection === model.path}
                        onDelete={handleDeleteModel}
                        onEdit={onEditModel || handleEditModel}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Recent Section */}
              {!searchQuery && selectedCategory === 'All' && recentModelFiles.length > 0 && (
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Clock className="w-4 h-4 text-purple-300" />
                    <h3 className="font-semibold text-gray-200">Recent</h3>
                    <span className="text-sm text-gray-500">({recentModelFiles.length})</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {recentModelFiles.map(model => (
                      <ModelItem
                        key={model.path}
                        model={model}
                        matchingEngineModels={model.backend === 'onnx' ? (engineModelsByPortableName.get(getPortableModelName(model.path)) || []) : []}
                        useDirectML={useDirectML}
                        isFavorite={favorites.has(model.path)}
                        onToggleFavorite={toggleFavorite}
                        onSelect={handleSelectModel}
                        isSelected={currentSelection === model.path}
                        onDelete={handleDeleteModel}
                        onEdit={onEditModel || handleEditModel}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* All Models / Search Results */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Cpu className="w-4 h-4 text-gray-400" />
                  <h3 className="font-semibold text-gray-200">
                    {searchQuery ? 'Search Results' : selectedCategory === 'All' ? 'All Models' : selectedCategory}
                  </h3>
                  <span className="text-sm text-gray-500">({filteredModels.length})</span>
                </div>
                {filteredModels.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <Cpu className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No models found</p>
                    {searchQuery && (
                      <p className="text-sm mt-1">Try adjusting your search query</p>
                    )}
                    {!searchQuery && onImportModel && (
                      <button
                        onClick={() => {
                          onImportModel();
                          onClose();
                        }}
                        className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-400/25 text-purple-300 text-sm rounded-lg transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        Import a Model
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2">
                    {filteredModels.map(model => (
                      <ModelItem
                        key={model.path}
                        model={model}
                        matchingEngineModels={model.backend === 'onnx' ? (engineModelsByPortableName.get(getPortableModelName(model.path)) || []) : []}
                        useDirectML={useDirectML}
                        isFavorite={favorites.has(model.path)}
                        onToggleFavorite={toggleFavorite}
                        onSelect={handleSelectModel}
                        isSelected={currentSelection === model.path}
                        onDelete={handleDeleteModel}
                        onEdit={onEditModel || handleEditModel}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-gray-800 px-4 py-3 bg-dark-surface">
            <div className="flex items-center justify-between text-sm text-gray-400">
              <div className="flex items-center gap-4">
                <span>{filteredModels.length} models shown</span>
                <span>•</span>
                <span>{favorites.size} favorites</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="px-2 py-0.5 bg-dark-elevated border border-gray-700 rounded text-gray-300">Esc</kbd>
                <span>to close</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

ModelSelectorModal.displayName = 'ModelSelectorModal';

// Model Item Component
interface ModelItemProps {
  model: ModelFile;
  matchingEngineModels: ModelFile[];
  useDirectML: boolean;
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
  useDirectML,
  isFavorite,
  isSelected,
  onToggleFavorite,
  onSelect,
  onDelete,
  onEdit,
}) => {
  const [showMatchingEngines, setShowMatchingEngines] = useState(false);
  const hasMatchingEngines = matchingEngineModels.length > 0;
  const displayName = getModelDisplayName(model, useDirectML);
  const isUnbuilt = displayName.startsWith('[Unbuilt] ') && !hasMatchingEngines;
  const cleanDisplayName = displayName.startsWith('[Unbuilt] ') ? displayName.replace(/^\[Unbuilt\]\s+/, '') : displayName;
  const userCategoryBadges = filterCategoryBadges(model.category);

  return (
    <div
      className={`group relative p-3 rounded-lg border transition-all cursor-pointer ${
        isSelected
          ? 'bg-purple-500/10 border-purple-400/60'
          : 'bg-dark-surface border-gray-700 hover:border-gray-600 hover:bg-dark-elevated'
      }`}
      onClick={() => onSelect(model.path)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 mb-2">
            <h4 className={`font-medium leading-6 min-w-0 break-words ${
              isSelected ? 'text-purple-300' : 'text-white'
            }`}>
              {cleanDisplayName}
            </h4>
            <div className="flex items-center gap-1 flex-shrink-0">
              {onEdit && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(model);
                  }}
                  className="p-1.5 rounded-lg transition-all text-gray-600 hover:text-purple-300 hover:bg-dark-elevated"
                  title="Edit model"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(model);
                  }}
                  className="p-1.5 rounded-lg transition-all text-gray-600 hover:text-red-400 hover:bg-dark-elevated"
                  title="Delete model"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(model.path);
                }}
                className={`p-1.5 rounded-lg transition-all ${
                  isFavorite
                    ? 'text-yellow-400 hover:text-yellow-500'
                    : 'text-gray-600 hover:text-yellow-400'
                }`}
                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star className={`w-4 h-4 ${isFavorite ? 'fill-yellow-400' : ''}`} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {isUnbuilt && (
              <span className="text-xs px-2 py-0.5 rounded border flex-shrink-0 bg-red-900/40 text-red-300 border-red-700/50">
                Unbuilt
              </span>
            )}
            <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
              model.backend === 'tensorrt'
                ? 'bg-green-900/50 text-green-400 border border-green-700/50'
                : 'bg-blue-900/50 text-blue-400 border border-blue-700/50'
            }`}>
              {model.backend === 'tensorrt' ? 'TensorRT' : 'ONNX'}
            </span>
            {model.modelType && (
              <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                model.modelType === 'vsr'
                  ? 'bg-amber-900/50 text-amber-400 border border-amber-700/50'
                  : 'bg-indigo-900/50 text-indigo-400 border border-indigo-700/50'
              }`}>
                {model.modelType === 'vsr' ? 'VSR' : 'Image'}
              </span>
            )}

            <span className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded flex-shrink-0">
              {model.precision}
            </span>
            {userCategoryBadges.map((cat, index) => (
              <span key={index} className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded flex-shrink-0">
                {cat}
              </span>
            ))}

            <div className="ml-auto min-w-[84px] flex justify-end">
              {model.backend === 'onnx' && hasMatchingEngines && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMatchingEngines(prev => !prev);
                  }}
                  className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                    showMatchingEngines
                      ? 'bg-dark-elevated text-gray-200 border-gray-600'
                      : 'bg-dark-bg text-gray-400 border-gray-700 hover:border-gray-600 hover:text-gray-300'
                  }`}
                  title="Show matching built TensorRT engines"
                >
                  Engines {matchingEngineModels.length}
                </button>
              )}
            </div>
          </div>
          {model.description && (
            <p className="text-sm text-gray-400 line-clamp-2">
              {model.description}
            </p>
          )}
          {model.backend === 'onnx' && showMatchingEngines && hasMatchingEngines && (
            <div className="mt-2 bg-dark-bg border border-gray-700 rounded-lg p-2">
              <div className="text-xs text-gray-400 mb-1">Built engines</div>
              <div className="space-y-1">
                {matchingEngineModels.map(engine => (
                  <div
                    key={engine.path}
                    className="text-xs text-gray-300 truncate"
                    title={engine.path}
                  >
                    {engine.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2">
          <ChevronRight className="w-4 h-4 text-purple-300" />
        </div>
      )}
    </div>
  );
});

ModelItem.displayName = 'ModelItem';
