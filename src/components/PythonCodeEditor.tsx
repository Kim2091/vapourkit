import { useEffect, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { EditorView, Decoration, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

interface PythonCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  minHeight?: string;
  className?: string;
}

// Widget for clickable links
class LinkWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  toDOM() {
    const link = document.createElement('a');
    link.href = this.url;
    link.textContent = this.url;
    link.className = 'text-blue-400 hover:text-blue-300 underline cursor-pointer';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.onclick = (e) => {
      e.stopPropagation();
    };
    return link;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown' || event.type === 'click';
  }
}

// Plugin to detect and make links clickable
const linkPlugin = ViewPlugin.fromClass(
  class {
    decorations: any;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView) {
      const decorations = [];
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      
      for (let { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let match;
        
        while ((match = urlRegex.exec(text)) !== null) {
          const start = from + match.index;
          const end = start + match[0].length;
          
          decorations.push(
            Decoration.replace({
              widget: new LinkWidget(match[0]),
            }).range(start, end)
          );
        }
      }
      
      return Decoration.set(decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export function PythonCodeEditor({
  value,
  onChange,
  onBlur,
  disabled = false,
  placeholder = '# Enter custom VapourSynth code here\n# Example: clip = core.resize.Bilinear(clip, width=720, height=540)',
  minHeight = '120px',
  className = '',
}: PythonCodeEditorProps) {
  const editorRef = useRef<any>(null);

  // Create custom dark theme with syntax highlighting
  const customDarkTheme = EditorView.theme({
    '&': {
      fontSize: '14px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      backgroundColor: '#0f1419 !important',
      color: '#ffffff',
    },
    '.cm-content': {
      minHeight: minHeight,
      padding: '0',
      backgroundColor: '#0f1419 !important',
      caretColor: '#fff',
    },
    '.cm-line': {
      padding: '0 4px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      background: 'rgba(59, 130, 246, 0.5) !important',
    },
    '.cm-content ::selection': {
      background: 'rgba(59, 130, 246, 0.5) !important',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'rgba(59, 130, 246, 0.25) !important',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      maxHeight: '400px',
      backgroundColor: '#0f1419 !important',
    },
    '.cm-gutters': {
      backgroundColor: '#0a0e14',
      borderRight: '1px solid rgba(255, 255, 255, 0.1)',
      color: '#4a5568',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
    },
    '.cm-cursor': {
      borderLeftColor: '#fff',
    },
    '.cm-variable, .cm-variableName, .cm-property': {
      color: '#ffffff !important',
    },
  }, { dark: true });

  // Syntax highlighting colors using proper HighlightStyle
  const customHighlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: '#c678dd' },
    { tag: [t.name, t.deleted, t.character, t.macroName], color: '#ffffff' },
    { tag: [t.variableName, t.propertyName, t.attributeName], color: '#ffffff' },
    { tag: [t.function(t.variableName), t.labelName], color: '#61afef' },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#d19a66' },
    { tag: [t.definition(t.name), t.separator, t.definition(t.variableName)], color: '#ffffff' },
    { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#d19a66' },
    { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#56b6c2' },
    { tag: [t.meta, t.comment], color: '#5c6370', fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.link, color: '#61afef', textDecoration: 'underline' },
    { tag: t.heading, fontWeight: 'bold', color: '#e06c75' },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#d19a66' },
    { tag: [t.processingInstruction, t.string, t.inserted], color: '#98c379' },
    { tag: t.invalid, color: '#ff0000' },
  ]);

  // Create extensions array
  const extensions: Extension[] = [
    python(),
    linkPlugin,
    EditorView.lineWrapping,
    customDarkTheme,
    syntaxHighlighting(customHighlightStyle),
  ];

  // Handle auto-resize
  useEffect(() => {
    if (editorRef.current) {
      const element = editorRef.current.view?.dom;
      if (element) {
        const scroller = element.querySelector('.cm-scroller');
        if (scroller) {
          scroller.style.maxHeight = '400px';
        }
      }
    }
  }, [value]);

  return (
    <div className={`codemirror-wrapper ${className}`}>
      <CodeMirror
        ref={editorRef}
        value={value}
        height="auto"
        extensions={extensions}
        onChange={onChange}
        onBlur={onBlur}
        editable={!disabled}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          foldGutter: false,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          rectangularSelection: true,
          crosshairCursor: true,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          closeBracketsKeymap: true,
          searchKeymap: true,
          foldKeymap: false,
          completionKeymap: true,
          lintKeymap: true,
          drawSelection: true,
        }}
        placeholder={placeholder}
        style={{
          opacity: disabled ? 0.5 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
      />
    </div>
  );
}
