import { useState } from 'react';
import type { FilterTemplate } from '../electron.d';
import { toCategories } from '../utils/categories';
import { CategoryChipsInput } from './CategoryChipsInput';

const FIELD = 'w-full bg-ink-900 border border-ink-600 rounded px-2 py-1 mb-2 text-[12px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-ink-200';

export interface SaveTemplateFields {
  name: string;
  description: string;
  categories: string[];
}

interface SaveTemplateFormProps {
  /** The template the step uses, whose name, description and categories the form starts from. */
  existing?: FilterTemplate;
  /** Every category the templates use, offered while typing. */
  categorySuggestions: string[];
  onSave: (fields: SaveTemplateFields) => void;
  onCancel: () => void;
}

/** A step card's Save as Template form. */
export function SaveTemplateForm({ existing, categorySuggestions, onSave, onCancel }: SaveTemplateFormProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [categories, setCategories] = useState<string[]>(() => toCategories(existing?.category));

  return (
    <div className="p-2.5 bg-ink-800/70 rounded-md border border-ink-600/60">
      <h4 className="text-[12px] font-medium mb-2 text-ink-200">Save as Template</h4>
      <input
        type="text"
        placeholder="Template name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        className={FIELD}
      />

      <CategoryChipsInput
        className="mb-2"
        variant="compact"
        categories={categories}
        onChange={setCategories}
        suggestions={categorySuggestions}
        placeholder="Add category (press Enter)"
      />

      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onMouseDown={(e) => e.stopPropagation()}
        className={FIELD}
      />
      <div className="flex gap-2">
        <button
          onClick={() => onSave({ name, description, categories })}
          disabled={!name.trim()}
          className="flex-1 bg-accent-600 hover:bg-accent-500 disabled:bg-ink-700 disabled:cursor-not-allowed text-white text-[11.5px] py-1 rounded transition-colors"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="flex-1 bg-ink-700 hover:bg-ink-600 text-white text-[11.5px] py-1 rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
