import React, { memo } from 'react';
import { Upload, Info, Loader2, XCircle, FileUp, X, AlertTriangle } from 'lucide-react';
import type { ModelImportProgress } from '../electron.d';
import type { ImportForm } from '../hooks/useModelImport';
import { getBackendDescriptor } from '../utils/backends';

// Shared recipes — see ActionBar.tsx / SettingsModal.tsx.
const LABEL = 'block text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 mb-1';
const INPUT = 'w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] placeholder-ink-500 focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50';
// Option buttons: selection is an accent fill, never a grey band + accent edge
const OPT = 'flex-1 h-7 px-2 rounded border text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const OPT_ON = 'border-transparent bg-accent-500/15 ring-1 ring-inset ring-accent-500/50 text-ink-100';
const OPT_OFF = 'bg-ink-850 border-ink-750 text-ink-300 hover:border-ink-700 hover:text-ink-200';

interface ImportModelModalProps {
  show: boolean;
  onClose: () => void;
  isImporting: boolean;
  importForm: ImportForm;
  setImportForm: React.Dispatch<React.SetStateAction<ImportForm>>;
  handleSelectOnnxFile: () => void;
  handleImportModel: () => void;
  handleCancelBuild: () => void;
  handleModelTypeChange: (modelType: 'vsr' | 'image') => void;
  handleShapeModeChange: (useStaticShape: boolean) => void;
  handleFp32Change: (useFp32: boolean) => void;
  handlePrecisionChange: (precision: 'fp16' | 'bf16' | 'fp32') => void;
  handleTemporalFramesChange: (temporalFrames: number) => void;
  importProgress: ModelImportProgress | null;
  mode: 'import' | 'build';
}

