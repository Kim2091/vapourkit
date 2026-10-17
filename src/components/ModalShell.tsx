import { forwardRef, memo } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useModalEscape } from './useModalEscape';

interface ModalShellProps {
  title: ReactNode;
  icon?: LucideIcon;
  /** Colour of the header icon. */
  iconClassName?: string;
  /** Shows the close button. Escape and a backdrop click call it too, where enabled. */
  onClose?: () => void;
  /** The close button's accessible name. */
  closeLabel?: string;
  /** The close button's tooltip. */
  closeTitle?: string;
  closeDisabled?: boolean;
  /** Escape closes the modal. On by default when there is an onClose. */
  closeOnEscape?: boolean;
  /** A click on the dimmed backdrop closes the modal. */
  closeOnBackdrop?: boolean;
  /** Controls placed before the close button in the header. */
  headerActions?: ReactNode;
  /** Danger marks the header strip and icon red. */
  tone?: 'accent' | 'danger';
  /** Stacking layer: 50 for a modal, 60 for a dialog over one, 80 for a prompt over all. */
  layer?: 50 | 60 | 80;
  /** Pads the backdrop so the panel never meets the window edge. */
  padded?: boolean;
  /** The panel's size and layout classes. */
  className: string;
  titleId?: string;
  /** Extra attributes for the panel, such as role and aria-describedby. */
  panelProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}

const LAYER_CLASS = { 50: 'z-50', 60: 'z-[60]', 80: 'z-[80]' } as const;

/**
 * The app's modal frame: the dimmed backdrop, the panel, and the header band
 * with its accent strip, icon, title and close button.
 */
export const ModalShell = memo(forwardRef<HTMLDivElement, ModalShellProps>(({
  title,
  icon: Icon,
  iconClassName,
  onClose,
  closeLabel = 'Close',
  closeTitle,
  closeDisabled = false,
  closeOnEscape = true,
  closeOnBackdrop = false,
  headerActions,
  tone = 'accent',
  layer = 50,
  padded = true,
  className,
  titleId,
  panelProps,
  children,
}, ref) => {
  useModalEscape(onClose, closeOnEscape && !!onClose);
  const danger = tone === 'danger';

  const closeButton = onClose && (
    <button
      onClick={onClose}
      disabled={closeDisabled}
      title={closeTitle}
      aria-label={closeLabel}
      className="w-7 h-7 self-center rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors disabled:opacity-50"
    >
      <X className="w-4 h-4" />
    </button>
  );

  return (
    <div
      className={`fixed inset-0 ${LAYER_CLASS[layer]} flex items-center justify-center bg-black/60 backdrop-blur-sm${padded ? ' p-4' : ''}`}
      onClick={closeOnBackdrop ? (event) => { if (event.target === event.currentTarget) onClose?.(); } : undefined}
    >
      <div
        ref={ref}
        {...panelProps}
        className={`bg-ink-900 border border-ink-750 rounded-lg shadow-2xl shadow-black/60 ${className}`}
        onClick={closeOnBackdrop ? (event) => event.stopPropagation() : undefined}
      >
        <div className="h-10 flex-shrink-0 flex items-stretch gap-2.5 pr-2 bg-ink-850 border-b border-ink-800 rounded-t-lg overflow-hidden">
          <span className={`w-[3px] flex-shrink-0 ${danger ? 'bg-bad-500' : 'bg-accent-500'}`} aria-hidden="true" />
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {Icon && <Icon className={`w-4 h-4 ${iconClassName ?? (danger ? 'text-bad-400' : 'text-ink-500')}`} />}
            <h2 id={titleId} className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 truncate">
              {title}
            </h2>
          </div>
          {headerActions ? (
            <div className="flex items-center gap-1.5 flex-shrink-0 self-center">
              {headerActions}
              {closeButton}
            </div>
          ) : closeButton}
        </div>
        {children}
      </div>
    </div>
  );
}));

ModalShell.displayName = 'ModalShell';
