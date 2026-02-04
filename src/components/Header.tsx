import { memo } from 'react';
import { Info, Settings, RefreshCw, Download, Upload, FolderOpen, X, Plug, Cpu, FileCheck2, Undo, Redo } from 'lucide-react';
import { Logo } from './Logo';

interface HeaderProps {
  isProcessing: boolean;
  useDirectML: boolean;
  onSettingsClick: () => void;
  onPluginsClick: () => void;
  onReloadBackend: () => void;
  onAboutClick: () => void;
  onToggleDirectML: (value: boolean) => void;
  onLoadWorkflow?: () => void;
  onImportWorkflow?: () => void;
  onExportWorkflow?: () => void;
  onClearWorkflow?: () => void;
  workflowName?: string | null;
  isReloading?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

export const Header = memo<HeaderProps>(({ 
  isProcessing, 
  useDirectML,
  onSettingsClick, 
  onPluginsClick, 
  onReloadBackend, 
  onAboutClick, 
  onToggleDirectML,
  onLoadWorkflow,
  onImportWorkflow,
  onExportWorkflow,
  onClearWorkflow,
  workflowName,
  isReloading,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: HeaderProps) => (
  <div className="flex-shrink-0">
    <div className="py-3 px-6 border-b border-gray-800/50">
      <div className="flex items-center justify-between gap-4 relative">
        {/* Left side buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
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
            onClick={() => onToggleDirectML(!useDirectML)}
            className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[70px]"
            title={useDirectML ? "Currently using DirectML - Click to switch to TensorRT" : "Currently using TensorRT - Click to switch to DirectML"}
          >
            <Cpu className="w-5 h-5" />
            <div className="flex items-center gap-1 text-xs">
              <span className={useDirectML ? 'text-accent-cyan font-semibold' : 'text-gray-500'}>DML</span>
              <span className="text-gray-600">|</span>
              <span className={!useDirectML ? 'text-primary-blue font-semibold' : 'text-gray-500'}>TRT</span>
            </div>
          </button>
          <button
            onClick={onReloadBackend}
            disabled={isProcessing || isReloading}
            className="text-gray-400 hover:text-accent-cyan transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[56px]"
            title="Reload Backend"
          
          {/* Undo/Redo buttons */}
          <div className="flex items-center gap-1 px-2 py-1 border-l border-gray-700/50 ml-1">
            {onUndo && (
              <button
                onClick={onUndo}
                disabled={!canUndo || isProcessing}
                className="text-gray-400 hover:text-white transition-colors p-1.5 hover:bg-dark-surface rounded disabled:opacity-30 disabled:cursor-not-allowed"
                title="Undo (Ctrl+Z)"
              >
                <Undo className="w-4 h-4" />
              </button>
            )}
            {onRedo && (
              <button
                onClick={onRedo}
                disabled={!canRedo || isProcessing}
                className="text-gray-400 hover:text-white transition-colors p-1.5 hover:bg-dark-surface rounded disabled:opacity-30 disabled:cursor-not-allowed"
                title="Redo (Ctrl+Y)"
              >
                <Redo className="w-4 h-4" />
              </button>
            )}
          </div>
          >
            <RefreshCw className={`w-5 h-5 ${isReloading ? 'animate-spin' : ''}`} />
            <span className="text-xs">Reload</span>
          </button>
        </div>

        {/* Center content - hides on smaller screens */}
        <div className="hidden xl:block absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
          <div className="flex items-center justify-center gap-3 mb-1">
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
          {/* Active Workflow Badge */}
          {workflowName && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-primary-purple/30 via-primary-blue/30 to-accent-cyan/30 border border-primary-purple/60 shadow-lg shadow-primary-purple/20">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-5 h-5 rounded bg-primary-purple/40 border border-primary-purple/60">
                  <FileCheck2 className="w-3.5 h-3.5 text-primary-purple" />
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-gray-300 leading-none font-medium">Workflow</span>
                  <span className="text-xs font-bold text-white leading-tight">{workflowName}</span>
                </div>
              </div>
              {onClearWorkflow && (
                <button
                  onClick={onClearWorkflow}
                  className="ml-1 text-gray-400 hover:text-white transition-colors p-1 hover:bg-dark-surface/50 rounded"
                  title="Clear Workflow and Restore Previous Settings"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          
          {(onLoadWorkflow || onImportWorkflow || onExportWorkflow) && (
            <div className="flex items-center gap-2 px-3 py-1.5 border border-gray-700/50 rounded-lg bg-gray-800/30">
              <span className="text-xs text-gray-500 font-medium whitespace-nowrap">Workflow:</span>
              <div className="flex items-center gap-2">
                {onLoadWorkflow && (
                  <button
                    onClick={onLoadWorkflow}
                    disabled={isProcessing}
                    className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[48px]"
                    title="Temporarily Load Workflow"
                  >
                    <FolderOpen className="w-5 h-5" />
                    <span className="text-xs">Open</span>
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
  </div>
));