export const ImportModelModal = memo<ImportModelModalProps>(({
  show,
  onClose,
  isImporting,
  importForm,
  setImportForm,
  handleSelectOnnxFile,
  handleImportModel,
  handleCancelBuild,
  handleModelTypeChange,
  handleShapeModeChange,
  handleFp32Change,
  handlePrecisionChange,
  handleTemporalFramesChange,
  importProgress,
  mode,
}) => {
  if (!show) return null;

  const isBuilding = mode === 'build';
  const title = isBuilding ? 'Build Model' : 'Import Custom Model';
  const buttonText = isBuilding ? 'Build Model' : 'Import Model';
  // Capabilities of the form's target backend drive which options render
  const backend = getBackendDescriptor(importForm.backend);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <FileUp className="w-4 h-4 text-ink-500" />
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">{title}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isImporting}
            aria-label="Close"
            className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-3">
            {/* Top Row: ONNX File + Model Name */}
            <div className="grid grid-cols-2 gap-3">
              {/* ONNX File Selection */}
              <div>
                <label className={LABEL}>ONNX Model File</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={importForm.onnxPath}
                    readOnly
                    placeholder="No file selected"
                    className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] text-ink-300 placeholder-ink-500 focus:outline-none focus:border-accent-500 transition-colors"
                  />
                  <button
                    onClick={handleSelectOnnxFile}
                    disabled={isImporting}
                    className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Browse
                  </button>
                </div>
              </div>

              {/* Model Name */}
              <div>
                <label className={LABEL}>Model Name</label>
                <input
                  type="text"
                  value={importForm.modelName}
                  onChange={(e) => setImportForm(prev => ({ ...prev, modelName: e.target.value }))}
                  disabled={isImporting || isBuilding}
                  placeholder="e.g., my_custom_model"
                  className={INPUT}
                />
                <p className="text-[11px] text-ink-500 mt-1">This name will appear in the model dropdown</p>
              </div>
            </div>

            {/* Display Tag */}
            <div>
              <label className={LABEL}>Display Tag (Optional)</label>
              <input
                type="text"
                value={importForm.displayTag}
                onChange={(e) => setImportForm(prev => ({ ...prev, displayTag: e.target.value }))}
                disabled={isImporting}
                placeholder="e.g., Modern Anime, Old Anime, Realistic"
                className={INPUT}
              />
              <p className="text-[11px] text-ink-500 mt-1">Add a custom tag to help identify this model (e.g., &quot;Modern Anime&quot;)</p>
            </div>
          </div>

          {/* Configuration Switches - Horizontal Layout */}
          <section className="mt-2 border-t border-ink-700">
            <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
              <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">Configuration Switches</h3>
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-[11px] text-ink-500 mb-2.5">
                These switches automatically update the TensorRT command below with good defaults. You can manually edit the command if needed.
              </p>
              <div className="grid grid-cols-3 gap-3">
                {/* Model Type Toggle */}
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Model Type</p>
                  <p className="text-[11px] text-ink-500 mt-0.5 mb-1.5 min-h-[30px]">
                    {importForm.modelType === 'vsr' ? 'VSR (temporal/multi-frame)' : 'Image (single frame)'}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleModelTypeChange('image')}
                      disabled={isImporting}
                      className={`${OPT} ${
                        importForm.modelType === 'image'
                          ? OPT_ON
                          : OPT_OFF
                      }`}
                    >
                      Image
                    </button>
                    <button
                      onClick={() => handleModelTypeChange('vsr')}
                      disabled={isImporting}
                      className={`${OPT} ${
                        importForm.modelType === 'vsr'
                          ? OPT_ON
                          : OPT_OFF
                      }`}
                    >
                      VSR
                    </button>
                  </div>
                </div>

                {/* Shape Mode Toggle */}
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Shape Mode</p>
                  <p className="text-[11px] text-ink-500 mt-0.5 mb-1.5 min-h-[30px]">
                    {importForm.useStaticShape ? 'Static (single resolution)' : 'Dynamic (multiple resolutions)'}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleShapeModeChange(false)}
                      disabled={isImporting}
                      className={`${OPT} ${
                        !importForm.useStaticShape
                          ? OPT_ON
                          : OPT_OFF
                      }`}
                    >
                      Dynamic
                    </button>
                    <button
                      onClick={() => handleShapeModeChange(true)}
                      disabled={isImporting}
                      className={`${OPT} ${
                        importForm.useStaticShape
                          ? OPT_ON
                          : OPT_OFF
                      }`}
                    >
                      Static
                    </button>
                  </div>
                </div>

                {/* Precision Toggle */}
                <div>
                  <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">Precision</p>
                  <p className="text-[11px] text-ink-500 mt-0.5 mb-1.5 min-h-[30px]">
                    {!backend.requiresEngineBuild
                      ? (importForm.useFp32 ? 'FP32 (inference + RGB format)' : 'FP16 (inference + RGB format)')
                      : (importForm.useFp32 ? 'FP32 (build + inference)' : importForm.useBf16 ? 'BF16 (build + inference)' : 'FP16 (build + inference, recommended)')
                    }
                  </p>
                  {!backend.importPrecisions.includes('bf16') ? (
                    // Backends without BF16 builds: only FP16 and FP32
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handleFp32Change(false)}
                        disabled={isImporting}
                        className={`${OPT} ${
                          !importForm.useFp32
                            ? OPT_ON
                            : OPT_OFF
                        }`}
                      >
                        FP16
                      </button>
                      <button
                        onClick={() => handleFp32Change(true)}
                        disabled={isImporting}
                        className={`${OPT} ${
                          importForm.useFp32
                            ? OPT_ON
                            : OPT_OFF
                        }`}
                      >
                        FP32
                      </button>
                    </div>
                  ) : (
                    // TensorRT mode: FP16, BF16, and FP32
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handlePrecisionChange('fp16')}
                        disabled={isImporting}
                        className={`${OPT} ${
                          !importForm.useFp32 && !importForm.useBf16
                            ? OPT_ON
                            : OPT_OFF
                        }`}
                      >
                        FP16
                      </button>
                      <button
                        onClick={() => handlePrecisionChange('bf16')}
                        disabled={isImporting}
                        className={`${OPT} ${
                          !importForm.useFp32 && importForm.useBf16
                            ? OPT_ON
                            : OPT_OFF
                        }`}
                      >
                        BF16
                      </button>
                      <button
                        onClick={() => handlePrecisionChange('fp32')}
                        disabled={isImporting}
                        className={`${OPT} ${
                          importForm.useFp32
                            ? OPT_ON
                            : OPT_OFF
                        }`}
                      >
                        FP32
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Temporal Frames - Only show for VSR models */}
              {importForm.modelType === 'vsr' && (
                <div className="mt-3">
                  <label className={LABEL}>
                    Temporal Frames
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    step="2"
                    value={importForm.temporalFrames}
                    onChange={(e) => {
                      const value = parseInt(e.target.value, 10);
                      if (!Number.isNaN(value)) {
                        handleTemporalFramesChange(value);
                      }
                    }}
                    disabled={isImporting}
                    className={INPUT}
                  />
                  <p className="text-[11px] text-ink-500 mt-1">Number of frames used by the VSR model (default: 5)</p>
                </div>
              )}
            </div>
          </section>

          {/* Detection failed warning */}
          {importForm.detectionFailed && importForm.onnxPath && (
            <div className="flex items-center gap-2.5 px-4 py-2 mt-2 bg-warn-500/10 border-t border-warn-500/20">
              <AlertTriangle className="w-4 h-4 text-warn-400 flex-shrink-0" />
              <p className="text-[11.5px] text-warn-300/90">
                Automatic model detection failed. Please verify the settings above are correct.
              </p>
            </div>
          )}

          {/* Build command - only for backends with a custom build step */}
          {backend.supportsCustomBuildParams && (
            <section className="mt-2 border-t border-ink-700">
              <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
                <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Info className="w-3.5 h-3.5 text-ink-500" />
                  <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">TensorRT Build Command</h3>
                </div>
              </div>
              <div className="px-4 py-3">
                <p className="text-[11px] text-ink-500 mb-2.5">
                  This command is automatically generated based on the switches above. You can manually edit it if needed.
                </p>
                <div>
                  <label className={LABEL}>Engine Build Parameters (trtexec syntax)</label>
                  <textarea
                    value={importForm.customTrtexecParams}
                    onChange={(e) => setImportForm(prev => ({ ...prev, customTrtexecParams: e.target.value }))}
                    disabled={isImporting}
                    rows={3}
                    className="w-full bg-ink-850 border border-ink-750 rounded px-2 py-1.5 text-[12px] font-mono focus:outline-none focus:border-accent-500 transition-colors disabled:opacity-50 resize-y"
                  />
                  <p className="text-[11px] text-ink-500 mt-1.5">
                    Tip: Use OUTPUT_PATH as the placeholder for --saveEngine. The switches above will automatically update this command.
                  </p>
                </div>

                {/* Skip Validation Checkbox */}
                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="skipValidation"
                    checked={importForm.skipValidation}
                    onChange={(e) => setImportForm(prev => ({ ...prev, skipValidation: e.target.checked }))}
                    disabled={isImporting}
                    className="w-3.5 h-3.5 flex-shrink-0"
                  />
                  <label htmlFor="skipValidation" className="text-[12.5px] text-ink-300 cursor-pointer">
                    Skip ONNX validation
                  </label>
                  <span className="text-[11px] text-ink-500">(skips auto-detection and build-time validation)</span>
                </div>
              </div>
            </section>
          )}

          {/* ONNX-direct backend info */}
          {!backend.requiresEngineBuild && (
            <div className="flex items-start gap-2.5 px-4 py-2.5">
              <Info className="w-3.5 h-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
              <div className="text-[11px] text-ink-500 min-w-0">
                <p className="font-medium text-ink-400 mb-1">{backend.label} Mode</p>
                <p>
                  Model will be used directly with {backend.label} (no engine conversion needed). The precision toggle controls both the internal precision AND the RGB format (RGBS for FP32, RGBH for FP16).
                </p>
              </div>
            </div>
          )}

          {/* Progress */}
          {importProgress && (
            <div className={`relative mt-2 px-4 py-2.5 border-t ${
              importProgress.type === 'error'
                ? 'bg-bad-500/10 border-bad-500/30'
                : importProgress.type === 'complete'
                  ? 'bg-ok-500/10 border-ok-500/30'
                  : 'bg-warn-500/10 border-warn-500/30'
            }`}>
              <span
                className={`absolute top-0 left-0 h-[2px] transition-all duration-300 ${
                  importProgress.type === 'error'
                    ? 'bg-bad-500'
                    : importProgress.type === 'complete'
                      ? 'bg-ok-500'
                      : 'bg-warn-500'
                }`}
                style={{ width: `${importProgress.progress}%` }}
                role="progressbar"
                aria-valuenow={importProgress.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Model import progress"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-medium text-ink-200 truncate">{importProgress.message}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[12px] font-mono tabular-nums text-ink-400">{importProgress.progress}%</span>
                  {isImporting && importProgress.type === 'converting' && (
                    <button
                      onClick={handleCancelBuild}
                      className="h-[22px] px-2 rounded inline-flex items-center text-[11px] font-medium bg-transparent border border-bad-500/50 text-bad-400 hover:bg-bad-500/10 transition-colors"
                      title="Cancel engine build"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              {importProgress.type === 'error' && (
                <p className="text-bad-400 text-[11.5px] mt-1.5 flex items-center gap-1.5">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  {importProgress.message}
                </p>
              )}
            </div>
          )}

          {/* Validation Info */}
          <div className="flex items-start gap-2.5 px-4 py-3">
            <Info className="w-3.5 h-3.5 text-ink-500 flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-ink-500 min-w-0">
              <p className="font-medium text-ink-400 mb-1">Quick Tips:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>Use the switches above to quickly configure the model with good defaults</li>
                <li>The command textbox is automatically updated but remains editable for custom tweaks</li>
                {backend.requiresEngineBuild && (
                  <>
                    <li>FP16 is recommended for optimal performance and smaller model size</li>
                    <li>Dynamic shapes support multiple resolutions but take longer to build</li>
                    <li>TensorRT conversion may take 5-15 minutes depending on your GPU</li>
                    <li>Precision is baked into the TensorRT engine during build</li>
                  </>
                )}
              </ul>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-t border-ink-800">
          <button
            onClick={onClose}
            disabled={isImporting}
            className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleImportModel}
            disabled={isImporting || !importForm.onnxPath || !importForm.modelName}
            className="flex-1 h-8 px-3 rounded-md inline-flex items-center justify-center gap-2 text-[12.5px] font-semibold bg-accent-500 border border-accent-500 text-accent-ink hover:bg-accent-400 transition-colors disabled:bg-ink-800 disabled:border-ink-750 disabled:text-ink-600 disabled:cursor-not-allowed"
          >
            {isImporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {isBuilding ? 'Building...' : 'Importing...'}
              </>
            ) : (
              <>
                <FileUp className="w-4 h-4" />
                {buttonText}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
