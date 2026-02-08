import { memo, useState, useEffect, useRef, useMemo } from 'react';
import { X, Check, Edit2, Filter, Search, CheckCircle } from 'lucide-react';

interface FilterImportItem {
  originalName: string;
  displayName: string;
  code: string;
  description?: string;
  category?: string | string[];
  selected: boolean;
}

interface FilterImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  workflowName: string;
  filters: {
    name: string;
    code: string;
    description?: string;
    filterType: 'aiModel' | 'custom';
    category?: string | string[];
  }[];
  onImport: (selectedFilters: { name: string; code: string; description?: string; category?: string | string[] }[]) => void;
}

export const FilterImportModal = memo<FilterImportModalProps>(({
  isOpen,
  onClose,
  workflowName,
  filters,
  onImport,
}) => {
  const [importItems, setImportItems] = useState<FilterImportItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);

  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return importItems;
    const query = searchQuery.toLowerCase();
    return importItems.filter(item => 
      item.displayName.toLowerCase().includes(query) ||
      item.originalName.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query)
    );
  }, [importItems, searchQuery]);

  // Initialize import items when modal opens or filters change
  useEffect(() => {
    if (isOpen) {
      // Filter out AI model filters and initialize with default names
      const customFilters = filters.filter(f => f.filterType !== 'aiModel');
      setImportItems(
        customFilters.map(filter => ({
          originalName: filter.name,
          displayName: `${filter.name} (${workflowName})`,
          code: filter.code,
          description: filter.description,
          category: filter.category,
          selected: true, // All selected by default
        }))
      );
      setEditingIndex(null);
      setSearchQuery('');
    }
  }, [isOpen, filters, workflowName]);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (editingIndex !== null) {
          // Cancel editing
          setEditingIndex(null);
          setEditName('');
        } else {
          // Close modal
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, editingIndex, onClose]);

  const toggleSelection = (index: number) => {
    setImportItems(prev =>
      prev.map((item, i) => (i === index ? { ...item, selected: !item.selected } : item))
    );
  };

  const toggleSelectAll = () => {
    const allSelected = importItems.every(item => item.selected);
    setImportItems(prev => prev.map(item => ({ ...item, selected: !allSelected })));
  };

  const startEditing = (index: number) => {
    setEditingIndex(index);
    setEditName(importItems[index].displayName);
  };

  const saveEdit = () => {
    if (editingIndex !== null && editName.trim()) {
      setImportItems(prev =>
        prev.map((item, i) => (i === editingIndex ? { ...item, displayName: editName.trim() } : item))
      );
      setEditingIndex(null);
      setEditName('');
    }
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditName('');
  };

  const handleImport = () => {
    const selectedItems = importItems
      .filter(item => item.selected)
      .map(item => ({
        name: item.displayName,
        code: item.code,
        description: item.description,
        category: item.category,
      }));
    
    if (selectedItems.length === 0) {
      return; // Don't import if nothing selected
    }

    onImport(selectedItems);
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  const selectedCount = importItems.filter(item => item.selected).length;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        ref={modalRef}
        className="bg-dark-elevated rounded-xl border border-gray-800 shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-primary-purple" />
            <div>
              <h2 className="text-xl font-semibold">Import Filters from Workflow</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Workflow: <span className="text-white font-medium">{workflowName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="p-2 hover:bg-dark-surface rounded-lg transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Info Note */}
        <div className="px-4 pt-3">
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
            <p className="text-xs text-blue-300">
              <strong>Note:</strong> This permanently imports filters as templates. If you just want to process a video with a workflow's settings, use <strong>Workflow → Open</strong> instead.
            </p>
          </div>
        </div>

        {/* Search Bar */}
        {importItems.length > 0 && (
          <div className="px-4 pt-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search filters..."
                className="w-full bg-dark-surface border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary-purple transition-colors placeholder-gray-500"
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {importItems.length === 0 ? (
            <div className="text-center text-gray-400 py-12">
              <Filter className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No custom filters found in this workflow</p>
              <p className="text-xs text-gray-500 mt-1">(AI model filters are not imported)</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="text-center text-gray-400 py-12">
              <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No filters match your search</p>
            </div>
          ) : (
            <>
              {/* Select All */}
              <div className="mb-3 flex items-center justify-between px-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={importItems.every(item => item.selected)}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-600 bg-dark-surface text-primary-purple 
                             focus:ring-2 focus:ring-primary-purple focus:ring-offset-0"
                  />
                  <span className="text-sm text-gray-300 font-medium">
                    Select All
                  </span>
                </label>
                <span className="text-xs text-gray-400">
                  {selectedCount} of {importItems.length} selected
                </span>
              </div>

              {/* Filter List */}
              <div className="space-y-2">
                {filteredItems.map((item) => {
                  // Find the real index in importItems array
                  const realIndex = importItems.findIndex(i => i.originalName === item.originalName);
                  return (
                  <div
                    key={realIndex}
                    className="bg-dark-surface rounded-lg border border-gray-700 p-3 hover:border-gray-600 transition-colors"
                  >
                    {editingIndex === realIndex ? (
                      /* Edit Mode */
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={() => toggleSelection(realIndex)}
                            className="w-4 h-4 mt-1.5 rounded border-gray-600 bg-dark-elevated text-primary-purple 
                                     focus:ring-2 focus:ring-primary-purple focus:ring-offset-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-gray-500 mb-1">Filter Name</div>
                            <div className="flex items-center gap-2 mb-2">
                              <input
                                type="text"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEdit();
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                className="flex-1 px-2 py-1.5 bg-dark-elevated border border-gray-700 rounded text-sm
                                         focus:outline-none focus:border-primary-purple transition-colors"
                                autoFocus
                              />
                              <button
                                onClick={saveEdit}
                                className="p-1.5 hover:bg-dark-elevated rounded transition-colors group"
                                title="Save"
                              >
                                <Check className="w-3.5 h-3.5 text-green-400 group-hover:text-green-300" />
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="p-1.5 hover:bg-dark-elevated rounded transition-colors group"
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5 text-gray-400 group-hover:text-red-400" />
                              </button>
                            </div>
                            {item.originalName !== editName && (
                              <div className="text-xs text-gray-500 mb-2">
                                Original: {item.originalName}
                              </div>
                            )}
                            {/* Categories */}
                            {item.category && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {Array.isArray(item.category) ? (
                                  item.category.map((cat, idx) => (
                                    <span key={idx} className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded">
                                      {cat}
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded">
                                    {item.category}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Description */}
                        {item.description && (
                          <div className="ml-6">
                            <p className="text-xs text-gray-400">{item.description}</p>
                          </div>
                        )}

                        {/* Code Preview */}
                        <div className="ml-6">
                          <div className="text-xs text-gray-500 font-mono bg-dark-elevated/50 rounded p-2 overflow-x-auto">
                            {item.code.split('\n')[0]}
                            {item.code.split('\n').length > 1 && ' ...'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* View Mode */
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={item.selected}
                          onChange={() => toggleSelection(realIndex)}
                          className="w-4 h-4 mt-1 rounded border-gray-600 bg-dark-elevated text-primary-purple 
                                   focus:ring-2 focus:ring-primary-purple focus:ring-offset-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2 mb-1">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h3 className="font-medium text-sm">{item.displayName}</h3>
                                {/* Categories */}
                                {Array.isArray(item.category) ? (
                                  item.category.map((cat, idx) => (
                                    <span key={idx} className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded flex-shrink-0">
                                      {cat}
                                    </span>
                                  ))
                                ) : item.category ? (
                                  <span className="text-xs px-2 py-0.5 bg-dark-bg text-gray-400 rounded flex-shrink-0">
                                    {item.category}
                                  </span>
                                ) : null}
                              </div>
                              {item.originalName !== item.displayName && (
                                <div className="text-xs text-gray-500 truncate">
                                  Original: {item.originalName}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => startEditing(realIndex)}
                              className="p-1.5 hover:bg-dark-elevated rounded transition-colors group flex-shrink-0"
                              title="Rename filter"
                            >
                              <Edit2 className="w-3.5 h-3.5 text-gray-400 group-hover:text-primary-purple" />
                            </button>
                          </div>

                          {/* Description */}
                          {item.description && (
                            <p className="text-xs text-gray-400 mb-2">{item.description}</p>
                          )}

                          {/* Code Preview */}
                          <div className="text-xs text-gray-500 font-mono bg-dark-elevated/50 rounded p-2 overflow-x-auto">
                            {item.code.split('\n')[0]}
                            {item.code.split('\n').length > 1 && ' ...'}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )})}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-400">
              {selectedCount > 0 ? (
                <div className="flex items-center gap-1.5">
                  <CheckCircle className="w-4 h-4 text-primary-purple" />
                  <span>
                    <span className="text-white font-medium">{selectedCount}</span> filter
                    {selectedCount !== 1 ? 's' : ''} ready to import
                  </span>
                </div>
              ) : (
                <span className="text-gray-500">No filters selected</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-xs text-gray-400 mr-2">
                <kbd className="px-2 py-0.5 bg-dark-elevated border border-gray-700 rounded text-gray-300">Esc</kbd>
                <span>to close</span>
              </div>
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 bg-dark-elevated hover:bg-gray-800 rounded text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={selectedCount === 0}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  selectedCount > 0
                    ? 'bg-primary-purple hover:bg-primary-purple/80'
                    : 'bg-dark-elevated text-gray-500 cursor-not-allowed opacity-50'
                }`}
              >
                Import {selectedCount > 0 ? `(${selectedCount})` : ''}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

FilterImportModal.displayName = 'FilterImportModal';
