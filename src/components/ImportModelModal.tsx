import React from 'react';
import { Upload, Info, Loader2, XCircle, FileUp, X } from 'lucide-react';
import type { ModelImportProgress } from '../electron.d';

interface ImportModelModalProps {
  show: boolean;
  onClose: () => void;
  isImporting: boolean;
  importForm: {
    onnxPath: string;
    modelName: string;
    minShapes: string;
    optShapes: string;
    maxShapes: string;
    useFp32: boolean;
    modelType: 'tspan' | 'image';
    useDirectML: boolean;
    displayTag: string;
    useStaticShape: boolean;
    useCustomTrtexecParams: boolean;
    customTrtexecParams: string;
  };
  setImportForm: React.Dispatch<React.SetStateAction<{
    onnxPath: string;
    modelName: string;
    minShapes: string;
    optShapes: string;
    maxShapes: string;
    useFp32: boolean;
    modelType: 'tspan' | 'image';
    useDirectML: boolean;
    displayTag: string;
    useStaticShape: boolean;
    useCustomTrtexecParams: boolean;
    customTrtexecParams: string;
  }>>;
  handleSelectOnnxFile: () => void;
  handleImportModel: () => void;
  handleModelTypeChange: (modelType: 'tspan' | 'image') => void;
  handleShapeModeChange: (useStaticShape: boolean) => void;
  handleFp32Change: (useFp32: boolean) => void;
  importProgress: ModelImportProgress | null;
  mode: 'import' | 'build';
  useDirectML: boolean;
}

