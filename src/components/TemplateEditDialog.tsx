import { memo, useState } from 'react';
import { Edit3 } from 'lucide-react';
import type { FilterTemplate } from '../electron.d';
import { PythonCodeEditor } from './PythonCodeEditor';
import { ModalShell } from './ModalShell';
import { CategoryChips, CategoryInput } from './CategoryChipsInput';
import { toCategories } from '../utils/categories';

interface TemplateEditDialogProps {
  template: FilterTemplate;
  /** Resolves true once saved; the dialog closes then. */
  onSave: (updated: FilterTemplate) => Promise<boolean>;
  onClose: () => void;
}

const LABEL = 'block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1';
const INPUT = 'w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500';

/**
 * Edit a filter template in place: its name, categories, description and
 * code. Saving keeps the one template (renamed if the name changed) rather
 * than the delete-and-import, or import-a-copy, that this used to take.
 */
export const TemplateEditDialog = memo<TemplateEditDialogProps>(({ template, onSave, onClose }) => {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description || '');
  const [categories, setCategories] = useState<string[]>(toCategories(template.category));
  const [code, setCode] = useState(template.code);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await onSave({
        ...template,
        name: name.trim(),
        description: description.trim() || undefined,
        category: categories.length > 0 ? categories : undefined,
        code,
      });
      if (saved) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title="Edit Filter"
      icon={Edit3}
      onClose={onClose}
      closeOnBackdrop
      layer={60}
      className="w-[680px] max-w-[92vw] max-h-[88vh] flex flex-col"
    >
      <div className="p-4 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Name <span className="text-bad-400">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Filter name"
              className={INPUT}
              autoFocus
            />
          </div>
          <div>
            <label className={LABEL}>Categories</label>
            <CategoryInput
              categories={categories}
              onChange={setCategories}
              placeholder="Add a category (Enter)"
              addOnBlur
            />
          </div>
        </div>
        <CategoryChips categories={categories} onChange={setCategories} className="-mt-1" />

        <div>
          <label className={LABEL}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this filter does"
            rows={2}
            className="w-full bg-ink-850 border border-ink-750 rounded px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500 resize-none"
          />
        </div>

        <div>
          <label className={LABEL}>Code</label>
          <PythonCodeEditor value={code} onChange={setCode} minHeight="220px" />
          <p className="text-[10.5px] text-ink-500 mt-1.5">
            Steps already using this filter that you have not changed get the new code; steps you have edited keep theirs.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-800 flex-shrink-0">
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save Changes
        </button>
        <button
          onClick={onClose}
          className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
});
