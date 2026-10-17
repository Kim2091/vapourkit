import type { DragEvent } from 'react';
import { GripVertical, X, ChevronDown, ChevronUp, Save, Trash2, Download, Filter as LucideFilter, Sparkles, Copy, Crop, Palette, Edit3 } from 'lucide-react';
import type { BackendId, FilterBackend, Filter, FilterTemplate, ModelFile } from '../electron.d';
import { BACKENDS, getBackendDescriptor } from '../utils/backends';
import { PythonCodeEditor } from './PythonCodeEditor';
import { CreateLutCard, LoadLutCard } from './LutStepCards';
import { StageSourceCard } from './StageSourceCard';
import { SaveTemplateForm, type SaveTemplateFields } from './SaveTemplateForm';
import type { LutPanelActions } from './DynamicFilterPanel';

/** What the generic editor button says, per editor kind. */
const EDITOR_TITLES: Record<string, string> = {
  colorGrade: 'Open the grading dock',
  crop: 'Open visual crop editor',
};

const EDITOR_LABELS: Record<string, string> = {
  colorGrade: 'Open grade',
  crop: 'Edit crop',
};

/**
 * Icon button sized to sit inline with a 28px picker. Both filter branches put
 * their actions on the picker row rather than in a labelled row of their own —
 * that row cost ~28px per expanded filter to say what a tooltip already does.
 */
const PICKER_ACTION =
  'h-7 w-7 grid place-items-center rounded border border-ink-750 bg-ink-850 flex-shrink-0 ' +
  'transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500';

type ParameterValue = NonNullable<Filter['parameters']>[string];

/** What every step card shares: the panel's settings and what it can do. */
export interface StepCardContext {
  isProcessing: boolean;
  availableModels: ModelFile[];
  filterTemplates: FilterTemplate[];
  categorySuggestions: string[];
  defaultBackend: BackendId;
  defaultNumStreams: number;
  showBackendOverrides: boolean;
  lut?: LutPanelActions;
  onImportClick?: () => void;
  canSaveTemplate: boolean;
  canDeleteTemplate: boolean;
  canOpenEditor: boolean;
}

/** The panel's handlers a step card calls, each naming the step by id. */
export interface StepCardActions {
  hoverHandle: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  toggle: (id: string, enabled: boolean) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  openModelSelector: (id: string) => void;
  openFilterSelector: (id: string) => void;
  setBackend: (id: string, backend: FilterBackend) => void;
  setStreams: (id: string, value: number | undefined) => void;
  toggleSaveForm: (id: string) => void;
  saveTemplate: (id: string, fields: SaveTemplateFields) => void;
  importTemplate: () => void;
  editTemplate: (template: FilterTemplate | null) => void;
  deleteTemplate: (name: string, id: string) => void;
  setParameters: (id: string, changes: NonNullable<Filter['parameters']>) => void;
  setParameter: (id: string, name: string, value: ParameterValue) => void;
  addLoader: (markerId: string) => void;
  openEditor: (filter: Filter, template?: FilterTemplate) => void;
  changeCode: (id: string, code: string) => void;
  commitCode: () => void;
}