export const ImportModelModal: React.FC<ImportModelModalProps> = ({
  show,
  onClose,
  isImporting,
  importForm,
  setImportForm,
  handleSelectOnnxFile,
  handleImportModel,
  handleModelTypeChange,
  handleShapeModeChange,
  handleFp32Change,
  importProgress,
  mode,
}) => {
  if (!show) return null;

  const isBuilding = mode === 'build';
  const title = isBuilding ? 'Build Model' : 'Import Custom Model';
  const buttonText = isBuilding ? 'Build Model' : 'Import Model';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-elevated rounded-2xl border border-gray-800 shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <FileUp className="w-6 h-6 text-primary-purple" />
            <h2 className="text-2xl font-bold">{title}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isImporting}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Top Row: ONNX File + Model Name */}
          <div className="grid grid-cols-2 gap-4">
            {/* ONNX File Selection */}
            <div>
              <label className="block text-sm font-medium mb-2">ONNX Model File</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={importForm.onnxPath}
                  readOnly
                  placeholder="No file selected"
                  className="flex-1 bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
                />
                <button
                  onClick={handleSelectOnnxFile}
                  disabled={isImporting}
                  className="bg-primary-blue hover:bg-blue-600 disabled:bg-gray-700 text-white font-semibold px-3 py-2 rounded-lg transition-all flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  Browse
                </button>
              </div>
            </div>

            {/* Model Name */}
            <div>
              <label className="block text-sm font-medium mb-2">Model Name</label>
              <input
                type="text"
                value={importForm.modelName}
                onChange={(e) => setImportForm(prev => ({ ...prev, modelName: e.target.value }))}
                disabled={isImporting || isBuilding}
                placeholder="e.g., my_custom_model"
                className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-blue disabled:opacity-50"
              />
              <p className="text-xs text-gray-500 mt-1">This name will appear in the model dropdown</p>
            </div>
          </div>

          {/* Display Tag */}
          <div>
            <label className="block text-sm font-medium mb-2">Display Tag (Optional)</label>
            <input
              type="text"
              value={importForm.displayTag}
              onChange={(e) => setImportForm(prev => ({ ...prev, displayTag: e.target.value }))}
              disabled={isImporting}
              placeholder="e.g., Modern Anime, Old Anime, Realistic"
              className="w-full bg-dark-surface border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-blue disabled:opacity-50"
            />
            <p className="text-xs text-gray-500 mt-1">Add a custom tag to help identify this model (e.g., &quot;Modern Anime&quot;)</p>
          </div>

          {/* Configuration Switches - Horizontal Layout */}
          <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
            <label className="block text-sm font-medium mb-2">Configuration Switches</label>
            <p className="text-xs text-gray-400 mb-3">
              These switches automatically update the TensorRT command below with good defaults. You can manually edit the command if needed.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {/* Model Type Toggle */}
              <div className="bg-dark-bg rounded-lg p-3">
                <div className="mb-2">
                  <p className="text-sm font-medium text-white">Model Type</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {importForm.modelType === 'tspan' ? 'TSPAN (5-frame temporal)' : 'Image (single frame)'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleModelTypeChange('image')}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      importForm.modelType === 'image'
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    Image
                  </button>
                  <button
                    onClick={() => handleModelTypeChange('tspan')}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      importForm.modelType === 'tspan'
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    TSPAN
                  </button>
                </div>
              </div>

              {/* Shape Mode Toggle */}
              <div className="bg-dark-bg rounded-lg p-3">
                <div className="mb-2">
                  <p className="text-sm font-medium text-white">Shape Mode</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {importForm.useStaticShape ? 'Static (single resolution)' : 'Dynamic (multiple resolutions)'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleShapeModeChange(false)}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      !importForm.useStaticShape
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    Dynamic
                  </button>
                  <button
                    onClick={() => handleShapeModeChange(true)}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      importForm.useStaticShape
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    Static
                  </button>
                </div>
              </div>

              {/* Precision Toggle */}
              <div className="bg-dark-bg rounded-lg p-3">
                <div className="mb-2">
                  <p className="text-sm font-medium text-white">Precision</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {importForm.useDirectML 
                      ? (importForm.useFp32 ? 'FP32 (inference + RGB format)' : 'FP16 (inference + RGB format)')
                      : (importForm.useFp32 ? 'FP32 (build + inference)' : 'FP16 (build + inference, recommended)')
                    }
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleFp32Change(false)}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      !importForm.useFp32
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    FP16
                  </button>
                  <button
                    onClick={() => handleFp32Change(true)}
                    disabled={isImporting}
                    className={`flex-1 px-2 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 ${
                      importForm.useFp32
                        ? 'bg-primary-blue text-white'
                        : 'bg-dark-elevated text-gray-400 hover:text-white'
                    }`}
                  >
                    FP32
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* TensorRT Build Command - Only show in TensorRT mode */}
          {!importForm.useDirectML && (
            <div className="bg-dark-surface rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Info className="w-4 h-4 text-accent-cyan" />
                TensorRT Build Command
              </h3>
              <p className="text-xs text-gray-400 mb-3">
                This command is automatically generated based on the switches above. You can manually edit it if needed.
              </p>
              <div>
                <label className="block text-xs font-medium mb-1.5 text-gray-400">trtexec Parameters</label>
                <textarea
                  value={importForm.customTrtexecParams}
                  onChange={(e) => setImportForm(prev => ({ ...prev, customTrtexecParams: e.target.value }))}
                  disabled={isImporting}
                  rows={3}
                  className="w-full bg-dark-bg border border-gray-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-primary-blue disabled:opacity-50 resize-y"
                />
                <p className="text-xs text-gray-400 mt-2">
                  💡 Tip: Use OUTPUT_PATH as the placeholder for --saveEngine. The switches above will automatically update this command.
                </p>
              </div>
            </div>
          )}

          {/* DirectML FP32 Option */}
          {importForm.useDirectML && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-gray-300">
                  <p className="font-medium mb-1">DirectML Mode</p>
                  <p className="text-xs text-gray-400">
                    Model will be used directly with DirectML (no TensorRT conversion needed). The precision toggle controls both the DirectML internal precision AND the RGB format (RGBS for FP32, RGBH for FP16).
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Progress */}
          {importProgress && (
            <div className="bg-dark-surface rounded-lg p-3 border border-gray-700">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-medium">{importProgress.message}</span>
                <span className="text-sm text-gray-400">{importProgress.progress}%</span>
              </div>
              <div className="w-full bg-dark-bg rounded-full h-1.5">
                <div 
                  className="bg-gradient-to-r from-primary-blue to-primary-purple h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${importProgress.progress}%` }}
                />
              </div>
              {importProgress.type === 'error' && (
                <p className="text-red-400 text-sm mt-1.5 flex items-center gap-2">
                  <XCircle className="w-4 h-4" />
                  {importProgress.message}
                </p>
              )}
            </div>
          )}

          {/* Validation Info */}
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-gray-300">
                <p className="font-medium mb-1">Quick Tips:</p>
                <ul className="list-disc list-inside space-y-1 text-xs text-gray-400">
                  <li>Use the switches above to quickly configure the model with good defaults</li>
                  <li>The command textbox is automatically updated but remains editable for custom tweaks</li>
                  {!importForm.useDirectML && (
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
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 border-t border-gray-800">
          <button
            onClick={onClose}
            disabled={isImporting}
            className="flex-1 bg-dark-surface hover:bg-dark-bg border border-gray-700 text-white font-semibold py-2.5 px-5 rounded-lg transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleImportModel}
            disabled={isImporting || !importForm.onnxPath || !importForm.modelName}
            className="flex-1 bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 text-white font-semibold py-2.5 px-5 rounded-lg transition-all flex items-center justify-center gap-2"
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
};
