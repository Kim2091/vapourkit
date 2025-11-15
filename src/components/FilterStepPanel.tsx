import { useState, useRef, useEffect } from 'react';
import { Save, ChevronDown, ChevronUp, Filter, Trash2, Pencil, Upload } from 'lucide-react';
import type { FilterTemplate } from '../electron.d';

interface FilterStepPanelProps {
  title: string;
  enabled: boolean;
  selectedPreset: string;
  customCode: string;
  templates: FilterTemplate[];
  isProcessing: boolean;
  onToggle: (enabled: boolean) => void;
  onPresetChange: (preset: string) => void;
  onCodeChange: (code: string) => void;
  onSaveTemplate?: (template: FilterTemplate) => Promise<boolean>;
  onDeleteTemplate?: (name: string) => Promise<boolean>;
}

export function FilterStepPanel({
  title,
  enabled,
  selectedPreset,
  customCode,
  templates,
  isProcessing,
  onToggle,
  onPresetChange,
  onCodeChange,
  onSaveTemplate,
  onDeleteTemplate,
}: FilterStepPanelProps) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetDescription, setPresetDescription] = useState('');

  // Auto-resize textarea based on content
  const autoResizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(120, textarea.scrollHeight) + 'px';
  };

  const handleSaveTemplate = async () => {
    if (onSaveTemplate && presetName.trim()) {
      // Check if template with this name already exists
      const existingTemplate = templates.find(t => t.name === presetName.trim());
      if (existingTemplate) {
        const confirmed = confirm(
          `A template named "${presetName.trim()}" already exists. Do you want to overwrite it?`
        );
        if (!confirmed) {
          return;
        }
      }

      const success = await onSaveTemplate({
        name: presetName.trim(),
        code: customCode,
        description: presetDescription.trim() || undefined,
      });
      if (success) {
        setPresetName('');
        setPresetDescription('');
        setShowSaveDialog(false);
      }
    }
  };

  const handleImportTemplate = async () => {
    try {
      const filePath = await window.electronAPI.selectTemplateFile();
      if (!filePath) return;

      const result = await window.electronAPI.readTemplateFile(filePath);
      if (!result.success || !result.content) {
        alert(`Failed to read template file: ${result.error || 'Unknown error'}`);
        return;
      }

      const template = JSON.parse(result.content) as FilterTemplate;
      
      if (!template.name || !template.code) {
        alert('Invalid template format. Must include "name" and "code" fields.');
        return;
      }
      
      // Check if template with this name already exists
      const existingTemplate = templates.find(t => t.name === template.name);
      if (existingTemplate) {
        const confirmed = confirm(
          `A template named "${template.name}" already exists. Do you want to overwrite it?`
        );
        if (!confirmed) {
          return;
        }
      }
      
      if (onSaveTemplate) {
        await onSaveTemplate(template);
      }
    } catch (err) {
      alert('Failed to import template. Please check the file format.');
      console.error('Import error:', err);
    }
  };

  const handleEditDescription = async () => {
    if (onSaveTemplate && selectedTemplateObj) {
      const success = await onSaveTemplate({
        ...selectedTemplateObj,
        description: presetDescription.trim() || undefined,
      });
      if (success) {
        setPresetDescription('');
        setShowEditDialog(false);
      }
    }
  };

  const openEditDialog = () => {
    if (selectedTemplateObj) {
      setPresetDescription(selectedTemplateObj.description || '');
      setShowEditDialog(true);
    }
  };

  const handleDeleteTemplate = async (name: string) => {
    if (onDeleteTemplate && confirm(`Delete template "${name}"?`)) {
      await onDeleteTemplate(name);
      // Reset selection if deleted template was selected
      if (selectedPreset === name) {
        onPresetChange('');
      }
    }
  };

  const selectedTemplateObj = templates.find(t => t.name === selectedPreset);

  const [isExpanded, setIsExpanded] = useState(false);
  const [pendingCode, setPendingCode] = useState(customCode);
  const previousExpandedRef = useRef<boolean>(isExpanded);
  const previousProcessingRef = useRef<boolean>(isProcessing);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync pending code when customCode prop changes from outside
  useEffect(() => {
    setPendingCode(customCode);
  }, [customCode]);

  // Handle focus restoration when processing state changes
  useEffect(() => {
    const wasProcessing = previousProcessingRef.current;
    
    // If processing just stopped and the filter is expanded, ensure textarea is interactive
    if (wasProcessing && !isProcessing && isExpanded && textareaRef.current) {
      // Force a re-focus to ensure the textarea is properly interactive
      // Use a small timeout to ensure the disabled attribute has been removed
      const timeoutId = setTimeout(() => {
        if (textareaRef.current && document.activeElement === textareaRef.current) {
          // If the textarea already has focus, blur and refocus to reset its state
          textareaRef.current.blur();
          textareaRef.current.focus();
        }
      }, 0);
      
      return () => clearTimeout(timeoutId);
    }
    
    previousProcessingRef.current = isProcessing;
  }, [isProcessing, isExpanded]);

  // Auto-resize textarea when content changes, preserving scroll position
  useEffect(() => {
    if (textareaRef.current && isExpanded) {
      const container = containerRef.current;
      const scrollParent = container?.closest('.overflow-auto, .overflow-y-auto') as HTMLElement;
      const savedScrollTop = scrollParent?.scrollTop;
      
      autoResizeTextarea(textareaRef.current);
      
      // Restore scroll position after resize
      if (scrollParent && savedScrollTop !== undefined) {
        scrollParent.scrollTop = savedScrollTop;
      }
    }
  }, [pendingCode, isExpanded]);

  // Evaluate when filter is collapsed
  useEffect(() => {
    const wasExpanded = previousExpandedRef.current;
    
    // Check if we just collapsed the filter (went from true to false)
    if (wasExpanded && !isExpanded) {
      // Apply pending changes
      if (pendingCode !== customCode) {
        onCodeChange(pendingCode);
      }
    }
    
    previousExpandedRef.current = isExpanded;
  }, [isExpanded, pendingCode, customCode, onCodeChange]);

  const handleCodeChange = (code: string) => {
    setPendingCode(code);
  };

  const handleCodeBlur = () => {
    // Apply pending changes when user deselects the textarea
    if (pendingCode !== customCode) {
      onCodeChange(pendingCode);
    }
  };

  return (
    <div className="bg-dark-elevated/50 rounded-xl border border-gray-800 p-4">
      <div className="bg-dark-surface rounded-xl border border-gray-700 shadow-lg">
        {/* Header - Collapsible */}
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={() => enabled && setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 flex-1 hover:opacity-80 transition-opacity min-w-0"
            disabled={!enabled}
          >
            <Filter className="w-4 h-4 text-primary-purple flex-shrink-0" />
            <h3 className="text-base font-semibold truncate">{title}</h3>
            {enabled && (
              isExpanded 
                ? <ChevronUp className="w-4 h-4 ml-auto flex-shrink-0" /> 
                : <ChevronDown className="w-4 h-4 ml-auto flex-shrink-0" />
            )}
          </button>
          <div className="flex items-center gap-2 ml-3">
            <input
              type="checkbox"
              id={`${title}-enabled`}
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={isProcessing}
              className="w-4 h-4 rounded border-gray-700 bg-dark-elevated text-primary-purple focus:ring-2 focus:ring-primary-purple focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
              title={enabled ? `Disable ${title}` : `Enable ${title}`}
            />
          </div>
        </div>

        {/* Expandable Content */}
        {isExpanded && enabled && (
          <div ref={containerRef} className="px-4 pb-4 space-y-3 border-t border-gray-700/50 pt-3 bg-dark-elevated/50">
            {/* Save and Import Template Buttons */}
            {onSaveTemplate && (
              <div className="flex gap-3">
                <button
                  onClick={() => setShowSaveDialog(!showSaveDialog)}
                  className="text-sm text-accent-cyan hover:text-cyan-400 transition-colors flex items-center gap-1"
                  disabled={isProcessing}
                >
                  <Save className="w-3 h-3" />
                  Save Template
                </button>
                <button
                  onClick={handleImportTemplate}
                  className="text-sm text-accent-cyan hover:text-cyan-400 transition-colors flex items-center gap-1"
                  disabled={isProcessing}
                >
                  <Upload className="w-3 h-3" />
                  Import Template
                </button>
              </div>
            )}

            {/* Save Template Dialog */}
            {showSaveDialog && (
              <div className="p-3 bg-dark-surface/50 rounded-lg border border-gray-700/50">
                <h4 className="text-sm font-medium mb-2">Save as Template</h4>
                <input
                  type="text"
                  placeholder="Template name"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  className="w-full bg-dark-bg border border-gray-700 rounded px-2 py-1.5 mb-2 text-sm focus:outline-none focus:border-primary-purple"
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={presetDescription}
                  onChange={(e) => setPresetDescription(e.target.value)}
                  className="w-full bg-dark-bg border border-gray-700 rounded px-2 py-1.5 mb-2 text-sm focus:outline-none focus:border-primary-purple"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveTemplate}
                    disabled={!presetName.trim()}
                    className="flex-1 bg-primary-purple hover:bg-purple-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm py-1.5 rounded transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setShowSaveDialog(false)}
                    className="flex-1 bg-dark-bg hover:bg-gray-700 text-white text-sm py-1.5 rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Edit Description Dialog */}
            {showEditDialog && (
              <div className="p-3 bg-dark-surface/50 rounded-lg border border-gray-700/50">
                <h4 className="text-sm font-medium mb-2">Edit Description</h4>
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={presetDescription}
                  onChange={(e) => setPresetDescription(e.target.value)}
                  className="w-full bg-dark-bg border border-gray-700 rounded px-2 py-1.5 mb-2 text-sm focus:outline-none focus:border-primary-purple"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleEditDescription}
                    className="flex-1 bg-primary-purple hover:bg-purple-600 text-white text-sm py-1.5 rounded transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setShowEditDialog(false)}
                    className="flex-1 bg-dark-bg hover:bg-gray-700 text-white text-sm py-1.5 rounded transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Template Dropdown with Delete */}
            <div className="flex gap-2">
              <select
                value={selectedPreset}
                onChange={(e) => onPresetChange(e.target.value)}
                disabled={isProcessing}
                className="flex-1 bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-base focus:outline-none focus:border-primary-purple transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">Custom</option>
                {templates.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.name}
                  </option>
                ))}
              </select>
              {selectedPreset && onDeleteTemplate && (
                <button
                  onClick={() => handleDeleteTemplate(selectedPreset)}
                  disabled={isProcessing}
                  className="px-3 bg-dark-surface border border-gray-700 rounded-lg hover:bg-red-900/20 hover:border-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Delete template"
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                </button>
              )}
            </div>

            {/* Description with Edit Button */}
            {selectedTemplateObj && selectedTemplateObj.description && (
              <div className="p-2.5 bg-dark-bg rounded-lg border border-gray-600 flex items-start justify-between gap-2">
                <p className="text-sm text-gray-200 font-medium flex-1">{selectedTemplateObj.description}</p>
                {onSaveTemplate && (
                  <button
                    onClick={openEditDialog}
                    disabled={isProcessing}
                    className="text-gray-400 hover:text-accent-cyan transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Edit description"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Code Editor */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={pendingCode}
                onChange={(e) => {
                  handleCodeChange(e.target.value);
                }}
                onBlur={handleCodeBlur}
                disabled={isProcessing}
                placeholder="# Enter custom VapourSynth code here&#10;# Example: clip = core.resize.Bilinear(clip, width=720, height=540)"
                className="w-full bg-dark-bg border border-gray-700 rounded-lg px-3 py-2 font-mono text-sm focus:outline-none focus:border-primary-purple transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[120px] resize-none overflow-hidden"
                spellCheck={false}
              />
              <div className="mt-2 text-sm text-gray-500">
                <p className="mb-1">Tips:</p>
                <ul className="list-disc list-inside space-y-0.5 text-xs">
                  <li>Use <code className="bg-dark-surface px-1 rounded">clip</code> variable for the video stream</li>
                  <li>Use <code className="bg-dark-surface px-1 rounded">original_clip</code> variable to reference the original/input video stream</li>
                  <li>Full VapourSynth documentation: <a href="http://www.vapoursynth.com/doc/" target="_blank" rel="noopener noreferrer" className="text-accent-cyan hover:underline">vapoursynth.com</a></li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}