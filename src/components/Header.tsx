import { memo, useMemo, useState, useRef, useEffect } from 'react';
import { Info, Settings, RefreshCw, Download, Upload, FolderOpen, X, Plug, Cpu, FileCheck2, Undo, Redo, Lock, LockOpen, Check, ChevronDown } from 'lucide-react';
import { Logo } from './Logo';
import type { BackendId } from '../electron.d';
import { BACKENDS, getBackendDescriptor } from '../utils/backends';

interface HeaderProps {
  isProcessing: boolean;
  defaultBackend: BackendId;
  privacyMode: boolean;
  onTogglePrivacyMode: () => void;
  onSettingsClick: () => void;
  onPluginsClick: () => void;
  onReloadBackend: () => void;
  onAboutClick: () => void;
  onChangeBackend: (backend: BackendId) => void;
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
  gpuStats?: { gpuMemoryUsed: number; gpuMemoryTotal: number; gpuUtilization: number } | null;
}

export const Header = memo<HeaderProps>(({
  isProcessing,
  defaultBackend,
  privacyMode,
  onTogglePrivacyMode,
  onSettingsClick,
  onPluginsClick,
  onReloadBackend,
  onAboutClick,
  onChangeBackend,
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
  gpuStats,
}: HeaderProps) => {
  const vramPercent = useMemo(() => {
    if (gpuStats?.gpuMemoryUsed != null && gpuStats?.gpuMemoryTotal) {
      return Math.round((gpuStats.gpuMemoryUsed / gpuStats.gpuMemoryTotal) * 100);
    }
    return null;
  }, [gpuStats?.gpuMemoryUsed, gpuStats?.gpuMemoryTotal]);

  const colorForPercent = (pct: number) => {
    if (pct >= 90) return { bar: 'bg-red-500', text: 'text-red-400' };
    if (pct >= 70) return { bar: 'bg-amber-500', text: 'text-amber-400' };
    return { bar: 'bg-emerald-500', text: 'text-emerald-400' };
  };

  const vramColor = vramPercent != null ? colorForPercent(vramPercent) : null;
  const loadColor = gpuStats?.gpuUtilization != null ? colorForPercent(gpuStats.gpuUtilization) : null;

  // Backend dropdown state (options come from the shared backend registry)
  const [showBackendMenu, setShowBackendMenu] = useState(false);
  const backendMenuRef = useRef<HTMLDivElement>(null);
  const activeBackend = getBackendDescriptor(defaultBackend);

  useEffect(() => {
    if (!showBackendMenu) return;
    const onClickOutside = (event: MouseEvent) => {
      if (backendMenuRef.current && !backendMenuRef.current.contains(event.target as Node)) {
        setShowBackendMenu(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showBackendMenu]);

  return (
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
          {/* Default inference backend selector (options from the backend registry) */}
          <div className="relative" ref={backendMenuRef}>
            <button
              onClick={() => setShowBackendMenu(v => !v)}
              className="text-gray-400 hover:text-white transition-colors p-2 hover:bg-dark-surface rounded-lg flex flex-col items-center gap-0.5 min-w-[70px]"
              title={`Default backend: ${activeBackend.label} — ${activeBackend.description}`}
              aria-haspopup="menu"
              aria-expanded={showBackendMenu}
            >
              <Cpu className="w-5 h-5" />
              <div className="flex items-center gap-1 text-xs">
                <span className="text-primary-blue font-semibold">{activeBackend.shortLabel}</span>
                <ChevronDown className={`w-3 h-3 text-gray-500 transition-transform ${showBackendMenu ? 'rotate-180' : ''}`} />
              </div>
            </button>
            {showBackendMenu && (
              <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-dark-surface border border-gray-700/70 rounded-lg shadow-xl shadow-black/40 overflow-hidden">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-700/50">
                  Default inference backend
                </div>
                {BACKENDS.map(backend => (
                  <button
                    key={backend.id}
                    onClick={() => {
                      setShowBackendMenu(false);
                      if (backend.id !== defaultBackend) {
                        onChangeBackend(backend.id);
                      }
                    }}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors hover:bg-dark-bg/60 ${
                      backend.id === defaultBackend ? 'bg-dark-bg/40' : ''
                    }`}
                    role="menuitemradio"
                    aria-checked={backend.id === defaultBackend}
                  >
                    <div className="w-4 pt-0.5 flex-shrink-0">
                      {backend.id === defaultBackend && <Check className="w-4 h-4 text-primary-blue" />}
                    </div>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${backend.id === defaultBackend ? 'text-white' : 'text-gray-300'}`}>
                        {backend.label}
                      </div>
                      <div className="text-xs text-gray-500 leading-snug">{backend.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onReloadBackend}
            disabled={isProcessing || isReloading}
            className="text-gray-400 hover:text-accent-cyan transition-colors p-2 hover:bg-dark-surface rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5 min-w-[56px]"
            title="Reload Backend"
          >
            <RefreshCw className={`w-5 h-5 ${isReloading ? 'animate-spin' : ''}`} />
            <span className="text-xs">Reload</span>
          </button>

          <button
            onClick={onTogglePrivacyMode}
            className={`transition-colors p-2 rounded-lg flex flex-col items-center gap-0.5 min-w-[56px] ${
              privacyMode
                ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30'
                : 'text-gray-400 hover:text-white hover:bg-dark-surface border border-transparent'
            }`}
            title={privacyMode ? 'Privacy mode is ON — click to turn off' : 'Privacy mode is OFF — click to hide previews, filenames, and notifications'}
            aria-pressed={privacyMode}
          >
            {privacyMode ? <Lock className="w-5 h-5" /> : <LockOpen className="w-5 h-5" />}
            <span className="text-xs">Privacy</span>
          </button>

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
          {/* Privacy Mode Indicator */}
          {privacyMode && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300"
              title="Privacy mode is on — previews and filenames are hidden"
            >
              <Lock className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold tracking-wide">Privacy</span>
            </div>
          )}

          {/* GPU Stats Indicator */}
          {gpuStats && vramPercent != null && vramColor && loadColor && (
            <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-dark-surface border border-gray-700/50" title={`VRAM: ${gpuStats.gpuMemoryUsed}MB / ${gpuStats.gpuMemoryTotal}MB\nGPU Load: ${gpuStats.gpuUtilization}%`}>
              {/* VRAM */}
              <div className="flex items-center gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-gray-500 font-medium leading-none">VRAM</span>
                  <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${vramColor.bar}`} style={{ width: `${vramPercent}%` }} />
                  </div>
                </div>
                <span className={`text-xs font-semibold ${vramColor.text}`}>{(gpuStats.gpuMemoryUsed / 1024).toFixed(1)}/{(gpuStats.gpuMemoryTotal / 1024).toFixed(1)} GB</span>
              </div>
              {/* GPU Load */}
              <div className="flex items-center gap-2 border-l border-gray-700/50 pl-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-gray-500 font-medium leading-none">Load</span>
                  <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${loadColor.bar}`} style={{ width: `${gpuStats.gpuUtilization}%` }} />
                  </div>
                </div>
                <span className={`text-xs font-semibold ${loadColor.text}`}>{gpuStats.gpuUtilization}%</span>
              </div>
            </div>
          )}

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
  );
});