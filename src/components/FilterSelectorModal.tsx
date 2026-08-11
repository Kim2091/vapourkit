import { memo, useState, useEffect, useRef, useMemo } from 'react';
import { Search, X, Star, Clock, Filter as FilterIcon, ChevronRight, Trash2, Edit3, Plus } from 'lucide-react';
import type { FilterTemplate } from '../electron.d';

interface FilterSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  filterTemplates: FilterTemplate[];
  onSelectTemplate: (templateName: string) => void;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
  onEditTemplate?: (oldName: string, template: FilterTemplate) => Promise<boolean>;
  currentSelection?: string;
}

interface RecentFilter {
  name: string;
  lastUsed: number;
}

function normalizeRecentFilters(value: unknown): RecentFilter[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: RecentFilter[] = [];

  value.forEach(item => {
    const name = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
          ? (item as { name: string }).name
          : '');

    if (!name || seen.has(name)) return;

    const lastUsed = item && typeof item === 'object' && typeof (item as { lastUsed?: unknown }).lastUsed === 'number'
      ? (item as { lastUsed: number }).lastUsed
      : 0;

    normalized.push({ name, lastUsed });
    seen.add(name);
  });

  return normalized
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RECENT);
}

const STORAGE_KEY_RECENT = 'vapourkit_recent_filters';
const STORAGE_KEY_FAVORITES = 'vapourkit_favorite_filters';
const MAX_RECENT = 10;

