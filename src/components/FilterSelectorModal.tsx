import { memo, useState, useEffect, useMemo } from 'react';
import { Filter as FilterIcon, Plus } from 'lucide-react';
import type { FilterTemplate } from '../electron.d';
import { TemplateEditDialog } from './TemplateEditDialog';
import { PickerChip, PickerModal, PickerRow, PickerSidebarSection } from './PickerModal';
import { groupByCategories, matchesQuery, sortByName } from './pickerFilters';
import { useFavoritesAndRecents } from './useFavoritesAndRecents';
import { ask } from '../utils/dialogs';

interface FilterSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  filterTemplates: FilterTemplate[];
  onSelectTemplate: (templateName: string) => void;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  onEditTemplate?: (oldName: string, template: FilterTemplate) => Promise<boolean>;
  /** Puts back deleted built-in filters; answers the files restored */
  onRestoreTemplates?: () => Promise<string[]>;
  currentSelection?: string;
}

const STORE = {
  favoritesKey: 'vapourkit_favorite_filters',
  recentKey: 'vapourkit_recent_filters',
  field: 'name',
  what: 'filter',
};

/** A template's categories; one without any is Uncategorized. */
function sidebarCategories(template: FilterTemplate): string[] {
  return Array.isArray(template.category)
    ? template.category
    : (template.category ? [template.category] : ['Uncategorized']);
}