interface StepCardProps {
  filter: Filter;
  /** The step's number or side-chain tag in the rail. */
  tag: string;
  /** The step is in a side chain, so it is indented under its Load Video. */
  inSide: boolean;
  /** The whole chain, for the cards that pick another step. */
  steps: Filter[];
  isExpanded: boolean;
  isDragging: boolean;
  isHovered: boolean;
  isNewlyDuplicated: boolean;
  /** A dragged step would land here. */
  dropTarget: boolean;
  saveFormOpen: boolean;
  context: StepCardContext;
  actions: StepCardActions;
  drag: {
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
}

/** One AI model or VapourSynth filter step in the chain. */
export function StepCard({
  filter,
  tag,
  inSide,
  steps,
  isExpanded,
  isDragging,
  isHovered,
  isNewlyDuplicated,
  dropTarget,
  saveFormOpen,
  context,
  actions,
  drag,
}: StepCardProps) {
  const {
    isProcessing,
    availableModels,
    filterTemplates,
    categorySuggestions,
    defaultBackend,
    defaultNumStreams,
    showBackendOverrides,
    lut,
    onImportClick,
    canSaveTemplate,
    canDeleteTemplate,
    canOpenEditor,
  } = context;
  const selectedTemplate = filterTemplates.find(t => t.name === filter.preset);
  const isAIModel = filter.filterType === 'aiModel';
  const interactiveEditor = filter.editor ?? selectedTemplate?.editor;
  const declaredVariables = filter.variables ?? selectedTemplate?.variables;
  // Only the ones a person sets. A step id, a generated path or a
  // fingerprint is the app's to keep, and a text box holding it is an
  // invitation to break a step that was working.
  const exposedVariables = Object.entries(declaredVariables ?? {})
    .filter(([, variable]) => !variable.hidden);

  return (
    <div
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
      className={`relative m-1.5 rounded ${inSide ? 'ml-7' : ''} ${
        isDragging ? 'opacity-40 scale-95' : 'opacity-100 scale-100'
      } ${
        isHovered && !isDragging ? 'scale-[1.01] transition-transform duration-200' : ''
      } ${
        !isDragging ? 'transition-opacity duration-200' : ''
      } ${
        isNewlyDuplicated ? 'animate-[highlight_0.33s_ease-in-out] bg-accent-500/20 border-accent-500/50 border-2 shadow-lg shadow-accent-500/50 transition-all duration-200' : ''
      }`}
    >
      {/* A side chain's steps hang off its Load Video on a guide line */}
      {inSide && (
        <div className="absolute -left-3.5 -top-1.5 -bottom-1.5 w-0.5 bg-chain-500/35 rounded-full" aria-hidden="true" />
      )}

      {/* Drop indicator */}
      {dropTarget && !isDragging && (
        <div className="absolute -top-1.5 left-0 right-0 h-0.5 bg-accent-500 rounded-full shadow-lg shadow-accent-500/50 z-10" />
      )}

      <div className={`bg-ink-900 rounded border border-ink-800 border-l-2 transition-colors ${
        filter.enabled
          ? isAIModel
            ? isExpanded ? 'border-l-accent-500' : 'border-l-accent-500/70'
            : isExpanded ? 'border-l-ink-500' : 'border-l-ink-700'
          : 'border-l-transparent opacity-50'
      } ${
        isHovered && !isDragging ? 'bg-ink-850' : ''
      }`}>
        {/* Filter Header */}
        <div 
          draggable={!isProcessing}
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          className={`flex items-center gap-2.5 px-3 py-1.5 transition-colors cursor-grab active:cursor-grabbing rounded-t-[3px] ${
            isExpanded
              ? 'bg-ink-850 sticky top-9 z-[5]'
              : 'rounded-b-[3px] hover:bg-ink-850/60'
          }`}
        >
          {/* Filter Order Number */}
          <div className={`flex-shrink-0 min-w-5 h-5 px-0.5 rounded ${
            isAIModel ? 'bg-accent-500/20 border-accent-500/45' : inSide ? 'bg-chain-500/10 border-chain-600/50' : 'bg-ink-800 border-ink-700'
          } border flex items-center justify-center`}>
            <span className={`text-xs font-bold ${isAIModel ? 'text-accent-400' : inSide ? 'text-chain-300' : 'text-ink-400'}`}>
              {tag}
            </span>
          </div>

          {/* Drag Handle */}
          <div
            className="text-ink-500 hover:text-accent-400 transition-colors flex-shrink-0 relative group pointer-events-none"
            onMouseEnter={() => actions.hoverHandle(filter.id)}
            onMouseLeave={() => actions.hoverHandle(null)}
          >
            <GripVertical className="w-4 h-4" />
          </div>

          {/* Filter Icon */}
          {isAIModel && (
            <Sparkles className="w-4 h-4 text-accent-400 flex-shrink-0" />
          )}

          {/* Filter Title - Clickable to expand */}
          <button
            onClick={() => filter.enabled && actions.toggleExpanded(filter.id)}
            disabled={!filter.enabled}
            className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity disabled:opacity-50 min-w-0"
          >
            <span className={`text-[12.5px] font-medium truncate ${isExpanded ? 'text-ink-100' : 'text-ink-200'}`}>
              {isAIModel
                ? (availableModels.find(m => m.path === filter.modelPath)?.name || 'Select AI Model')
                : (filter.preset || 'Custom Filter')
              }
            </span>
            {/* Backend override badge - only when this filter deviates from the app default */}
            {isAIModel && filter.backend && filter.backend !== 'auto' && (
              <span
                className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent-500/20 border border-accent-500/40 text-accent-300"
                title={`Backend override: ${getBackendDescriptor(filter.backend).label}`}
              >
                {getBackendDescriptor(filter.backend).shortLabel}
              </span>
            )}
            {/* Streams override badge */}
            {isAIModel && filter.numStreams != null && (
              <span
                className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-accent-500/20 border border-accent-500/40 text-accent-300 tabular-nums"
                title={`num_streams override: ${filter.numStreams}`}
              >
                {filter.numStreams}s
              </span>
            )}
            {filter.enabled && (
              isExpanded 
                ? <ChevronUp className="w-4 h-4 ml-auto flex-shrink-0 text-ink-400" /> 
                : <ChevronDown className="w-4 h-4 ml-auto flex-shrink-0 text-ink-400" />
            )}
          </button>

          {/* Enable Checkbox */}
          <input
            type="checkbox"
            checked={filter.enabled}
            onChange={(e) => actions.toggle(filter.id, e.target.checked)}
            disabled={isProcessing}
            className={`w-4 h-4 rounded border-ink-600 bg-ink-700 ${
              isAIModel ? 'focus:ring-accent-500' : 'focus:ring-ink-500'
            } focus:ring-2 focus:ring-offset-0 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0`}
            title={filter.enabled ? "Disable filter" : "Enable filter"}
          />

          {/* Duplicate Button */}
          <button
            onClick={() => actions.duplicate(filter.id)}
            disabled={isProcessing}
            className="text-accent-400 hover:text-accent-300 hover:bg-accent-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title="Duplicate filter"
          >
            <Copy className="w-4 h-4" />
          </button>

          {/* Remove Button */}
          <button
            onClick={() => actions.remove(filter.id)}
            disabled={isProcessing}
            className="text-bad-400 hover:text-bad-300 hover:bg-bad-900/30 p-1 rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title="Remove filter"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filter Content - AI Model or Custom */}
        {filter.enabled && isExpanded && (
          <div className="px-3 pb-2.5 space-y-2.5 border-t border-ink-800 pt-2.5">
            {isAIModel ? (
              // AI Model Filter Content
              <>
                <div className="space-y-2">
                  {/* Model picker, with import riding the same row — the
                      same shape as the custom branch's template row. */}
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => !isProcessing && actions.openModelSelector(filter.id)}
                      disabled={isProcessing}
                      className={`flex-1 min-w-0 h-7 bg-ink-850 border rounded px-2 text-[12.5px] text-left truncate focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        filter.modelPath
                          ? 'border-accent-500/50 text-ink-200 hover:border-accent-500'
                          : 'border-ink-600 text-ink-400 hover:border-ink-500'
                      }`}
                    >
                      {filter.modelPath
                        ? (availableModels.find(m => m.path === filter.modelPath)?.name || 'Unknown Model')
                        : 'Select a model...'
                      }
                    </button>
                    {onImportClick && (
                      <button
                        onClick={onImportClick}
                        disabled={isProcessing}
                        title="Import a model from a file"
                        className={`${PICKER_ACTION} text-ink-400 hover:text-accent-400 hover:border-ink-700`}
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {/* Backend override - 'auto' inherits the app default.
                      Hidden unless enabled in Settings, but always shown
                      when an override is active so it stays clearable. */}
                  {(showBackendOverrides || (filter.backend && filter.backend !== 'auto') || filter.numStreams != null) && (
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Backend</label>
                    <select
                      value={filter.backend && filter.backend !== 'auto' ? filter.backend : 'auto'}
                      onChange={(e) => actions.setBackend(filter.id, e.target.value as FilterBackend)}
                      disabled={isProcessing}
                      className="flex-1 bg-ink-850 border border-ink-750 rounded h-6 px-1.5 text-[11px] text-ink-300 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="auto">Auto ({getBackendDescriptor(defaultBackend).label})</option>
                      {BACKENDS.map(backend => (
                        <option key={backend.id} value={backend.id}>{backend.label}</option>
                      ))}
                    </select>
                    <label className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Streams</label>
                    <select
                      value={filter.numStreams ?? 'auto'}
                      onChange={(e) => actions.setStreams(filter.id, e.target.value === 'auto' ? undefined : Number(e.target.value))}
                      disabled={isProcessing}
                      title="Parallel inference streams for this model. Higher can be faster on high-end GPUs; TensorRT backend only."
                      className="w-[76px] flex-shrink-0 bg-ink-850 border border-ink-750 rounded h-6 px-1.5 text-[11px] text-ink-300 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="auto">Auto ({defaultNumStreams})</option>
                      {[1, 2, 3, 4].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>
                  )}
                </div>
              </>
            ) : (
              // Custom Filter Content
              <>
                {/* Template picker, with save / import / delete riding the
                    same row. Delete is last and separated by its colour, so
                    it no longer reads as a second "delete this filter"
                    beside the X in the row header. */}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => actions.openFilterSelector(filter.id)}
                    disabled={isProcessing}
                    className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-ink-200 text-left flex items-center justify-between gap-2 hover:border-ink-700"
                  >
                    <span className={`truncate ${filter.preset ? 'text-ink-200' : 'text-ink-500'}`}>
                      {filter.preset || 'Custom - Click to select template'}
                    </span>
                    <LucideFilter className="w-4 h-4 text-ink-400 flex-shrink-0" />
                  </button>
                  {canSaveTemplate && (
                    <>
                      <button
                        onClick={() => actions.toggleSaveForm(filter.id)}
                        disabled={isProcessing}
                        title={filter.preset ? `Save changes to “${filter.preset}”, or as a new template` : 'Save this filter as a template'}
                        className={`${PICKER_ACTION} ${
                          saveFormOpen
                            ? 'text-accent-400 border-accent-500/50 bg-accent-500/15'
                            : 'text-ink-400 hover:text-accent-400 hover:border-ink-700'
                        }`}
                      >
                        <Save className="w-4 h-4" />
                      </button>
                      <button
                        onClick={actions.importTemplate}
                        disabled={isProcessing}
                        title="Import a template from a file"
                        className={`${PICKER_ACTION} text-ink-400 hover:text-accent-400 hover:border-ink-700`}
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {filter.preset && canSaveTemplate && filterTemplates.some(t => t.name === filter.preset) && (
                    <button
                      onClick={() => actions.editTemplate(filterTemplates.find(t => t.name === filter.preset) ?? null)}
                      disabled={isProcessing}
                      title={`Edit the “${filter.preset}” filter: rename it, or change its code, description or categories`}
                      className={`${PICKER_ACTION} text-ink-400 hover:text-accent-400 hover:border-ink-700`}
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                  )}
                  {filter.preset && canDeleteTemplate && (
                    <button
                      onClick={() => actions.deleteTemplate(filter.preset!, filter.id)}
                      disabled={isProcessing}
                      title={`Delete the “${filter.preset}” template`}
                      className={`${PICKER_ACTION} text-bad-400 hover:bg-bad-900/30 hover:border-bad-600`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* A .vkfilter opts into a visual editor with [editor]
                    metadata. The button is intentionally generic here;
                    the preview surface selects the matching editor type. */}
                {/* The two LUT steps live entirely in their cards.
                    Neither has a surface to open: a Create LUT has
                    nothing to set, and a Load LUT's one choice is a
                    dropdown. Generating happens here too, beside the
                    step it is for. So does a stage reference, which is
                    a dropdown and nothing else. */}
                {interactiveEditor?.type === 'lutSource' && lut ? (
                  <LoadLutCard
                    filter={filter}
                    filters={steps}
                    disabled={isProcessing}
                    job={lut.jobs[filter.id]}
                    previewOpen={lut.previewOpen}
                    onChoose={(source, path) => {
                      // A new source means the old table is not for
                      // it, whatever it was. Both go, in one update.
                      lut.clear(filter.id);
                      actions.setParameters(filter.id, { source_id: source, lut_path: path, generated_key: '' });
                    }}
                    onPickFile={lut.pickFile}
                    onGenerate={() => lut.restore(filter.id)}
                  />
                ) : interactiveEditor?.type === 'createLut' && lut ? (
                  <CreateLutCard
                    filter={filter}
                    filters={steps}
                    disabled={isProcessing}
                    job={lut.jobs[filter.id]}
                    previewOpen={lut.previewOpen}
                    canAddLoader={filterTemplates.some(t => t.name === 'Load LUT')}
                    onAddLoader={() => actions.addLoader(filter.id)}
                    onBake={() => lut.bake(filter.id)}
                  />
                ) : interactiveEditor?.type === 'stageSource' ? (
                  <StageSourceCard
                    filter={filter}
                    filters={steps}
                    variable={interactiveEditor.variables.source}
                    label={interactiveEditor.label}
                    disabled={isProcessing}
                    onChoose={(source) => actions.setParameter(
                      filter.id, interactiveEditor.variables.source, source,
                    )}
                    onPickVideo={interactiveEditor.videoFile
                      ? () => window.electronAPI.selectReferenceVideo()
                      : undefined}
                  />
                ) : interactiveEditor && canOpenEditor && interactiveEditor.type in EDITOR_LABELS && (
                  <button
                    onClick={() => actions.openEditor(filter, selectedTemplate)}
                    disabled={isProcessing}
                    className="w-full h-7 px-2 rounded inline-flex items-center justify-center gap-1.5 text-[11.5px] font-semibold bg-accent-500/10 border border-accent-500/40 text-accent-300 hover:bg-accent-500/20 hover:border-accent-500/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={interactiveEditor.label || EDITOR_TITLES[interactiveEditor.type]}
                  >
                    {interactiveEditor.type === 'colorGrade' ? <Palette className="w-3.5 h-3.5" /> : <Crop className="w-3.5 h-3.5" />}
                    {interactiveEditor.label || EDITOR_LABELS[interactiveEditor.type]}
                  </button>
                )}

                {/* Template variables are intentionally surfaced in the
                    normal filter panel too: the visual editor is an
                    accelerator, while values remain inspectable and
                    editable in a saved .vkfilter configuration. */}
                {exposedVariables.length > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 rounded-md border border-ink-800 bg-ink-950/40 p-2">
                    {exposedVariables.map(([name, variable]) => {
                      const value = filter.parameters?.[name] ?? variable.default ?? '';
                      return (
                        <label key={name} className="min-w-0" title={variable.description}>
                          <span className="mb-0.5 block truncate text-[10px] font-display font-semibold uppercase tracking-[0.07em] text-ink-500">{name}</span>
                          {variable.type === 'boolean' ? (
                            <select
                              value={value === true ? 'true' : 'false'}
                              onChange={(event) => actions.setParameter(filter.id, name, event.target.value === 'true')}
                              disabled={isProcessing}
                              className="h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] text-ink-200 focus:outline-none focus:border-accent-500 disabled:opacity-50"
                            >
                              <option value="true">True</option>
                              <option value="false">False</option>
                            </select>
                          ) : (
                            <input
                              type={variable.type === 'number' ? 'number' : 'text'}
                              value={String(value)}
                              onChange={(event) => {
                                const nextValue = variable.type === 'number' ? Number(event.target.value) : event.target.value;
                                if (variable.type !== 'number' || Number.isFinite(nextValue)) {
                                  actions.setParameter(filter.id, name, nextValue);
                                }
                              }}
                              disabled={isProcessing}
                              className="h-6 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-[11px] tabular-nums text-ink-200 focus:outline-none focus:border-accent-500 disabled:opacity-50"
                            />
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}

                {saveFormOpen && (
                  <SaveTemplateForm
                    existing={filter.preset ? selectedTemplate : undefined}
                    categorySuggestions={categorySuggestions}
                    onSave={fields => actions.saveTemplate(filter.id, fields)}
                    onCancel={() => actions.toggleSaveForm(filter.id)}
                  />
                )}

                {/* Description */}
                {selectedTemplate?.description && (
                  <div className="p-2 bg-ink-900 rounded border border-ink-800">
                    <p className="text-[11.5px] text-ink-400 leading-snug">{selectedTemplate.description}</p>
                  </div>
                )}

                {/* Code Editor */}
                <div className="relative rounded-md overflow-hidden border border-ink-600" onMouseDown={(e) => e.stopPropagation()} style={{ contain: 'layout' }}>
                  <PythonCodeEditor
                    value={filter.code || ''}
                    onChange={(code) => actions.changeCode(filter.id, code)}
                    onBlur={actions.commitCode}
                    disabled={isProcessing}
                    placeholder="# Enter custom VapourSynth code here&#10;# Example: clip = core.resize.Bilinear(clip, width=720, height=540)"
                    minHeight="120px"
                    className=""
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
