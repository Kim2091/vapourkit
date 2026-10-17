import { memo, useState, useMemo } from 'react';
import { Cpu, Download } from 'lucide-react';
import type { BackendId, ModelFile } from '../electron.d';
import { ask } from '../utils/dialogs';
import { getModelDisplayName, filterModels, getPortableModelName } from '../utils/modelUtils';
import { getBackendDescriptor } from '../utils/backends';
import { PickerChip, PickerModal, PickerRow, PickerSidebarSection } from './PickerModal';
import { groupByCategories, matchesQuery, sortByName } from './pickerFilters';
import { useFavoritesAndRecents } from './useFavoritesAndRecents';
import { ModelEditDialog } from './ModelEditDialog';
import { toCategories } from '../utils/categories';

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
  return toCategories(category).filter(c => !BACKEND_LABELS.has(c.toLowerCase()));
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

  // All unique user-defined categories across all models
  const allExistingCategories = useMemo(() => {
    const catSet = new Set<string>();
    availableModels.forEach(m => {
      toCategories(m.category).forEach(c => {
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
          setEditingModel(null);
        }

        await onModelsUpdated?.();
      }
    } catch (error) {
      console.error('Failed to delete model:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {editingModel && (
        <ModelEditDialog
          model={editingModel}
          backendId={backendId}
          categorySuggestions={allExistingCategories}
          onClose={() => setEditingModel(null)}
          onSaved={async () => {
            setEditingModel(null);
            await onModelsUpdated?.();
          }}
          onRenamed={rename}
          onDelete={handleDeleteModel}
        />
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
            onEdit={onEditModel || setEditingModel}
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