export const FilterSelectorModal = memo<FilterSelectorModalProps>(({
  isOpen,
  onClose,
  filterTemplates,
  onSelectTemplate,
  onDeleteTemplate,
  onEditTemplate,
  onRestoreTemplates,
  currentSelection = '',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  // Built-in filters this install deleted. An update never brings them back,
  // so this is the one place to.
  const [missingBuiltIns, setMissingBuiltIns] = useState<string[]>([]);
  const [isRestoring, setIsRestoring] = useState(false);

  useEffect(() => {
    if (!isOpen || !onRestoreTemplates) return;
    let cancelled = false;
    window.electronAPI.getMissingBundledTemplates()
      .then(files => { if (!cancelled) setMissingBuiltIns(files); })
      .catch(() => { if (!cancelled) setMissingBuiltIns([]); });
    return () => { cancelled = true; };
  }, [isOpen, onRestoreTemplates, filterTemplates]);

  const handleRestoreBuiltIns = async () => {
    if (!onRestoreTemplates || isRestoring) return;
    setIsRestoring(true);
    try {
      await onRestoreTemplates();
      setMissingBuiltIns(await window.electronAPI.getMissingBundledTemplates());
    } catch (error) {
      console.error('Failed to restore built-in filters:', error);
    } finally {
      setIsRestoring(false);
    }
  };
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [editingTemplate, setEditingTemplate] = useState<FilterTemplate | null>(null);
  const { favorites, recents, toggleFavorite, addRecent, forget, rename } = useFavoritesAndRecents(STORE);

  // Templates by category; a template is listed under each of its categories.
  const groupedTemplates = useMemo(() => groupByCategories(
    filterTemplates,
    template => sidebarCategories(template).map(category => category || 'Uncategorized'),
    template => template.name,
  ), [filterTemplates]);

  const categories = useMemo(() => {
    return ['All', ...Object.keys(groupedTemplates).sort()];
  }, [groupedTemplates]);

  // Templates in the selected category that match the search, by name
  const filteredTemplates = useMemo(() => {
    let templates = filterTemplates;

    if (selectedCategory !== 'All') {
      templates = templates.filter(t => sidebarCategories(t).includes(selectedCategory));
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      templates = templates.filter(t =>
        matchesQuery(query, t.name, t.description, t.category, t.metadata?.tags)
      );
    }

    return sortByName(templates);
  }, [filterTemplates, selectedCategory, searchQuery]);

  // Recent filters that still exist
  const recentFilterTemplates = useMemo(() => {
    return recents
      .map(entry => filterTemplates.find(t => t.name === entry.key))
      .filter(Boolean) as FilterTemplate[];
  }, [recents, filterTemplates]);

  const favoriteFilterTemplates = useMemo(() => {
    return sortByName(filterTemplates.filter(t => favorites.has(t.name)));
  }, [filterTemplates, favorites]);

  const handleSelectTemplate = (templateName: string) => {
    addRecent(templateName);
    onSelectTemplate(templateName);
    onClose();
  };

  const handleClearSelection = () => {
    onSelectTemplate('');
    onClose();
  };

  const handleDeleteTemplate = async (templateName: string) => {
    if (!onDeleteTemplate) return;

    if (!(await ask({
      title: 'Delete template',
      message: `Delete template "${templateName}"?\n\nThis cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    }))) {
      return;
    }

    if (await onDeleteTemplate(templateName)) forget(templateName);
  };

  const handleSaveEdit = async (updatedTemplate: FilterTemplate): Promise<boolean> => {
    if (!onEditTemplate || !editingTemplate) return false;
    const oldName = editingTemplate.name;
    const success = await onEditTemplate(oldName, updatedTemplate);
    if (success) rename(oldName, updatedTemplate.name);
    return success;
  };

  if (!isOpen) return null;

  const renderTemplate = (template: FilterTemplate) => (
    <FilterItem
      key={template.name}
      template={template}
      isFavorite={favorites.has(template.name)}
      onToggleFavorite={toggleFavorite}
      onSelect={handleSelectTemplate}
      isSelected={currentSelection === template.name}
      onDelete={onDeleteTemplate ? handleDeleteTemplate : undefined}
      onEdit={onEditTemplate ? setEditingTemplate : undefined}
    />
  );

  return (
    <>
      {editingTemplate && (
        <TemplateEditDialog
          template={editingTemplate}
          onSave={handleSaveEdit}
          onClose={() => setEditingTemplate(null)}
        />
      )}

      <PickerModal
        title="Select Filter Template"
        icon={FilterIcon}
        closeLabel="Close filter selector"
        onClose={onClose}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search filters by name, category, or description..."
        sidebar={
          <PickerSidebarSection
            label="Categories"
            options={categories.map(category => ({
              key: category,
              label: category,
              count: category === 'All' ? filterTemplates.length : (groupedTemplates[category]?.length || 0),
            }))}
            selected={selectedCategory}
            onSelect={setSelectedCategory}
          />
        }
        listTop={
          <button
            onClick={() => handleSelectTemplate('')}
            className={`w-full h-9 px-3 border-b border-ink-900 transition-colors flex items-center gap-2 text-[12.5px] font-medium text-left ${
              currentSelection === ''
                ? 'bg-accent-500/15 text-accent-400 shadow-[inset_3px_0_0] shadow-accent-500'
                : 'text-accent-400 hover:bg-ink-900 hover:text-accent-300'
            }`}
            title="Start with a blank filter"
          >
            <Plus className="w-4 h-4" />
            <span>Custom/New Filter</span>
          </button>
        }
        current={currentSelection ? { label: currentSelection, clearLabel: 'Clear (Custom)', onClear: handleClearSelection } : null}
        showPinned={!searchQuery && selectedCategory === 'All'}
        favorites={favoriteFilterTemplates}
        recents={recentFilterTemplates}
        items={filteredTemplates}
        itemsTitle={searchQuery ? 'Search Results' : selectedCategory === 'All' ? 'All Filters' : selectedCategory}
        emptyText="No filters found"
        renderItem={renderTemplate}
        noun="filters"
        favoriteCount={favorites.size}
        footerExtra={missingBuiltIns.length > 0 && (
          <>
            <span>•</span>
            <button
              onClick={handleRestoreBuiltIns}
              disabled={isRestoring}
              title={missingBuiltIns.map(f => f.replace(/\.vkfilter$/, '')).join(', ')}
              className="text-accent-400 hover:text-accent-300 hover:underline disabled:opacity-50"
            >
              {isRestoring
                ? 'Restoring…'
                : `Restore ${missingBuiltIns.length} deleted built-in filter${missingBuiltIns.length === 1 ? '' : 's'}`}
            </button>
          </>
        )}
      />
    </>
  );
});

FilterSelectorModal.displayName = 'FilterSelectorModal';

interface FilterItemProps {
  template: FilterTemplate;
  isFavorite: boolean;
  isSelected: boolean;
  onToggleFavorite: (name: string) => void;
  onSelect: (name: string) => void;
  onDelete?: (name: string) => void;
  onEdit?: (template: FilterTemplate) => void;
}

const FilterItem = memo<FilterItemProps>(({
  template,
  isFavorite,
  isSelected,
  onToggleFavorite,
  onSelect,
  onDelete,
  onEdit,
}) => {
  const categories = Array.isArray(template.category)
    ? template.category
    : (template.category ? [template.category] : []);

  return (
    <PickerRow
      title={template.name}
      badges={
        <>
          {categories.map((cat, index) => (
            <PickerChip key={index}>{cat}</PickerChip>
          ))}
          {template.metadata?.tags?.slice(0, 3).map((tag, i) => (
            <span
              key={i}
              className="inline-flex items-center h-[18px] px-1.5 rounded text-[10px] bg-ink-900 text-ink-500 flex-shrink-0"
            >
              {tag}
            </span>
          ))}
        </>
      }
      description={template.description}
      noun="template"
      isSelected={isSelected}
      isFavorite={isFavorite}
      onSelect={() => onSelect(template.name)}
      onToggleFavorite={() => onToggleFavorite(template.name)}
      onEdit={onEdit && (() => onEdit(template))}
      onDelete={onDelete && (() => onDelete(template.name))}
    />
  );
});

FilterItem.displayName = 'FilterItem';
