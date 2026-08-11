// src/components/AppRail.tsx — 56px vertical tool rail down the left edge.
//
// Replaces the left half of the old 80px header, where each button stacked a
// 20px icon over a text label that repeated its own tooltip. See
// docs/design/README.md.

import { memo, useState, useRef, useEffect } from 'react';
import {
  Settings, Plug, RefreshCw, Lock, LockOpen, Info,
  FolderOpen, Download, Upload, FileCheck2,
} from 'lucide-react';
import { Logo } from './Logo';

interface AppRailProps {
  isProcessing: boolean;
  isReloading?: boolean;
  privacyMode: boolean;
  hasWorkflow: boolean;
  onSettingsClick: () => void;
  onPluginsClick: () => void;
  onReloadBackend: () => void;
  onTogglePrivacyMode: () => void;
  onAboutClick: () => void;
  onLoadWorkflow?: () => void;
  onImportWorkflow?: () => void;
  onExportWorkflow?: () => void;
}

interface RailButtonProps {
  label: string;
  title: string;
  disabled?: boolean;
  active?: boolean;
  tone?: 'default' | 'warn';
  onClick: () => void;
  children: React.ReactNode;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
}

const RailButton = ({
  label, title, disabled, active, tone = 'default', onClick, children, ...aria
}: RailButtonProps) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={label}
    aria-pressed={active}
    className={`w-[38px] h-9 rounded-lg grid place-items-center transition-colors flex-shrink-0
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500
      disabled:opacity-35 disabled:cursor-not-allowed ${
      active
        ? tone === 'warn'
          ? 'bg-warn-500/20 text-warn-400'
          : 'bg-accent-500/18 text-accent-400'
        : 'text-ink-400 hover:text-ink-200 hover:bg-ink-850'
    }`}
    {...aria}
  >
    {children}
  </button>
);

export const AppRail = memo<AppRailProps>(({
  isProcessing,
  isReloading,
  privacyMode,
  hasWorkflow,
  onSettingsClick,
  onPluginsClick,
  onReloadBackend,
  onTogglePrivacyMode,
  onAboutClick,
  onLoadWorkflow,
  onImportWorkflow,
  onExportWorkflow,
}: AppRailProps) => {
  const [showWorkflowMenu, setShowWorkflowMenu] = useState(false);
  const workflowMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showWorkflowMenu) return;
    const onClickOutside = (event: MouseEvent) => {
      if (workflowMenuRef.current && !workflowMenuRef.current.contains(event.target as Node)) {
        setShowWorkflowMenu(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowWorkflowMenu(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [showWorkflowMenu]);

  const hasWorkflowActions = Boolean(onLoadWorkflow || onImportWorkflow || onExportWorkflow);

  return (
    <div className="w-[56px] flex-shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col items-center py-2.5 gap-1">
      <div className="w-7 h-7 mb-2.5 grid place-items-center text-accent-500 flex-shrink-0">
        <Logo className="w-[26px] h-[26px]" monochrome />
      </div>

      <RailButton label="Settings" title="Settings" onClick={onSettingsClick}>
        <Settings className="w-[17px] h-[17px]" />
      </RailButton>

      <RailButton label="Plugins" title="Plugin dependencies" onClick={onPluginsClick}>
        <Plug className="w-[17px] h-[17px]" />
      </RailButton>

      <RailButton
        label="Reload backend"
        title="Reload backend"
        disabled={isProcessing || isReloading}
        onClick={onReloadBackend}
      >
        <RefreshCw className={`w-[17px] h-[17px] ${isReloading ? 'animate-spin' : ''}`} />
      </RailButton>

      <RailButton
        label="Privacy mode"
        title={privacyMode
          ? 'Privacy mode is on — click to show previews, filenames and notifications'
          : 'Privacy mode is off — click to hide previews, filenames and notifications'}
        active={privacyMode}
        tone="warn"
        onClick={onTogglePrivacyMode}
      >
        {privacyMode ? <Lock className="w-[17px] h-[17px]" /> : <LockOpen className="w-[17px] h-[17px]" />}
      </RailButton>

      {hasWorkflowActions && (
        <div className="relative" ref={workflowMenuRef}>
          <RailButton
            label="Workflow"
            title="Workflow — open, import, export"
            active={hasWorkflow || showWorkflowMenu}
            onClick={() => setShowWorkflowMenu(v => !v)}
            aria-haspopup="menu"
            aria-expanded={showWorkflowMenu}
          >
            {hasWorkflow ? <FileCheck2 className="w-[17px] h-[17px]" /> : <FolderOpen className="w-[17px] h-[17px]" />}
          </RailButton>

          {showWorkflowMenu && (
            <div
              role="menu"
              className="absolute left-full top-0 ml-1 z-50 w-56 bg-ink-850 border border-ink-750 rounded-lg shadow-xl shadow-black/50 overflow-hidden"
            >
              <div className="px-3 py-2 text-[10px] font-display uppercase tracking-[0.14em] text-ink-500 border-b border-ink-800">
                Workflow
              </div>
              {onLoadWorkflow && (
                <button
                  role="menuitem"
                  onClick={() => { setShowWorkflowMenu(false); onLoadWorkflow(); }}
                  disabled={isProcessing}
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FolderOpen className="w-4 h-4 text-ink-500" />
                  Open workflow
                </button>
              )}
              {onImportWorkflow && (
                <button
                  role="menuitem"
                  onClick={() => { setShowWorkflowMenu(false); onImportWorkflow(); }}
                  disabled={isProcessing}
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Download className="w-4 h-4 text-ink-500" />
                  Import filters
                </button>
              )}
              {onExportWorkflow && (
                <button
                  role="menuitem"
                  onClick={() => { setShowWorkflowMenu(false); onExportWorkflow(); }}
                  disabled={isProcessing}
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4 text-ink-500" />
                  Export workflow
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      <RailButton label="About" title="About Vapourkit" onClick={onAboutClick}>
        <Info className="w-[17px] h-[17px]" />
      </RailButton>
    </div>
  );
});
