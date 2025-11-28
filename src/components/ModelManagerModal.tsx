import { useState, useEffect, useMemo } from 'react';
import { X, Edit2, Trash2, Save, XCircle, Sparkles, Search } from 'lucide-react';
import type { ModelFile } from '../electron.d';

interface ModelManagerModalProps {
  isOpen: boolean;
  models: ModelFile[];
  onClose: () => void;
  onModelUpdated: () => void;
}

interface ModelMetadata {
  displayTag?: string;
  description?: string;
  modelType: 'tspan' | 'image';
  useFp32: boolean;
}

export function ModelManagerModal({
  isOpen,
  models,
  onClose,
  onModelUpdated,
}: ModelManagerModalProps) {
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editData, setEditData] = useState<ModelMetadata>({
    displayTag: '',
    description: '',
    modelType: 'tspan',
    useFp32: false,
  });
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Filter models based on search query
  const filteredModels = useMemo(() => {
    if (!searchQuery.trim()) return models;
    const query = searchQuery.toLowerCase();
    return models.filter(model => 
      model.name.toLowerCase().includes(query) ||
      model.path.toLowerCase().includes(query)
    );
  }, [models, searchQuery]);

  // Reset state when modal opens or closes
  useEffect(() => {
    // Reset all state when modal opens to ensure clean state
    setEditingModel(null);
    setIsDeleting(null);
    setSearchQuery('');
  }, [isOpen]);

  if (!isOpen) return null;

  const handleEdit = async (model: ModelFile) => {
    // Load current metadata
    try {
      const metadata = await window.electronAPI.getModelMetadata(model.id);
      setEditData({
        displayTag: metadata?.displayTag || '',
        description: metadata?.description || '',
        modelType: model.modelType || 'tspan',
        useFp32: metadata?.useFp32 || false,
      });
      setEditingModel(model.id);
    } catch (error) {
      console.error('Error loading model metadata:', error);
    }
  };

  const handleSave = async (modelId: string) => {
    setIsSaving(true);
    try {
      const result = await window.electronAPI.updateModelMetadata(modelId, editData);
      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }
      setEditingModel(null);
      onModelUpdated();
    } catch (error) {
      console.error('Error saving model metadata:', error);
      alert('Failed to save model metadata: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (model: ModelFile) => {
    if (!confirm(`Are you sure you want to delete "${model.name}"? This action cannot be undone.`)) {
      return;
    }

    setIsDeleting(model.id);
    try {
      await window.electronAPI.deleteModel(model.path, model.id);
      onModelUpdated();
      setIsDeleting(null);
    } catch (error) {
      console.error('Error deleting model:', error);
      alert('Failed to delete model: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setIsDeleting(null);
    }
  };

  const handleCancel = () => {
    setEditingModel(null);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-xl border border-gray-800 shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary-purple" />
            <h2 className="text-xl font-semibold">Manage Models</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-dark-surface rounded-lg transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Bar */}
        {models.length > 0 && (
          <div className="px-4 pt-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                className="w-full bg-dark-surface border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary-purple transition-colors placeholder-gray-500"
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {models.length === 0 ? (
            <div className="text-center text-gray-400 py-12">
              <Sparkles className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No models found</p>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="text-center text-gray-400 py-12">
              <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No models match your search</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredModels.map((model) => (
                <div
                  key={model.id}
                  className="bg-dark-surface rounded-lg border border-gray-700 p-3"
                >
                  {editingModel === model.id ? (
                    /* Edit Mode */
                    <div className="space-y-2.5">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Model Name</div>
                        <div className="text-sm font-medium">{model.name}</div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-400 mb-1">
                            Display Tag
                          </label>
                          <input
                            type="text"
                            value={editData.displayTag || ''}
                            onChange={(e) =>
                              setEditData({ ...editData, displayTag: e.target.value })
                            }
                            placeholder="e.g., Fast, Best"
                            className="w-full bg-dark-elevated border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary-purple transition-colors"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-gray-400 mb-1">
                            Model Type
                          </label>
                          <select
                            value={editData.modelType}
                            onChange={(e) =>
                              setEditData({
                                ...editData,
                                modelType: e.target.value as 'tspan' | 'image',
                              })
                            }
                            className="w-full bg-dark-elevated border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary-purple transition-colors"
                          >
                            <option value="tspan">Video</option>
                            <option value="image">Image</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          Inference Precision
                        </label>
                        <select
                          value={editData.useFp32 ? 'fp32' : 'fp16'}
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              useFp32: e.target.value === 'fp32',
                            })
                          }
                          className="w-full bg-dark-elevated border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary-purple transition-colors"
                        >
                          <option value="fp16">FP16 (RGB format: RGBH)</option>
                          <option value="fp32">FP32 (RGB format: RGBS)</option>
                        </select>
                        <p className="text-xs text-gray-500 mt-1">
                          {model.backend === 'tensorrt' 
                            ? 'Controls RGB format only (engine precision is baked in)'
                            : 'Controls both DirectML precision and RGB format'}
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          Description
                        </label>
                        <textarea
                          value={editData.description || ''}
                          onChange={(e) =>
                            setEditData({ ...editData, description: e.target.value })
                          }
                          placeholder="Optional description..."
                          rows={2}
                          className="w-full bg-dark-elevated border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary-purple transition-colors resize-none"
                        />
                      </div>

                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => handleSave(model.id)}
                          disabled={isSaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-purple hover:bg-primary-purple/80 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
                        >
                          <Save className="w-3.5 h-3.5" />
                          {isSaving ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={handleCancel}
                          disabled={isSaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-elevated hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed rounded text-sm transition-colors"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View Mode */
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-sm mb-1">{model.name}</h3>
                        <div className="text-xs text-gray-400 space-y-0.5">
                          <div className="truncate">
                            <span className="text-gray-500">Path:</span> {model.path}
                          </div>
                          <div className="flex gap-3">
                            <span>
                              <span className="text-gray-500">Backend:</span>{' '}
                              {model.backend === 'tensorrt' ? 'TensorRT' : 'ONNX'}
                            </span>
                            <span>
                              <span className="text-gray-500">Precision:</span> {model.precision}
                            </span>
                            <span>
                              <span className="text-gray-500">Type:</span>{' '}
                              {model.modelType === 'image' ? 'Image' : 'Video'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEdit(model)}
                          className="p-1.5 hover:bg-dark-elevated rounded transition-colors group"
                          title="Edit model metadata"
                        >
                          <Edit2 className="w-3.5 h-3.5 text-gray-400 group-hover:text-primary-purple" />
                        </button>
                        <button
                          onClick={() => handleDelete(model)}
                          disabled={isDeleting === model.id}
                          className="p-1.5 hover:bg-dark-elevated rounded transition-colors group disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Delete model"
                        >
                          {isDeleting === model.id ? (
                            <div className="w-3.5 h-3.5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5 text-gray-400 group-hover:text-red-500" />
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 p-3">
          <p className="text-xs text-gray-400 text-center">
            {models.length} model{models.length !== 1 ? 's' : ''} available
          </p>
        </div>
      </div>
    </div>
  );
}
