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
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={handleCancelEdit}
        >
          <div 
            className="bg-dark-elevated rounded-xl shadow-2xl w-[500px] max-w-[90vw] border border-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-primary-blue" />
                <h3 className="text-xl font-semibold">Edit Template</h3>
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
                  Template Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Enter template name"
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-blue transition-colors placeholder-gray-500"
                  autoFocus
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-300">
                  Categories
                </label>
                <div className="space-y-2">
                  {/* Display existing categories */}
                  {editCategories.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {editCategories.map((cat, index) => (
                        <span
                          key={index}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-primary-blue/20 border border-primary-blue/50 rounded-lg text-primary-blue"
                        >
                          {cat}
                          <button
                            onClick={() => setEditCategories(prev => prev.filter((_, i) => i !== index))}
                            className="hover:text-red-400 transition-colors"
                            type="button"
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
                      className="flex-1 bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-blue transition-colors placeholder-gray-500"
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
                      className="px-3 py-2 bg-primary-blue hover:bg-primary-blue/90 disabled:bg-dark-surface disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
                    >
                      Add
                    </button>
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
                  placeholder="Describe what this filter does..."
                  rows={3}
                  className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-blue transition-colors placeholder-gray-500 resize-none"
                />
              </div>
            </div>
            
            <div className="flex items-center gap-2 p-4 border-t border-gray-800 bg-dark-surface">
              <button
                onClick={handleSaveEdit}
                disabled={!editName.trim()}
                className="flex-1 bg-primary-blue hover:bg-primary-blue/90 disabled:bg-dark-surface disabled:cursor-not-allowed text-white text-sm py-2 rounded-lg transition-colors font-medium"
              >
                Save Changes
              </button>
              <button
                onClick={handleCancelEdit}
                className="flex-1 bg-dark-surface hover:bg-dark-bg border border-gray-700 text-white text-sm py-2 rounded-lg transition-colors"
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
            <FilterIcon className="w-5 h-5 text-primary-blue" />
            <h2 className="text-xl font-semibold">Select Filter Template</h2>
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
        <div className="p-4 border-b border-gray-800">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search filters by name, category, or description..."
              className="w-full bg-dark-surface border border-gray-700 rounded-lg pl-10 pr-4 py-2 focus:outline-none focus:border-primary-blue transition-colors placeholder-gray-500"
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
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Categories
              </div>
              <div className="space-y-0.5">
                {categories.map(category => {
                  const count = category === 'All' 
                    ? filterTemplates.length 
                    : (groupedTemplates[category]?.length || 0);
                  
                  return (
                    <button
                      key={category}
                      onClick={() => setSelectedCategory(category)}
                      className={`w-full text-left px-3 py-2 rounded-lg transition-colors flex items-center justify-between group ${
                        selectedCategory === category
                          ? 'bg-primary-blue text-white'
                          : 'text-gray-300 hover:bg-dark-elevated hover:text-white'
                      }`}
                    >
                      <span className="truncate">{category}</span>
                      <span className={`text-xs ${
                        selectedCategory === category
                          ? 'text-blue-200'
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

          {/* Filter List */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* Custom/New Button */}
            <div className="mb-4">
              <button
                onClick={() => handleSelectTemplate('')}
                className={`w-full px-3 py-2 rounded-lg border transition-colors flex items-center gap-2 text-sm font-medium ${
                  currentSelection === ''
                    ? 'bg-primary-blue/20 border-primary-blue text-primary-blue'
                    : 'bg-primary-blue/10 border-primary-blue/40 hover:bg-primary-blue/15 hover:border-primary-blue/60 text-primary-blue'
                }`}
                title="Start with a blank filter"
              >
                <Plus className="w-4 h-4" />
                <span>Custom/New Filter</span>
              </button>
            </div>

            {/* Current Selection */}
            {currentSelection && (
              <div className="mb-4 p-3 bg-dark-surface border border-primary-blue/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Current Selection</div>
                    <div className="font-medium text-primary-blue">{currentSelection}</div>
                  </div>
                  <button
                    onClick={handleClearSelection}
                    className="px-3 py-1.5 bg-dark-elevated hover:bg-dark-bg border border-gray-700 text-white text-xs rounded-lg transition-colors"
                  >
                    Clear (Custom)
                  </button>
                </div>
              </div>
            )}

            {/* Favorites Section */}
            {!searchQuery && selectedCategory === 'All' && favoriteFilterTemplates.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                  <h3 className="font-semibold text-gray-200">Favorites</h3>
                  <span className="text-sm text-gray-500">({favoriteFilterTemplates.length})</span>
                </div>
                <div className="grid grid-cols-1 gap-2">
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
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="w-4 h-4 text-primary-blue" />
                  <h3 className="font-semibold text-gray-200">Recent</h3>
                  <span className="text-sm text-gray-500">({recentFilterTemplates.length})</span>
                </div>
                <div className="grid grid-cols-1 gap-2">
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
              <div className="flex items-center gap-2 mb-3">
                <FilterIcon className="w-4 h-4 text-gray-400" />
                <h3 className="font-semibold text-gray-200">
                  {searchQuery ? 'Search Results' : selectedCategory === 'All' ? 'All Filters' : selectedCategory}
                </h3>
                <span className="text-sm text-gray-500">({filteredTemplates.length})</span>
              </div>
              {filteredTemplates.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <FilterIcon className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>No filters found</p>
                  {searchQuery && (
                    <p className="text-sm mt-1">Try adjusting your search query</p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
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
        <div className="border-t border-gray-800 px-4 py-3 bg-dark-surface">
          <div className="flex items-center justify-between text-sm text-gray-400">
            <div className="flex items-center gap-4">
              <span>{filteredTemplates.length} filters shown</span>
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
      className={`group relative p-3 rounded-lg border transition-all cursor-pointer ${
        isSelected
          ? 'bg-primary-blue/20 border-primary-blue'
          : 'bg-dark-surface border-gray-700 hover:border-gray-600 hover:bg-dark-elevated'
      }`}
      onClick={() => onSelect(template.name)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h4 className={`font-medium ${
              isSelected ? 'text-primary-blue' : 'text-white'
            }`}>
              {template.name}
            </h4>
            {/* Display category/categories */}
            {Array.isArray(template.category) ? (
              template.category.map((cat, index) => (
                <span key={index} className="text-xs px-2 py-1 bg-dark-bg text-gray-400 rounded flex-shrink-0">
                  {cat}
                </span>
              ))
            ) : template.category ? (
              <span className="text-xs px-2 py-1 bg-dark-bg text-gray-400 rounded flex-shrink-0">
                {template.category}
              </span>
            ) : null}
          </div>
          {template.description && (
            <p className="text-sm text-gray-400 line-clamp-2">
              {template.description}
            </p>
          )}
          {template.metadata?.tags && template.metadata.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {template.metadata.tags.slice(0, 3).map((tag, i) => (
                <span
                  key={i}
                  className="text-xs px-2 py-0.5 bg-dark-bg/50 text-gray-500 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {onEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit(template);
              }}
              className="p-1.5 rounded-lg transition-all text-gray-600 hover:text-primary-blue hover:bg-dark-elevated"
              title="Edit template"
            >
              <Edit3 className="w-4 h-4" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(template.name);
              }}
              className="p-1.5 rounded-lg transition-all text-gray-600 hover:text-red-400 hover:bg-dark-elevated"
              title="Delete template"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(template.name);
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
      {isSelected && (
        <div className="absolute top-2 right-2">
          <ChevronRight className="w-4 h-4 text-primary-blue" />
        </div>
      )}
    </div>
  );
});

FilterItem.displayName = 'FilterItem';
