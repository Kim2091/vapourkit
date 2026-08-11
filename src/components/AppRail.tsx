// src/components/AppRail.tsx — the vertical tool rail down the left edge.
//
// Collapsed it is 56px of icons; the toggle at the bottom expands it to 184px
// with labels beside the icons. The queue lives here with a live count badge —
// it is a pane you show or hide, so its switch belongs on the rail, not inside
// a settings section. See docs/design/README.md.

import { memo, useState, useRef, useEffect } from 'react';
import {
  Settings, Plug, RefreshCw, Lock, LockOpen, Info, List,
  FolderOpen, Download, Upload, FileCheck2,
  PanelLeftOpen, PanelLeftClose,
} from 'lucide-react';
import { Logo } from './Logo';

interface AppRailProps {
  isProcessing: boolean;
  isReloading?: boolean;
  privacyMode: boolean;
  hasWorkflow: boolean;
  showQueue: boolean;
  queueCount: number;
  onToggleQueue: () => void;
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
  expanded: boolean;
  disabled?: boolean;
  active?: boolean;
  tone?: 'default' | 'warn';
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
}

const RailButton = ({
  label, title, expanded, disabled, active, tone = 'default', badge, onClick, children, ...aria
}: RailButtonProps) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={label}
    aria-pressed={active}
    className={`h-9 rounded-lg transition-colors flex-shrink-0 relative
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500
      disabled:opacity-35 disabled:cursor-not-allowed ${
      expanded
        ? 'w-full flex items-center gap-2.5 px-2.5'
        : 'w-[38px] grid place-items-center'
    } ${
      active
        ? tone === 'warn'
          ? 'bg-warn-500/20 text-warn-400'
          : 'bg-accent-500/18 text-accent-400'
        : 'text-ink-400 hover:text-ink-200 hover:bg-ink-850'
    }`}
    {...aria}
  >
    {children}
    {expanded && (
      <span className="text-[12.5px] font-medium whitespace-nowrap overflow-hidden text-ellipsis min-w-0 flex-1 text-left">
        {label}
      </span>
    )}
    {badge !== undefined && badge > 0 && (
      expanded ? (
        <span className="text-[11px] font-semibold tabular-nums text-accent-400 flex-shrink-0">{badge}</span>
      ) : (
        <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-accent-500 text-accent-ink text-[9px] font-bold font-display grid place-items-center leading-none">
          {badge}
        </span>
      )
    )}
  </button>
);

export const AppRail = memo<AppRailProps>(({
  isProcessing,
  isReloading,
  privacyMode,
  hasWorkflow,
  showQueue,
  queueCount,
  onToggleQueue,
  onSettingsClick,
  onPluginsClick,
  onReloadBackend,
  onTogglePrivacyMode,
  onAboutClick,
  onLoadWorkflow,
  onImportWorkflow,
  onExportWorkflow,
}: AppRailProps) => {
  const [expanded, setExpanded] = useState(() => window.localStorage.getItem('vk-rail-expanded') === '1');
  const [showWorkflowMenu, setShowWorkflowMenu] = useState(false);
  const workflowMenuRef = useRef<HTMLDivElement>(null);

  const toggleExpanded = () => {
    setExpanded(v => {
      window.localStorage.setItem('vk-rail-expanded', v ? '0' : '1');
      return !v;
    });
  };

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
  const ICON = 'w-[17px] h-[17px] flex-shrink-0';

  return (
    <div
      className={`flex-shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col py-2.5 gap-1 transition-[width] duration-200 ${
        expanded ? 'w-[184px] px-2 items-stretch' : 'w-[56px] items-center'
      }`}
    >
      <div className={`h-7 mb-2.5 flex items-center flex-shrink-0 text-accent-500 ${expanded ? 'gap-2.5 px-2.5' : 'justify-center'}`}>
        <Logo className="w-[26px] h-[26px] flex-shrink-0" monochrome />
        {expanded && (
          <span className="font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-200 whitespace-nowrap">
            Vapourkit
          </span>
        )}
      </div>

      <RailButton
        label="Queue"
        title={showQueue ? 'Hide the queue pane' : 'Show the queue pane'}
        expanded={expanded}
        active={showQueue}
        badge={queueCount}
        onClick={onToggleQueue}
      >
        <List className={ICON} />
      </RailButton>

      <RailButton label="Settings" title="Settings" expanded={expanded} onClick={onSettingsClick}>
        <Settings className={ICON} />
      </RailButton>

      <RailButton label="Plugins" title="Plugin dependencies" expanded={expanded} onClick={onPluginsClick}>
        <Plug className={ICON} />
      </RailButton>

      <RailButton
        label="Reload backend"
        title="Reload backend"
        expanded={expanded}
        disabled={isProcessing || isReloading}
        onClick={onReloadBackend}
      >
        <RefreshCw className={`${ICON} ${isReloading ? 'animate-spin' : ''}`} />
      </RailButton>

      <RailButton
        label="Privacy"
        title={privacyMode
          ? 'Privacy mode is on — click to show previews, filenames and notifications'
          : 'Privacy mode is off — click to hide previews, filenames and notifications'}
        expanded={expanded}
        active={privacyMode}
        tone="warn"
        onClick={onTogglePrivacyMode}
      >
        {privacyMode ? <Lock className={ICON} /> : <LockOpen className={ICON} />}
      </RailButton>

      {hasWorkflowActions && (
        <div className="relative" ref={workflowMenuRef}>
          <RailButton
            label="Workflow"
            title="Workflow — open, import, export"
            expanded={expanded}
            active={hasWorkflow || showWorkflowMenu}
            onClick={() => setShowWorkflowMenu(v => !v)}
            aria-haspopup="menu"
            aria-expanded={showWorkflowMenu}
          >
            {hasWorkflow ? <FileCheck2 className={ICON} /> : <FolderOpen className={ICON} />}
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
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[12.5px] text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[12.5px] text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                  className="w-full text-left px-3 py-2 flex items-center gap-2.5 text-[12.5px] text-ink-300 hover:bg-ink-800 hover:text-ink-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

      <RailButton label="About" title="About Vapourkit" expanded={expanded} onClick={onAboutClick}>
        <Info className={ICON} />
      </RailButton>

      <RailButton
        label="Collapse"
        title={expanded ? 'Collapse the rail to icons' : 'Expand the rail to show labels'}
        expanded={expanded}
        onClick={toggleExpanded}
      >
        {expanded ? <PanelLeftClose className={ICON} /> : <PanelLeftOpen className={ICON} />}
      </RailButton>
    </div>
  );
});