export const FilterSelectorModal = memo<FilterSelectorModalProps>(({
  isOpen,
  onClose,
  filterTemplates,
  onSelectTemplate,
  onDeleteTemplate,
  onEditTemplate,
  currentSelection = '',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recentFilters, setRecentFilters] = useState<RecentFilter[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<FilterTemplate | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCategories, setEditCategories] = useState<string[]>([]);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Load favorites and recent from localStorage
  useEffect(() => {
    try {
      const storedFavorites = localStorage.getItem(STORAGE_KEY_FAVORITES);
      if (storedFavorites) {
        setFavorites(new Set(JSON.parse(storedFavorites)));
      }
      const storedRecent = localStorage.getItem(STORAGE_KEY_RECENT);
      if (storedRecent) {
        const normalized = normalizeRecentFilters(JSON.parse(storedRecent));
        setRecentFilters(normalized);
        localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(normalized));
      }
    } catch (error) {
      console.error('Failed to load filter preferences:', error);
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

  // Group templates by category (templates can appear in multiple categories)
  const groupedTemplates = useMemo(() => {
    return filterTemplates.reduce((acc, template) => {
      // Support both single category and multiple categories
      const categories = Array.isArray(template.category)
        ? template.category
        : (template.category ? [template.category] : ['Uncategorized']);
      
      categories.forEach(category => {
        const cat = category || 'Uncategorized';
        if (!acc[cat]) {
          acc[cat] = [];
        }
        // Avoid duplicates if template is already in this category
        if (!acc[cat].find(t => t.name === template.name)) {
          acc[cat].push(template);
        }
      });
      return acc;
    }, {} as Record<string, FilterTemplate[]>);
  }, [filterTemplates]);

  // Get sorted categories
  const categories = useMemo(() => {
    return ['All', ...Object.keys(groupedTemplates).sort()];
  }, [groupedTemplates]);

  // Filter templates based on search and category
  const filteredTemplates = useMemo(() => {
    let templates = filterTemplates;

    // Filter by category
    if (selectedCategory !== 'All') {
      templates = templates.filter(t => {
        const categories = Array.isArray(t.category)
          ? t.category
          : (t.category ? [t.category] : ['Uncategorized']);
        return categories.includes(selectedCategory);
      });
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const categoryMatches = (cat: string | string[] | undefined) => {
        if (!cat) return false;
        if (Array.isArray(cat)) return cat.some(c => c.toLowerCase().includes(query));
        return cat.toLowerCase().includes(query);
      };
      
      templates = templates.filter(t => 
        t.name.toLowerCase().includes(query) ||
        (t.description?.toLowerCase().includes(query)) ||
        categoryMatches(t.category) ||
        (t.metadata?.tags?.some(tag => tag.toLowerCase().includes(query)))
      );
    }

    // Sort alphabetically
    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }, [filterTemplates, selectedCategory, searchQuery]);

  // Get recent filters that still exist
  const recentFilterTemplates = useMemo(() => {
    return recentFilters
      .map(rf => filterTemplates.find(t => t.name === rf.name))
      .filter(Boolean) as FilterTemplate[];
  }, [recentFilters, filterTemplates]);

  // Get favorite filter templates
  const favoriteFilterTemplates = useMemo(() => {
    return filterTemplates
      .filter(t => favorites.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filterTemplates, favorites]);

  const toggleFavorite = (filterName: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(filterName)) {
        next.delete(filterName);
      } else {
        next.add(filterName);
      }
      try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...next]));
      } catch (error) {
        console.error('Failed to save favorites:', error);
      }
      return next;
    });
  };

  const addToRecent = (filterName: string) => {
    setRecentFilters(prev => {
      // Remove if already exists
      const filtered = prev.filter(rf => rf.name !== filterName);
      // Add to front
      const updated = [{ name: filterName, lastUsed: Date.now() }, ...filtered];
      // Keep only MAX_RECENT
      const trimmed = updated.slice(0, MAX_RECENT);
      try {
        localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(trimmed));
      } catch (error) {
        console.error('Failed to save recent filters:', error);
      }
      return trimmed;
    });
  };

  const handleSelectTemplate = (templateName: string) => {
    addToRecent(templateName);
    onSelectTemplate(templateName);
    onClose();
  };

  const handleClearSelection = () => {
    onSelectTemplate('');
    onClose();
  };

  const handleDeleteTemplate = async (templateName: string) => {
    if (!onDeleteTemplate) return;
    
    if (!confirm(`Delete template "${templateName}"?\n\nThis action cannot be undone.`)) {
      return;
    }

    const success = await onDeleteTemplate(templateName);
    if (success) {
      // Remove from favorites and recent if deleted
      setFavorites(prev => {
        const next = new Set(prev);
        next.delete(templateName);
        try {
          localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...next]));
        } catch (error) {
          console.error('Failed to update favorites:', error);
        }
        return next;
      });
      
      setRecentFilters(prev => {
        const filtered = prev.filter(rf => rf.name !== templateName);
        try {
          localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(filtered));
        } catch (error) {
          console.error('Failed to update recent filters:', error);
        }
        return filtered;
      });
    }
  };

  const handleEditTemplate = (template: FilterTemplate) => {
    setEditingTemplate(template);
    setEditName(template.name);
    setEditDescription(template.description || '');
    // Support both single category and multiple categories
    const categories = Array.isArray(template.category)
      ? template.category
      : (template.category ? [template.category] : []);
    setEditCategories(categories);
    setNewCategoryInput('');
  };

  const handleSaveEdit = async () => {
    if (!onEditTemplate || !editingTemplate || !editName.trim()) return;

    const updatedTemplate: FilterTemplate = {
      ...editingTemplate,
      name: editName.trim(),
      description: editDescription.trim() || undefined,
      category: editCategories.length > 0 ? editCategories : undefined,
    };

    const success = await onEditTemplate(editingTemplate.name, updatedTemplate);
    if (success) {
      // Update favorites and recent with new name if applicable
      const oldName = editingTemplate.name;
      const newName = editName.trim();
      
      if (oldName !== newName) {
        setFavorites(prev => {
          const next = new Set(prev);
          if (next.has(oldName)) {
            next.delete(oldName);
            next.add(newName);
            try {
              localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify([...next]));
            } catch (error) {
              console.error('Failed to update favorites:', error);
            }
          }
          return next;
        });
        
        setRecentFilters(prev => {
          const updated = prev.map(rf => 
            rf.name === oldName ? { ...rf, name: newName } : rf
          );
          try {
            localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(updated));
          } catch (error) {
            console.error('Failed to update recent filters:', error);
          }
          return updated;
        });
      }
      
      setEditingTemplate(null);
      setEditName('');
      setEditDescription('');
      setEditCategories([]);
      setNewCategoryInput('');
    }
  };

  const handleCancelEdit = () => {
    setEditingTemplate(null);
    setEditName('');
    setEditDescription('');
    setEditCategories([]);
    setNewCategoryInput('');
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Edit Dialog Overlay */}
      {editingTemplate && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={handleCancelEdit}
        >
          <div
            className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 w-[500px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-10 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
              <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <Edit3 className="w-4 h-4 text-ink-500" />
                <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Edit Template</h3>
              </div>
              <button
                onClick={handleCancelEdit}
                aria-label="Close edit dialog"
                className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                  Template Name <span className="text-bad-400">*</span>
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Enter template name"
                  className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1">
                  Categories
                </label>
                <div className="space-y-2">
                  {/* Display existing categories */}
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
                  {/* Add new category input */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCategoryInput}
                      onChange={(e) => setNewCategoryInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newCategoryInput.trim()) {
                          e.preventDefault();
                          if (!editCategories.includes(newCategoryInput.trim())) {
                            setEditCategories([...editCategories, newCategoryInput.trim()]);
                          }
                          setNewCategoryInput('');
                        }
                      }}
                      placeholder="Add category (press Enter)"
                      className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (newCategoryInput.trim() && !editCategories.includes(newCategoryInput.trim())) {
                          setEditCategories([...editCategories, newCategoryInput.trim()]);
                          setNewCategoryInput('');
                        }
                      }}
                      disabled={!newCategoryInput.trim()}
                      className="h-7 px-2.5 rounded inline-flex items-center text-[11.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      Add
                    </button>
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
                  placeholder="Describe what this filter does..."
                  rows={3}
                  className="w-full bg-ink-850 border border-ink-750 rounded px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500 resize-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-800">
              <button
                onClick={handleSaveEdit}
                disabled={!editName.trim()}
                className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Save Changes
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Modal */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 w-[90vw] max-w-5xl h-[80vh] max-h-[800px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <FilterIcon className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Select Filter Template</h2>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
            title="Close"
            aria-label="Close filter selector"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="flex-shrink-0 px-3 py-2 border-b border-ink-800">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search filters by name, category, or description..."
              className="w-full h-8 bg-ink-850 border border-ink-750 rounded pl-8 pr-8 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Category Sidebar */}
          <div className="w-56 flex-shrink-0 border-r border-ink-800 overflow-y-auto bg-ink-950">
            <div className="pb-2">
              <div className="px-2.5 pt-2.5 pb-1 text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">
                Categories
              </div>
              <div>
                {categories.map(category => {
                  const count = category === 'All'
                    ? filterTemplates.length
                    : (groupedTemplates[category]?.length || 0);

                  return (
                    <button
                      key={category}
                      onClick={() => setSelectedCategory(category)}
                      className={`w-full h-7 text-left px-2.5 text-[12px] transition-colors flex items-center justify-between gap-2 group ${
                        selectedCategory === category
                          ? 'bg-ink-850 text-ink-100 shadow-[inset_2px_0_0] shadow-accent-500'
                          : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
                      }`}
                    >
                      <span className="truncate">{category}</span>
                      <span className={`text-[10.5px] tabular-nums ${
                        selectedCategory === category
                          ? 'text-accent-400'
                          : 'text-ink-500 group-hover:text-ink-400'
                      }`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Filter List */}
          <div className="flex-1 overflow-y-auto bg-ink-950">
            {/* Custom/New Button */}
            <button
              onClick={() => handleSelectTemplate('')}
              className={`w-full h-9 px-3 border-b border-ink-900 transition-colors flex items-center gap-2 text-[12.5px] font-medium text-left ${
                currentSelection === ''
                  ? 'bg-ink-850 text-accent-300 shadow-[inset_2px_0_0] shadow-accent-500'
                  : 'text-accent-400 hover:bg-ink-900 hover:text-accent-300'
              }`}
              title="Start with a blank filter"
            >
              <Plus className="w-4 h-4" />
              <span>Custom/New Filter</span>
            </button>

            {/* Current Selection */}
            {currentSelection && (
              <div className="flex items-center gap-2.5 min-h-[36px] px-3 py-1.5 bg-ink-900 border-b border-ink-800 shadow-[inset_2px_0_0] shadow-accent-500">
                <div className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Current Selection</div>
                <div className="text-[12.5px] font-medium text-accent-400 truncate flex-1 min-w-0">{currentSelection}</div>
                <button
                  onClick={handleClearSelection}
                  className="h-6 px-2 rounded inline-flex items-center text-[11px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors flex-shrink-0"
                >
                  Clear (Custom)
                </button>
              </div>
            )}

            {/* Favorites Section */}
            {!searchQuery && selectedCategory === 'All' && favoriteFilterTemplates.length > 0 && (
              <div className="mb-2">
                <div className="h-7 flex items-center gap-2 px-2.5 bg-ink-850 border-y border-ink-800 font-display text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                  <Star className="w-3 h-3 text-warn-400 fill-warn-400" />
                  <h3>Favorites</h3>
                  <span className="text-ink-500 tabular-nums">({favoriteFilterTemplates.length})</span>
                </div>
                <div>
                  {favoriteFilterTemplates.map(template => (
                    <FilterItem
                      key={template.name}
                      template={template}
                      isFavorite={true}
                      onToggleFavorite={toggleFavorite}
                      onSelect={handleSelectTemplate}
                      isSelected={currentSelection === template.name}
                      onDelete={onDeleteTemplate ? handleDeleteTemplate : undefined}
                      onEdit={onEditTemplate ? handleEditTemplate : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Section */}
            {!searchQuery && selectedCategory === 'All' && recentFilterTemplates.length > 0 && (
              <div className="mb-2">
                <div className="h-7 flex items-center gap-2 px-2.5 bg-ink-850 border-y border-ink-800 font-display text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                  <Clock className="w-3 h-3 text-ink-500" />
                  <h3>Recent</h3>
                  <span className="text-ink-500 tabular-nums">({recentFilterTemplates.length})</span>
                </div>
                <div>
                  {recentFilterTemplates.map(template => (
                    <FilterItem
                      key={template.name}
                      template={template}
                      isFavorite={favorites.has(template.name)}
                      onToggleFavorite={toggleFavorite}
                      onSelect={handleSelectTemplate}
                      isSelected={currentSelection === template.name}
                      onDelete={onDeleteTemplate ? handleDeleteTemplate : undefined}
                      onEdit={onEditTemplate ? handleEditTemplate : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* All Filters / Search Results */}
            <div>
              <div className="h-7 flex items-center gap-2 px-2.5 bg-ink-850 border-y border-ink-800 font-display text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400">
                <FilterIcon className="w-3 h-3 text-ink-500" />
                <h3>
                  {searchQuery ? 'Search Results' : selectedCategory === 'All' ? 'All Filters' : selectedCategory}
                </h3>
                <span className="text-ink-500 tabular-nums">({filteredTemplates.length})</span>
              </div>
              {filteredTemplates.length === 0 ? (
                <div className="text-center py-12 text-ink-500">
                  <FilterIcon className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p className="text-[12.5px] text-ink-400">No filters found</p>
                  {searchQuery && (
                    <p className="text-[11px] mt-1">Try adjusting your search query</p>
                  )}
                </div>
              ) : (
                <div>
                  {filteredTemplates.map(template => (
                    <FilterItem
                      key={template.name}
                      template={template}
                      isFavorite={favorites.has(template.name)}
                      onToggleFavorite={toggleFavorite}
                      onSelect={handleSelectTemplate}
                      isSelected={currentSelection === template.name}
                      onDelete={onDeleteTemplate ? handleDeleteTemplate : undefined}
                      onEdit={onEditTemplate ? handleEditTemplate : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 h-8 border-t border-ink-800 px-3 bg-ink-900 flex items-center justify-between text-[11px] text-ink-500">
          <div className="flex items-center gap-3 tabular-nums">
            <span>{filteredTemplates.length} filters shown</span>
            <span>•</span>
            <span>{favorites.size} favorites</span>
          </div>
          <div className="flex items-center gap-2">
            <kbd className="px-1.5 py-0.5 bg-ink-850 border border-ink-750 rounded text-[10px] font-mono text-ink-300">Esc</kbd>
            <span>to close</span>
          </div>
        </div>
      </div>
      </div>
    </>
  );
});

FilterSelectorModal.displayName = 'FilterSelectorModal';

// Filter Item Component
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
  return (
    <div
      className={`group relative flex items-start gap-2.5 px-3 py-1.5 border-b border-ink-900 cursor-pointer transition-colors ${
        isSelected
          ? 'bg-ink-850 shadow-[inset_2px_0_0] shadow-accent-500'
          : 'hover:bg-ink-900'
      }`}
      onClick={() => onSelect(template.name)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-h-[20px]">
          <h4 className={`text-[12.5px] font-medium min-w-0 break-words mr-1 ${
            isSelected ? 'text-accent-300' : 'text-ink-200'
          }`}>
            {template.name}
          </h4>
          {/* Display category/categories */}
          {Array.isArray(template.category) ? (
            template.category.map((cat, index) => (
              <span key={index} className="inline-flex items-center h-[18px] px-1.5 rounded border border-ink-750 bg-ink-850 text-[10px] text-ink-400 flex-shrink-0">
                {cat}
              </span>
            ))
          ) : template.category ? (
            <span className="inline-flex items-center h-[18px] px-1.5 rounded border border-ink-750 bg-ink-850 text-[10px] text-ink-400 flex-shrink-0">
              {template.category}
            </span>
          ) : null}
          {template.metadata?.tags && template.metadata.tags.length > 0 && (
            template.metadata.tags.slice(0, 3).map((tag, i) => (
              <span
                key={i}
                className="inline-flex items-center h-[18px] px-1.5 rounded text-[10px] bg-ink-900 text-ink-500 flex-shrink-0"
              >
                {tag}
              </span>
            ))
          )}
        </div>
        {template.description && (
          <p className="text-[11px] text-ink-500 line-clamp-2 mt-0.5">
            {template.description}
          </p>
        )}
      </div>

      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isSelected && (
          <ChevronRight className="w-3.5 h-3.5 text-accent-400" aria-hidden="true" />
        )}
        {onEdit && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit(template);
            }}
            className="w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-within:opacity-100"
            title="Edit template"
            aria-label="Edit template"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(template.name);
            }}
            className="w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-bad-400 hover:bg-bad-500/10 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-within:opacity-100"
            title="Delete template"
            aria-label="Delete template"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(template.name);
          }}
          className={`w-6 h-6 rounded grid place-items-center transition-colors ${
            isFavorite
              ? 'text-warn-400 hover:text-warn-500'
              : 'text-ink-500 hover:text-warn-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-within:opacity-100'
          }`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={`w-3.5 h-3.5 ${isFavorite ? 'fill-warn-400' : ''}`} />
        </button>
      </div>
    </div>
  );
});

FilterItem.displayName = 'FilterItem';
