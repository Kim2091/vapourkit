// src/components/GradeToolRail.tsx — the modal tools, beside the picture.
//
// The grading controls went through three homes before this one, and each move
// fixed a symptom rather than the cause. In the preview panel's title bar they
// were 10px chips reading as chrome; gathered into a "Tools" column of the dock
// they were legible but arbitrary, because that column held three unlike kinds
// of thing and the only word covering all three was "Tools".
//
// The distinction that sorts them is Photoshop's. A *modal tool* changes what a
// click on the picture does: it is exclusive, it is armed, it changes the
// cursor, and it belongs beside the canvas. A *view toggle* changes how you
// look at the same picture — those went to the step rail above, which already
// answers "which picture am I seeing". A *command* fires once and writes to the
// document — Auto balance and Reset all, which live in the dock header.
//
// Only the pickers are modal tools, which is what this rail holds. Three of
// them, plus the compare tool that owns the picture when nothing is armed: an
// arrow at the top of the rail is not decoration, it is where the split
// divider's drag lives, and it is what makes putting a tool away feel like
// something rather than nothing.
//
// The rail alone would not be self-explanatory — a column of four 14px glyphs
// is exactly the legibility problem we started with. What carries it is the
// hint bar below the picture: Photoshop's options bar, saying what the armed
// tool wants from you. It is why the explanation that never fit in a 200px
// column fits here.

import { memo, useEffect } from 'react';
import { MousePointer2, Pipette, Contrast } from 'lucide-react';
import type { PickMode } from './ColorGradeOverlay';

export interface ToolRailControls {
  pickMode: PickMode;
  onPickModeChange: (mode: PickMode) => void;
  /** False when the picture on screen is not the one entering this grade. */
  canPick: boolean;
}

interface ToolSpec {
  /** null is the compare tool: no picker armed, the divider takes the drag. */
  mode: PickMode;
  key: string;
  label: string;
  /** What the hint bar says while this one is armed. */
  hint: string;
  Icon: typeof Pipette;
}

/* B is taken — it is held for Before — so the pickers get K, W and N. Giving
   the black picker the obvious B would have shadowed the compare shortcut that
   every grade uses far more often. */
export const GRADE_TOOLS: ToolSpec[] = [
  {
    mode: null,
    key: 'v',
    label: 'Compare',
    hint: 'Drag the divider to move the split. Press K, W or N to sample from the picture.',
    Icon: MousePointer2,
  },
  {
    mode: 'black',
    key: 'k',
    label: 'Black point',
    hint: 'Click something that should be black. Lift solves per channel — level and colour cast together.',
    Icon: Pipette,
  },
  {
    mode: 'white',
    key: 'w',
    label: 'White point',
    hint: 'Click something that should be white. Gain solves per channel; temperature and tint stay as you set them.',
    Icon: Pipette,
  },
  {
    mode: 'neutral',
    key: 'n',
    label: 'Neutral',
    hint: 'Click something that should be grey. Temperature and tint solve to take the cast out.',
    Icon: Contrast,
  },
];

const UNAVAILABLE = 'Step to the picture entering this grade to sample from it.';

/**
 * Keyboard for the rail, bound to the window.
 *
 * The picture has focus while a grade is being worked, and reaching for a tool
 * should not need a click first — same reasoning as the step rail's number
 * keys, and the same guard against stealing a keystroke from a text field.
 */
export function useToolShortcuts(tools: ToolRailControls | null): void {
  const { pickMode, onPickModeChange, canPick } = tools ?? {};
  useEffect(() => {
    if (!onPickModeChange) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )) return;

      if (event.key === 'Escape' && pickMode !== null) {
        event.preventDefault();
        onPickModeChange(null);
        return;
      }

      const tool = GRADE_TOOLS.find(item => item.key === event.key.toLowerCase());
      if (!tool) return;
      if (tool.mode !== null && !canPick) return;
      event.preventDefault();
      onPickModeChange(tool.mode);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickMode, onPickModeChange, canPick]);
}

/** The rail: one column, one armed tool. */
export const GradeToolRail = memo<{ tools: ToolRailControls; disabled?: boolean }>(({
  tools, disabled,
}) => (
  <div
    role="radiogroup"
    aria-label="Grading tools"
    className="flex-shrink-0 w-9 flex flex-col items-center gap-1 py-2 bg-ink-900 border-r border-ink-800"
  >
    {GRADE_TOOLS.map(({ mode, key, label, Icon }, index) => {
      const armed = tools.pickMode === mode;
      const unavailable = disabled || (mode !== null && !tools.canPick);
      return (
        <div key={label} className="contents">
          {/* The compare tool is a different kind of thing from the three
              pickers — it is the picture's default, not a sample — so a rule
              separates it rather than a gap that would read as a mistake. */}
          {index === 1 && <span className="w-4 h-px bg-ink-800 my-0.5" aria-hidden="true" />}
          <button
            type="button"
            role="radio"
            aria-checked={armed}
            disabled={unavailable}
            onClick={() => tools.onPickModeChange(mode)}
            title={unavailable ? `${label} — ${UNAVAILABLE}` : `${label} (${key.toUpperCase()})`}
            className={`relative w-7 h-7 rounded flex items-center justify-center border transition-colors
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500
              disabled:cursor-not-allowed ${
                armed
                  ? 'bg-accent-500/14 border-accent-500/55 text-accent-300'
                  : unavailable
                    ? 'border-transparent text-ink-700'
                    : 'border-transparent text-ink-400 hover:text-ink-200 hover:bg-ink-850'
              }`}
          >
            <Icon className="w-[15px] h-[15px]" />
            <span
              aria-hidden="true"
              className={`absolute right-[1px] bottom-[-1px] font-mono text-[8px] leading-none ${
                armed ? 'text-accent-300' : unavailable ? 'text-ink-800' : 'text-ink-600'
              }`}
            >
              {key.toUpperCase()}
            </span>
          </button>
        </div>
      );
    })}
  </div>
));

/**
 * The options bar, under the picture.
 *
 * Always present while a grade is open, at a fixed height, saying what the
 * armed tool wants. Always present is the point: the strip appearing and
 * disappearing would shove the picture up and down, which is the reflow the
 * old title-bar chips were guilty of. So it holds the compare tool's own line
 * when nothing is armed, and the reason when nothing *can* be armed — which is
 * the one thing a greyed-out 15px glyph cannot say for itself.
 */
export const GradeToolHint = memo<{ tools: ToolRailControls }>(({ tools }) => {
  const tool = GRADE_TOOLS.find(item => item.mode === tools.pickMode) ?? GRADE_TOOLS[0];
  const armed = tools.pickMode !== null;
  const blocked = !tools.canPick && !armed;
  const Icon = tool.Icon;

  return (
    <div
      className={`flex-shrink-0 mx-3 mb-3 h-[26px] px-2.5 rounded border flex items-center gap-2
        text-[11px] min-w-0 ${
          armed
            ? 'border-accent-500/35 bg-accent-500/[0.07] text-ink-300'
            : 'border-ink-800 bg-ink-900 text-ink-500'
        }`}
    >
      <Icon className={`w-3 h-3 flex-shrink-0 ${armed ? 'text-accent-300' : 'text-ink-600'}`} />
      <span className="truncate">
        {armed && <b className="font-semibold text-accent-300">{tool.label}</b>}
        {armed && ' — '}
        {blocked ? UNAVAILABLE : tool.hint}
      </span>
      {armed && (
        <span className="ml-auto flex-shrink-0 font-mono text-[10px] text-ink-600">
          esc to put it away
        </span>
      )}
    </div>
  );
});
