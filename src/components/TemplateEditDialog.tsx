import { memo, useEffect, useState } from 'react';
import { Edit3, X } from 'lucide-react';
import type { FilterTemplate } from '../electron.d';
import { PythonCodeEditor } from './PythonCodeEditor';

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
  const [categories, setCategories] = useState<string[]>(
    Array.isArray(template.category) ? template.category : (template.category ? [template.category] : []),
  );
  const [newCategory, setNewCategory] = useState('');
  const [code, setCode] = useState(template.code);
  const [saving, setSaving] = useState(false);

  // Escape closes this, and only this: captured, so the filter picker it may
  // sit over does not close on the same key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A confirmation open over this one takes the Escape for itself.
      if (event.key !== 'Escape' || document.querySelector('[role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const addCategory = () => {
    const value = newCategory.trim();
    if (value && !categories.includes(value)) setCategories([...categories, value]);
    setNewCategory('');
  };

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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 w-[680px] max-w-[92vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden flex-shrink-0">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Edit3 className="w-4 h-4 text-ink-500" />
            <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 truncate">
              Edit Filter
            </h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

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
              <input
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory();
                  }
                }}
                onBlur={addCategory}
                placeholder="Add a category (Enter)"
                className={INPUT}
              />
            </div>
          </div>
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5 -mt-1">
              {categories.map((category, index) => (
                <span
                  key={category}
                  className="inline-flex items-center gap-1 h-[18px] px-1.5 bg-accent-500/10 border border-accent-500/40 rounded text-accent-300 text-[10px]"
                >
                  {category}
                  <button
                    type="button"
                    onClick={() => setCategories(categories.filter((_, i) => i !== index))}
                    className="hover:text-bad-400 transition-colors"
                    aria-label={`Remove category ${category}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

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
      </div>
    </div>
  );
});
