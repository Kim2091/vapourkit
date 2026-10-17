import { useEffect, useState } from 'react';
import { Edit3, Trash2 } from 'lucide-react';
import type { BackendId, ModelFile } from '../electron.d';
import { notify } from '../utils/notifications';
import { BACKENDS, getBackendDescriptor } from '../utils/backends';
import { toCategories } from '../utils/categories';
import { ModalShell } from './ModalShell';
import { CategoryChipsInput } from './CategoryChipsInput';

const LABEL = 'block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1';
const FIELD = 'w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors';

const PRECISION_LABELS = {
  fp16: 'FP16 (RGBH)',
  bf16: 'BF16 (RGBH)',
  fp32: 'FP32 (RGBS)',
} as const;

/** A model's editable metadata. */
export interface ModelMetadataForm {
  name: string;
  displayTag: string;
  description: string;
  categories: string[];
  modelType: 'vsr' | 'image';
  temporalFrames: number | undefined;
  useFp32: boolean;
  useBf16: boolean;
}

/** The form as the model list describes the model, before its metadata loads. */
export function formFromModel(model: ModelFile): ModelMetadataForm {
  return {
    name: model.name,
    displayTag: model.displayTag || '',
    description: model.description || '',
    categories: toCategories(model.category),
    modelType: model.modelType || 'image',
    temporalFrames: undefined,
    useFp32: false,
    useBf16: false,
  };
}

/**
 * The precisions a model file can run at. An engine runs under TensorRT. An
 * ONNX file runs as it is on a backend that loads ONNX directly: the app's
 * backend when it does, else the first one that does.
 */
export function editablePrecisions(model: ModelFile, backendId: BackendId): ReadonlyArray<'fp16' | 'bf16' | 'fp32'> {
  if (model.backend === 'tensorrt') return getBackendDescriptor('tensorrt').importPrecisions;
  const current = getBackendDescriptor(backendId);
  const runner = current.runsOnnxDirectly ? current : BACKENDS.find(backend => backend.runsOnnxDirectly);
  return runner?.importPrecisions ?? ['fp16', 'fp32'];
}

interface ModelEditDialogProps {
  model: ModelFile;
  backendId: BackendId;
  /** Categories other models use, offered while typing. */
  categorySuggestions: string[];
  onClose: () => void;
  /** After the metadata (and name) were saved. */
  onSaved: () => Promise<void> | void;
  /** After a rename moved the model's file. */
  onRenamed: (oldPath: string, newPath: string) => void;
  onDelete: (model: ModelFile) => void;
}

