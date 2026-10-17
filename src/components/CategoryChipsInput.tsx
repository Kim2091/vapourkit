import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

/**
 * `dialog` is the look of the edit dialogs: small accent chips and a h-7
 * field. `compact` is the look of a step card's Save as Template form.
 */
export type CategoryChipsVariant = 'dialog' | 'compact';

const CHIP: Record<CategoryChipsVariant, string> = {
  dialog: 'inline-flex items-center gap-1 h-[18px] px-1.5 bg-accent-500/10 border border-accent-500/40 rounded text-accent-300 text-[10px]',
  compact: 'inline-flex items-center gap-1 px-2 py-0.5 bg-accent-600/20 border border-accent-500/50 rounded text-xs text-accent-300',
};
const CHIP_ROW: Record<CategoryChipsVariant, string> = {
  dialog: 'flex flex-wrap gap-1.5',
  compact: 'flex flex-wrap gap-1 mb-2',
};
const INPUT: Record<CategoryChipsVariant, string> = {
  dialog: 'w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500',
  compact: 'flex-1 bg-ink-900 border border-ink-600 rounded px-2 py-1 text-[12px] focus:outline-none focus:border-accent-500 transition-colors text-ink-200',
};

/** `categories` plus `value`, trimmed, unless it is empty or already there. */
export function addCategory(categories: string[], value: string): string[] {
  const trimmed = value.trim();
  return trimmed && !categories.includes(trimmed) ? [...categories, trimmed] : categories;
}

/**
 * What Enter adds from a suggestion field: the suggestion the text names
 * (ignoring case), else the text itself, else the first suggestion still
 * offered. Undefined when there is nothing to add.
 */
export function categoryForEnter(text: string, categories: string[], suggestions: string[]): string | undefined {
  const query = text.trim().toLowerCase();
  const exact = suggestions.find(c => c.toLowerCase() === query);
  if (exact) return exact;
  if (text.trim()) return text;
  return suggestions.find(c => !categories.includes(c) && c.toLowerCase().includes(text.toLowerCase()));
}

/** The chosen categories as removable chips; nothing when there are none. */
export function CategoryChips({ categories, onChange, variant = 'dialog', className = '' }: {
  categories: string[];
  onChange: (categories: string[]) => void;
  variant?: CategoryChipsVariant;
  className?: string;
}) {
  if (categories.length === 0) return null;
  return (
    <div className={className ? `${CHIP_ROW[variant]} ${className}` : CHIP_ROW[variant]}>
      {categories.map((category, index) => (
        <span key={`${index}:${category}`} className={CHIP[variant]}>
          {category}
          <button
            type="button"
            onClick={() => onChange(categories.filter((_, i) => i !== index))}
            className="hover:text-bad-400 transition-colors"
            aria-label={`Remove category ${category}`}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

interface CategoryInputProps {
  categories: string[];
  onChange: (categories: string[]) => void;
  /** Existing categories to offer while typing. */
  suggestions?: string[];
  variant?: CategoryChipsVariant;
  placeholder: string;
  /** Adds what was typed when the field loses focus. */
  addOnBlur?: boolean;
}

/**
 * The field that adds a category. In the dialog look, suggestions open a
 * list under the field that also offers to create what was typed; in the
 * compact look they are the browser's own list, and a + button adds.
 */
export function CategoryInput({
  categories,
  onChange,
  suggestions,
  variant = 'dialog',
  placeholder,
  addOnBlur = false,
}: CategoryInputProps) {
  const [text, setText] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const combobox = variant === 'dialog' && !!suggestions;

  const add = (value: string) => {
    onChange(addCategory(categories, value));
    setText('');
  };

  if (variant === 'compact') {
    return (
      <>
        <div className="flex gap-1">
          <input
            type="text"
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                e.preventDefault();
                add(text);
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
            list={suggestions ? 'category-suggestions' : undefined}
            className={INPUT.compact}
          />
          <button
            type="button"
            onClick={() => add(text)}
            disabled={!text.trim()}
            className="px-2 bg-accent-600 hover:bg-accent-700 disabled:bg-ink-700 disabled:cursor-not-allowed text-white text-xs rounded transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {suggestions && (
          <datalist id="category-suggestions">
            {suggestions.map(category => (
              <option key={category} value={category} />
            ))}
          </datalist>
        )}
      </>
    );
  }

  if (!combobox) {
    return (
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          }
        }}
        onBlur={addOnBlur ? () => add(text) : undefined}
        placeholder={placeholder}
        className={INPUT.dialog}
      />
    );
  }

  const pick = (value: string) => {
    add(value);
    setShowDropdown(false);
    inputRef.current?.focus();
  };
  const offered = suggestions.filter(
    c => !categories.includes(c) && c.toLowerCase().includes(text.toLowerCase())
  );
  const canCreate = !!text.trim() &&
    !suggestions.some(c => c.toLowerCase() === text.trim().toLowerCase()) &&
    !categories.includes(text.trim());
  const listOpen = showDropdown && (offered.length > 0 || canCreate);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={listOpen}
        aria-autocomplete="list"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const chosen = categoryForEnter(text, categories, suggestions);
            if (chosen !== undefined) pick(chosen);
          } else if (e.key === 'Escape' && listOpen) {
            // Closes the list, not the dialog around it.
            e.stopPropagation();
            setShowDropdown(false);
          }
        }}
        onBlur={() => {
          // Delay so click on a dropdown item registers first
          setTimeout(() => setShowDropdown(false), 150);
        }}
        placeholder={placeholder}
        className={INPUT.dialog}
      />

      {listOpen && (
        <div className="absolute z-10 top-full mt-1 w-full bg-ink-850 border border-ink-750 rounded-md shadow-xl shadow-black/50 overflow-hidden">
          {offered.length > 0 && (
            <div className="max-h-40 overflow-y-auto">
              {offered.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(cat)}
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
              onClick={() => pick(text)}
              className="w-full text-left px-2.5 py-1.5 text-[12px] text-accent-300 hover:bg-ink-800 transition-colors border-t border-ink-800 flex items-center gap-1.5"
            >
              <span className="text-accent-400">+</span> Create &ldquo;{text.trim()}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Chips above the field that adds to them. */
export function CategoryChipsInput(props: CategoryInputProps & { className?: string }) {
  const { categories, onChange, variant = 'dialog', className } = props;
  return (
    <div className={className}>
      <CategoryChips categories={categories} onChange={onChange} variant={variant} />
      <CategoryInput {...props} />
    </div>
  );
}
