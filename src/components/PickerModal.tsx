import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Search, X, Star, Clock, Check, Trash2, Edit3 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ModalShell } from './ModalShell';

const SIDEBAR_LABEL = 'px-2.5 pt-2.5 pb-1 text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500';
const LIST_BAND = 'h-7 flex items-center gap-2 px-2.5 bg-ink-850 border-y border-ink-800 font-display text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-400';
const HOVER_ACTION = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-within:opacity-100';

export interface PickerOption {
  key: string;
  label: string;
  count: number;
}

/** One labelled group of sidebar filters; the selected one is marked. */
export function PickerSidebarSection({ label, options, selected, onSelect, className }: {
  label: string;
  options: PickerOption[];
  selected: string;
  onSelect: (key: string) => void;
  className?: string;
}) {
  return (
    <>
      <div className={SIDEBAR_LABEL}>
        {label}
      </div>
      <div className={className}>
        {options.map(option => (
          <button
            key={option.key}
            onClick={() => onSelect(option.key)}
            className={`w-full h-7 text-left px-2.5 text-[12px] transition-colors flex items-center justify-between gap-2 group ${
              selected === option.key
                ? 'bg-accent-500/15 text-accent-400 shadow-[inset_3px_0_0] shadow-accent-500'
                : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200'
            }`}
          >
            <span className="truncate">{option.label}</span>
            <span className={`text-[10.5px] tabular-nums ${
              selected === option.key
                ? 'text-accent-400'
                : 'text-ink-500 group-hover:text-ink-400'
            }`}>
              {option.count}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

interface PickerRowProps {
  title: ReactNode;
  /** Chips after the title. */
  badges?: ReactNode;
  description?: string;
  /** Content under the description. */
  details?: ReactNode;
  /** Names the item in the edit and delete buttons: "template", "model". */
  noun: string;
  isSelected: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** One item in a picker list, with its edit, delete and favourite buttons. */
export function PickerRow({
  title,
  badges,
  description,
  details,
  noun,
  isSelected,
  isFavorite,
  onSelect,
  onToggleFavorite,
  onEdit,
  onDelete,
}: PickerRowProps) {
  return (
    <div
      className={`group relative flex items-start gap-2.5 px-3 py-1.5 border-b border-ink-900 cursor-pointer transition-colors ${
        isSelected
          ? 'bg-accent-500/15 ring-1 ring-inset ring-accent-500/50'
          : 'hover:bg-ink-900'
      }`}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-h-[20px]">
          <h4 className={`text-[12.5px] font-medium min-w-0 break-words mr-1 ${
            isSelected ? 'text-ink-100' : 'text-ink-200'
          }`}>
            {title}
          </h4>
          {badges}
        </div>
        {description && (
          <p className="text-[11px] text-ink-500 line-clamp-2 mt-0.5">
            {description}
          </p>
        )}
        {details}
      </div>

      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isSelected && (
          <span className="w-5 h-5 rounded-full bg-accent-500 text-accent-ink grid place-items-center flex-shrink-0" aria-hidden="true"><Check className="w-3.5 h-3.5" strokeWidth={3} /></span>
        )}
        {onEdit && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className={`w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors ${HOVER_ACTION}`}
            title={`Edit ${noun}`}
            aria-label={`Edit ${noun}`}
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className={`w-6 h-6 rounded grid place-items-center text-ink-500 hover:text-bad-400 hover:bg-bad-500/10 transition-colors ${HOVER_ACTION}`}
            title={`Delete ${noun}`}
            aria-label={`Delete ${noun}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          className={`w-6 h-6 rounded grid place-items-center transition-colors ${
            isFavorite
              ? 'text-warn-400 hover:text-warn-500'
              : `text-ink-500 hover:text-warn-400 ${HOVER_ACTION}`
          }`}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={`w-3.5 h-3.5 ${isFavorite ? 'fill-warn-400' : ''}`} />
        </button>
      </div>
    </div>
  );
}

/** A grey chip after an item's title. */
export function PickerChip({ children, className = 'text-ink-400' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center h-[18px] px-1.5 rounded border border-ink-750 bg-ink-850 text-[10px] ${className} flex-shrink-0`}>
      {children}
    </span>
  );
}

function ListSection({ icon: Icon, iconClassName, title, count, children }: {
  icon: LucideIcon;
  iconClassName: string;
  title: ReactNode;
  count: number;
  children: ReactNode;
}) {
  return (
    <>
      <div className={LIST_BAND}>
        <Icon className={`w-3 h-3 ${iconClassName}`} />
        <h3>{title}</h3>
        <span className="text-ink-500 tabular-nums">({count})</span>
      </div>
      {children}
    </>
  );
}

interface PickerModalProps<T> {
  title: string;
  icon: LucideIcon;
  closeLabel: string;
  onClose: () => void;
  headerActions?: ReactNode;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchPlaceholder: string;
  /** Sidebar content, usually PickerSidebarSections. */
  sidebar: ReactNode;
  /** Rows above the current selection, such as a "new" entry. */
  listTop?: ReactNode;
  /** The current selection's bar; none when nothing is selected. */
  current?: { label: ReactNode; clearLabel: string; onClear: () => void } | null;
  /** Shows the favourites and recents sections. */
  showPinned: boolean;
  favorites: T[];
  recents: T[];
  /** The main list. */
  items: T[];
  itemsTitle: ReactNode;
  emptyText: string;
  /** Shown under the empty-list text. */
  emptyExtra?: ReactNode;
  renderItem: (item: T) => ReactNode;
  /** The list's noun in the footer: "filters", "models". */
  noun: string;
  favoriteCount: number;
  /** Footer content after the counts. */
  footerExtra?: ReactNode;
}

/**
 * The model and filter pickers' layout: search, a filtering sidebar, and a
 * list with favourites and recents above everything else.
 */
export function PickerModal<T>({
  title,
  icon: Icon,
  closeLabel,
  onClose,
  headerActions,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  sidebar,
  listTop,
  current,
  showPinned,
  favorites,
  recents,
  items,
  itemsTitle,
  emptyText,
  emptyExtra,
  renderItem,
  noun,
  favoriteCount,
  footerExtra,
}: PickerModalProps<T>) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  return (
    <ModalShell
      title={title}
      icon={Icon}
      onClose={onClose}
      closeLabel={closeLabel}
      closeTitle="Close"
      closeOnBackdrop
      padded={false}
      className="w-[90vw] max-w-5xl h-[80vh] max-h-[800px] flex flex-col overflow-hidden"
      headerActions={headerActions}
    >
      {/* Search Bar */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-ink-800">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-500" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full h-8 bg-ink-850 border border-ink-750 rounded pl-8 pr-8 text-[12.5px] focus:outline-none focus:border-accent-500 transition-colors placeholder-ink-500"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded grid place-items-center text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 flex-shrink-0 border-r border-ink-800 overflow-y-auto bg-ink-950">
          <div className="pb-2">
            {sidebar}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto bg-ink-950">
          {listTop}

          {current && (
            <div className="flex items-center gap-2.5 min-h-[36px] px-3 py-1.5 bg-accent-500/10 border-b border-ink-800 shadow-[inset_3px_0_0] shadow-accent-500">
              <div className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500 flex-shrink-0">Current Selection</div>
              <div className="text-[12.5px] font-medium text-accent-400 truncate flex-1 min-w-0">
                {current.label}
              </div>
              <button
                onClick={current.onClear}
                className="h-6 px-2 rounded inline-flex items-center text-[11px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors flex-shrink-0"
              >
                {current.clearLabel}
              </button>
            </div>
          )}

          {showPinned && favorites.length > 0 && (
            <div className="mb-2">
              <ListSection icon={Star} iconClassName="text-warn-400 fill-warn-400" title="Favorites" count={favorites.length}>
                <div>{favorites.map(renderItem)}</div>
              </ListSection>
            </div>
          )}

          {showPinned && recents.length > 0 && (
            <div className="mb-2">
              <ListSection icon={Clock} iconClassName="text-ink-500" title="Recent" count={recents.length}>
                <div>{recents.map(renderItem)}</div>
              </ListSection>
            </div>
          )}

          <div>
            <ListSection icon={Icon} iconClassName="text-ink-500" title={itemsTitle} count={items.length}>
              {items.length === 0 ? (
                <div className="text-center py-12 text-ink-500">
                  <Icon className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p className="text-[12.5px] text-ink-400">{emptyText}</p>
                  {searchQuery && (
                    <p className="text-[11px] mt-1">Try adjusting your search query</p>
                  )}
                  {emptyExtra}
                </div>
              ) : (
                <div>{items.map(renderItem)}</div>
              )}
            </ListSection>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 h-8 border-t border-ink-800 px-3 bg-ink-900 flex items-center justify-between text-[11px] text-ink-500">
        <div className="flex items-center gap-3 tabular-nums">
          <span>{items.length} {noun} shown</span>
          <span>•</span>
          <span>{favoriteCount} favorites</span>
          {footerExtra}
        </div>
        <div className="flex items-center gap-2">
          <kbd className="px-1.5 py-0.5 bg-ink-850 border border-ink-750 rounded text-[10px] font-mono text-ink-300">Esc</kbd>
          <span>to close</span>
        </div>
      </div>
    </ModalShell>
  );
}