/** Edit a model's name, display tag, type, precision, categories and description. */
export function ModelEditDialog({
  model,
  backendId,
  categorySuggestions,
  onClose,
  onSaved,
  onRenamed,
  onDelete,
}: ModelEditDialogProps) {
  const [form, setForm] = useState<ModelMetadataForm>(() => formFromModel(model));
  const [isSaving, setIsSaving] = useState(false);
  const precisions = editablePrecisions(model, backendId);
  const allowsBf16 = precisions.includes('bf16');

  const update = (patch: Partial<ModelMetadataForm>) => setForm(prev => ({ ...prev, ...patch }));

  // The stored metadata fills in what the model list does not carry.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getModelMetadata(model.metadataId || model.id)
      .then(metadata => {
        if (cancelled || !metadata) return;
        setForm(prev => ({
          ...prev,
          displayTag: metadata.displayTag || model.displayTag || '',
          description: metadata.description || model.description || '',
          categories: toCategories(metadata.category, toCategories(model.category)),
          modelType: metadata.modelType || model.modelType || 'image',
          temporalFrames: metadata.temporalFrames,
          useFp32: metadata.useFp32 || false,
          useBf16: metadata.useBf16 || false,
        }));
      })
      .catch(error => console.error('Failed to load model metadata:', error));
    return () => { cancelled = true; };
  }, [model]);

  const handleSave = async () => {
    try {
      setIsSaving(true);
      let metadataId = model.metadataId || model.id;

      const trimmedName = form.name.trim();
      if (trimmedName && trimmedName !== model.name) {
        try {
          const renameResult = await window.electronAPI.renameModel(model.path, metadataId, trimmedName);
          if (!renameResult.success) {
            notify.error('Rename failed', renameResult.error || 'Failed to rename model');
            setIsSaving(false);
            return;
          }
          if (renameResult.newPath) onRenamed(model.path, renameResult.newPath);
          // The metadata now lives under the new name.
          metadataId = renameResult.newId!;
        } catch (renameError) {
          console.error('Failed to rename model:', renameError);
          notify.error('Rename failed', 'Failed to rename model. Please restart the app and try again.');
          setIsSaving(false);
          return;
        }
      }

      const updates: Record<string, any> = {
        displayTag: form.displayTag.trim() || undefined,
        description: form.description.trim() || undefined,
        category: form.categories.length > 0 ? form.categories : undefined,
        modelType: form.modelType,
        temporalFrames: form.modelType === 'vsr' ? form.temporalFrames : undefined,
        useFp32: form.useFp32,
        useBf16: allowsBf16 ? form.useBf16 : false,
      };

      const result = await window.electronAPI.updateModelMetadata(metadataId, updates);
      if (result.success) await onSaved();
    } catch (error) {
      console.error('Failed to update model metadata:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const precision = form.useFp32 ? 'fp32' : (allowsBf16 && form.useBf16) ? 'bf16' : 'fp16';

  return (
    <ModalShell
      title="Edit Model"
      icon={Edit3}
      onClose={onClose}
      closeLabel="Close edit dialog"
      closeOnBackdrop
      padded={false}
      layer={60}
      className="w-[500px] max-w-[90vw]"
    >
      <div className="p-4 space-y-3">
        <div>
          <label className={LABEL}>
            Model Name
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Model name"
            className={FIELD}
          />
        </div>

        <div>
          <label className={LABEL}>
            Display Tag
          </label>
          <input
            type="text"
            value={form.displayTag}
            onChange={(e) => update({ displayTag: e.target.value })}
            placeholder="Optional display name"
            className={`${FIELD} placeholder-ink-500`}
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={LABEL}>
              Model Type
            </label>
            <select
              value={form.modelType}
              onChange={(e) => update({ modelType: e.target.value as 'vsr' | 'image' })}
              className={FIELD}
            >
              <option value="vsr">Video</option>
              <option value="image">Image</option>
            </select>
          </div>

          <div>
            <label className={LABEL}>
              Inference Precision
            </label>
            <select
              value={precision}
              onChange={(e) => update({ useFp32: e.target.value === 'fp32', useBf16: e.target.value === 'bf16' })}
              className={FIELD}
            >
              {precisions.map(option => (
                <option key={option} value={option}>{PRECISION_LABELS[option]}</option>
              ))}
            </select>
          </div>
        </div>

        {form.modelType === 'vsr' && (
          <div>
            <label className={LABEL}>
              Temporal Frames
            </label>
            <input
              type="number"
              min="1"
              max="99"
              step="2"
              value={form.temporalFrames ?? 5}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                update({ temporalFrames: Number.isNaN(value) ? undefined : value });
              }}
              className={FIELD}
            />
          </div>
        )}

        <div>
          <label className={LABEL}>
            Categories
          </label>
          <CategoryChipsInput
            className="space-y-2"
            categories={form.categories}
            onChange={categories => update({ categories })}
            suggestions={categorySuggestions}
            placeholder="Search or add a category…"
          />
        </div>

        <div>
          <label className={LABEL}>
            Description
          </label>
          <textarea
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="Describe what this model does..."
            rows={3}
            className="w-full bg-ink-850 border border-ink-750 rounded px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500 resize-none"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-800">
        <button
          onClick={() => onDelete(model)}
          disabled={isSaving}
          className="w-8 h-8 rounded-md grid place-items-center border border-bad-500/50 text-bad-400 hover:bg-bad-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          title="Delete model"
          aria-label="Delete model"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving || !form.name.trim()}
          className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
        <button
          onClick={onClose}
          disabled={isSaving}
          className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}
