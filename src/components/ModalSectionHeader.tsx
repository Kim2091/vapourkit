// Shared header band for modal sections.
//
// Extracted from PluginsModal so more than one section component can use it without either
// duplicating the markup or importing back into the modal that renders them.

import { memo } from 'react';
import type { LucideIcon } from 'lucide-react';

interface ModalSectionHeaderProps {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
}

export const ModalSectionHeader = memo<ModalSectionHeaderProps>(({ icon: Icon, title, action }) => (
  <div className="h-9 flex items-stretch gap-2.5 pr-3 bg-ink-850 border-b border-ink-800">
    <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <Icon className="w-3.5 h-3.5 text-ink-500" />
      <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100 truncate">{title}</h3>
    </div>
    {action && <div className="flex items-center flex-shrink-0">{action}</div>}
  </div>
));
