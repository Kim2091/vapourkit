// src/components/Section.tsx — the settings column's only structural device.
//
// The column used to be five floating cards, each with its own border, its own
// 16px padding and a gap between them: ~200px of chrome before a single control
// was drawn. A sticky 32px header and a hairline do the same separating job for
// 32px total, and the headers stay legible while the column scrolls.
// See docs/design/README.md.

import { memo } from 'react';
import { ChevronDown } from 'lucide-react';

interface SectionProps {
  title: string;
  /** Right-aligned summary text — a count, a state, whatever reads at a glance. */
  meta?: React.ReactNode;
  /** Controls that belong to the section, rendered in its header. */
  actions?: React.ReactNode;
  /** Omit to render a plain header; provide to make the whole header a toggle. */
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
}

export const Section = memo<SectionProps>(({
  title, meta, actions, collapsible = false, open = true, onToggle, children,
}: SectionProps) => {
  const headerInner = (
    <>
      <span className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 whitespace-nowrap">
        {title}
      </span>
      {meta && <span className="text-[11.5px] text-ink-500 truncate">{meta}</span>}
    </>
  );

  // Three weights, so a boundary never reads like a row:
  //   section start  →  ink-700 rule + a brighter ink-850 band + accent edge
  //   header bottom  →  ink-800 hairline
  //   rows inside    →  ink-900 hairline (see SECTION_ROW)
  return (
    <section className="flex-shrink-0 border-t border-ink-700 first:border-t-0">
      <div className="sticky top-0 z-10 h-9 flex items-stretch gap-2.5 pr-3 bg-ink-850 border-b border-ink-800 shadow-[0_2px_4px_-2px_rgba(0,0,0,0.5)]">
        <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
        {collapsible ? (
          <button
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-2.5 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500"
          >
            {headerInner}
            <ChevronDown
              className={`w-3.5 h-3.5 text-ink-500 ml-auto flex-shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
            />
          </button>
        ) : (
          <div className="flex items-center gap-2.5 min-w-0 flex-1">{headerInner}</div>
        )}
        {actions && <div className="flex items-center gap-1.5 flex-shrink-0 self-center">{actions}</div>}
      </div>
      {(!collapsible || open) && children}
    </section>
  );
});

/**
 * Divider for rows *inside* a section. Deliberately fainter than the rule that
 * starts a section — that contrast is what makes the column readable.
 */
export const SECTION_ROW = 'border-b border-ink-900';

/** Small neutral control sized to sit inside a Section header. */
export const SectionButton = memo<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}>(({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`h-[22px] px-2 rounded inline-flex items-center gap-1.5 text-[11px] font-medium border transition-colors
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500
      disabled:opacity-40 disabled:cursor-not-allowed ${
      active
        ? 'bg-accent-500/15 border-accent-500/40 text-accent-400'
        : 'bg-ink-850 border-ink-750 text-ink-400 hover:text-ink-200 hover:border-ink-700'
    }`}
  >
    {children}
  </button>
));
