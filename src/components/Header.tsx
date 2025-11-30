import { Info, Settings, RefreshCw, Code, Download, Upload, FolderOpen, X, Plug, Cpu } from 'lucide-react';
import { Logo } from './Logo';

interface HeaderProps {
  isProcessing: boolean;
  developerMode: boolean;
  useDirectML: boolean;
  onSettingsClick: () => void;
  onPluginsClick: () => void;
  onReloadBackend: () => void;
  onAboutClick: () => void;
  onToggleDeveloperMode: (value: boolean) => void;
  onToggleDirectML: (value: boolean) => void;
  onLoadWorkflow?: () => void;
  onImportWorkflow?: () => void;
  onExportWorkflow?: () => void;
  onClearWorkflow?: () => void;
  workflowName?: string | null;
  isReloading?: boolean;
}

export const Header = ({ 
  isProcessing, 
  developerMode, 
  useDirectML,
  onSettingsClick, 
  onPluginsClick, 
  onReloadBackend, 
  onAboutClick, 
  onToggleDeveloperMode,
  onToggleDirectML,
  onLoadWorkflow,
  onImportWorkflow,
  onExportWorkflow,
  onClearWorkflow,
  workflowName,
  isReloading
}: HeaderProps) => (
  <div className="flex-shrink-0">
    <div className="py-3 px-6 border-b border-gray-800/50">
      <div className="flex items-center justify-between gap-4 relative">
        {/* Left side buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onSettingsClick}
            className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[56px]"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
            <span className="text-xs">Settings</span>
          </button>
          <button
            onClick={onPluginsClick}
            className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[56px]"
            title="Plugin Dependencies"
          >
            <Plug className="w-5 h-5" />
            <span className="text-xs">Plugins</span>
          </button>
          <button
            onClick={() => onToggleDeveloperMode(!developerMode)}
            className={`transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[56px] ${
              developerMode ? 'text-accent-cyan' : 'text-gray-400 hover:text-white'
            }`}
            title={developerMode ? "Advanced Mode: ON" : "Advanced Mode: OFF"}
          >
            <Code className="w-5 h-5" />
            <span className="text-xs">Advanced</span>
          </button>
          <button
            onClick={() => onToggleDirectML(!useDirectML)}
            className={`transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[56px] ${
              useDirectML ? 'text-accent-cyan' : 'text-gray-400 hover:text-white'
            }`}
            title={useDirectML ? "DirectML: ON (ONNX Runtime)" : "DirectML: OFF (TensorRT)"}
          >
            <Cpu className="w-5 h-5" />
            <span className="text-xs">DirectML</span>
          </button>
          <button
            onClick={onReloadBackend}
            disabled={isProcessing || isReloading}
            className="text-gray-400 hover:text-accent-cyan transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[56px]"
            title="Reload Backend"
          >
            <RefreshCw className={`w-5 h-5 ${isReloading ? 'animate-spin' : ''}`} />
            <span className="text-xs">Reload</span>
          </button>
        </div>

        {/* Center content - hides on smaller screens */}
        <div className="hidden xl:block absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
          <div className="flex items-center justify-center gap-2 mb-1">
            <Logo />
            <h1 className="text-xl font-bold bg-gradient-to-r from-primary-blue via-primary-purple to-accent-cyan bg-clip-text text-transparent select-none whitespace-nowrap">
              Vapourkit
            </h1>
          </div>
          <p className="text-gray-400 text-xs select-none whitespace-nowrap">
            Fast and high quality video enhancement
          </p>
        </div>

        {/* Right side buttons */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {developerMode && (onLoadWorkflow || onImportWorkflow || onExportWorkflow) && (
            <div className="flex items-center gap-1 px-2 py-1 border border-gray-700/50 rounded-lg bg-gray-800/30">
              <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Workflow:</span>
              <div className="flex items-center gap-1">
                {onLoadWorkflow && (
                  <button
                    onClick={onLoadWorkflow}
                    disabled={isProcessing}
                    className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[48px]"
                    title="Load Workflow"
                  >
                    <FolderOpen className="w-5 h-5" />
                    <span className="text-xs">Load</span>
                  </button>
                )}
                {onImportWorkflow && (
                  <button
                    onClick={onImportWorkflow}
                    disabled={isProcessing}
                    className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[48px]"
                    title="Import Filters from Workflow"
                  >
                    <Download className="w-5 h-5" />
                    <span className="text-xs">Import</span>
                  </button>
                )}
                {onExportWorkflow && (
                  <button
                    onClick={onExportWorkflow}
                    disabled={isProcessing}
                    className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[48px]"
                    title="Export Workflow"
                  >
                    <Upload className="w-5 h-5" />
                    <span className="text-xs">Export</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <button
            onClick={onAboutClick}
            className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[48px]"
            title="About"
          >
            <Info className="w-5 h-5" />
            <span className="text-xs">About</span>
          </button>
        </div>
      </div>
    </div>
    {workflowName && (
      <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-6 py-2">
        <div className="flex items-center justify-center gap-2">
          <p className="text-yellow-400 text-sm font-medium">
            Current workflow: {workflowName}
          </p>
          {onClearWorkflow && (
            <button
              onClick={onClearWorkflow}
              className="text-yellow-400 hover:text-yellow-300 transition-colors p-1 hover:bg-yellow-500/20 rounded flex items-center gap-1"
              title="Clear Workflow and Restore Previous Settings"
            >
              <X className="w-4 h-4" />
              <span className="text-xs">Clear</span>
            </button>
          )}
        </div>
      </div>
    )}
  </div>
);