import { useEffect } from 'react';

interface UseUndoRedoShortcutsProps {
  onUndo: () => void;
  onRedo: () => void;
  enabled?: boolean;
}

/**
 * Hook to handle global undo/redo keyboard shortcuts (CTRL+Z, CTRL+Y)
 * Automatically excludes text inputs, textareas, and code editors to prevent interference
 */
export function useUndoRedoShortcuts({ onUndo, onRedo, enabled = true }: UseUndoRedoShortcutsProps) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if CTRL (or CMD on Mac) is pressed
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      
      if (!isCtrlOrCmd) return;

      // Get the active element
      const activeElement = document.activeElement;
      
      // List of elements where we should NOT intercept undo/redo
      const isTextInput = 
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute('contenteditable') === 'true' ||
        activeElement?.classList.contains('cm-content') || // CodeMirror editor
        activeElement?.closest('.cm-editor') !== null || // Inside CodeMirror editor
        activeElement?.closest('[contenteditable="true"]') !== null;

      // If user is in a text input, let the browser handle it naturally
      if (isTextInput) {
        return;
      }

      // Handle CTRL+Z (Undo)
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        e.stopPropagation();
        onUndo();
        return;
      }

      // Handle CTRL+Y (Redo)
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        e.stopPropagation();
        onRedo();
        return;
      }

      // Also support CTRL+SHIFT+Z as an alternative to CTRL+Y for redo
      if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        onRedo();
        return;
      }
    };

    // Use capture phase to ensure we catch the event before other handlers
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onUndo, onRedo, enabled]);
}
