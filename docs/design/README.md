# GUI redesign — design record

Interface direction agreed for the post-0.17 GUI. The workflow is unchanged: drop a file, stack
filters in order, set the output, start. What changes is how much of the window that workflow is
allowed to use, and what colour it wears.

## Files

| File | What it is |
| --- | --- |
| [`concepts-three-way.html`](concepts-three-way.html) | The original pitch — three layout concepts (Console / Pipeline / Workbench) plus the space audit and the six secondary-colour candidates. Kept as the record of what was considered and rejected. |
| [`concept-a-final.html`](concept-a-final.html) | **The chosen direction.** Concept A with the agreed revisions. Queue pane and segment toggles are live in the mockup. |

Both are self-contained — open them in a browser, no server or build needed. The swatches at the top
of each page retint every mockup, so they double as the colour-picking tool.

## Chosen direction — "Console"

Concept A, with three revisions agreed after the first review:

1. **Segment selection moves onto a scrubber** welded to the bottom of the preview. Handles set in and
   out, the region outside them dims, the playhead shows where the preview frame came from.
   Frame-exact entry survives in a popover on the Segment chip, with "set from playhead" bridging drag
   and type.
2. **The queue becomes a collapsible left pane** (240px), toggled from the rail with a count badge —
   not a bottom panel that steals height from the preview.
3. **Video info returns as an input → output ledger** — five paired rows instead of two stacked
   columns, with the accent applied only to rows the pipeline actually changes.

### Structure

```
┌────┬──────────┬────────────────────────┬───────────────┐
│    │          │  strip 44px                            │
│rail├──────────┼────────────────────────┼───────────────┤
│56px│ queue    │  preview               │ settings      │
│    │ 240px    │                        │ 400px fixed   │
│    │ collapsi-├────────────────────────┤ SOURCE        │
│    │ ble      │  scrubber 36px         │ FILTERS       │
│    │          │                        │ OUTPUT        │
│    │          │                        │ INPUT→OUTPUT  │
│    │          │                        │ ADVANCED      │
├────┴──────────┴────────────────────────┴───────────────┤
│  action bar 44px — progress line is its top edge       │
└────────────────────────────────────────────────────────┘
```

Minimum comfortable width is ~1150px (56 rail + 240 queue + 400 settings leaves 454px of preview).
Below that the queue auto-collapses rather than squeezing the preview, and stays where the user last
put it rather than re-opening when the window grows back.

## Why — the space audit

Measured from the class lists as of 0.17. None of this is a layout problem; it is chrome.

| Cost | Where | Source |
| ---: | --- | --- |
| 80px | Header — five buttons stacking a 20px icon over a text label that repeats the tooltip | `Header.tsx` |
| ~200px | Five floating cards in the right column: borders + 24–32px vertical padding + gaps, before a single control is drawn | `App.tsx` |
| ~~~50px~~ 0 | ~~Card-in-card~~ — **audit error.** `FilterStepPanel.tsx` contained the card-in-card, but nothing rendered it: 351 lines of dead code. That cost was never being paid. File deleted in step 4. | ~~`FilterStepPanel.tsx`~~ |
| ~150px | A full card carrying four numbers at `text-base`, plus a second card whose collapsed state is just a title row | `ProgressPanel.tsx` |
| ~150px | A permanent 32px icon and three lines of drop instructions long after a file is loaded | `VideoInputPanel.tsx` |
| 56px | `py-4 px-6` on three buttons at the bottom of a column that has to scroll to reach them | `ActionButtons.tsx` |

**≈380px** of vertical space on borders, padding and repeated labels — about 42% of a 900px window.
(Originally stated as ≈430px; corrected after the `FilterStepPanel` row turned out to be dead code.)

## Colour system

Greys are one HSL ramp rather than hand-picked hexes, so the whole app retunes from a single
hue/saturation pair.

| Temperature | Hue | Sat | Character |
| --- | --- | --- | --- |
| Cool | 220 | 5% | Faint blue bias — reads as "screen". Chosen. |
| True | 0 | 0% | Dead neutral, most severe. |
| Warm | 28 | 6% | Leans toward paper, softens the dark UI. |

### Secondary — collision analysis

The constraint is not taste. Vapourkit already spends colour on meaning, so an accent landing on an
existing semantic makes the interface lie.

| Name | Hex | Verdict |
| --- | --- | --- |
| Ember | `#e0703c` | **Collides** — sits on the orange used for benchmark mode and stopping. Taking it means moving those to red first. |
| Brass | `#c9a35a` | **Collides** — closest to the amber meaning warning, privacy mode and "engine building". |
| Signal | `#b6d94d` | Watch — clearly separate from success green at button size, muddier at 10px on a chip. |
| Teal | `#3fb9a6` | **Clear** — no warm-hue collisions. Nearest neighbour is success green and it stays distinguishable at small sizes. |
| Clay | `#cd6a55` | Watch — neighbour is error red. Fine on chrome and selection, never on a button that could read as destructive. |
| Steel | `#93a7bd` | **Clear** — the "no accent" option. Active states are just a lighter, cooler grey; every saturated colour left in the UI means something. |

### Semantics stay fixed

These four keep their jobs regardless of the accent. That is what frees the accent to be decorative.

| Token | Hex | Meaning |
| --- | --- | --- |
| `ok` | `#3ecf8e` | Valid, complete, engine built |
| `warn` | `#e0b341` | Warning, privacy on, building engine |
| `bad` | `#ef5f5f` | Error, stop, destructive |
| `accent` | *chosen* | Active, selected, primary action |

### Token shape

Replaces the current `dark-bg` / `dark-surface` / `dark-elevated` / `primary-blue` / `primary-purple` /
`accent-cyan`, which is why the blue-purple is currently sprayed across ~30 files. Numbered ramp plus
one accent means the next colour change is a two-line edit.

```js
colors: {
  ink: {
    950: '…',  // app background
    900: '…',  // panel
    850: '…',  // raised / hover
    800: '…',  // input fill
    750: '…',  // border
  },
  accent: '…',
  ok: '#3ecf8e', warn: '#e0b341', bad: '#ef5f5f',
}
```

## Consequences agreed

- **The "Editing Queue Item" banner retires.** It exists because the queue can be hidden while editing
  one of its items. With the queue a persistent selectable list, the selected row *is* the banner — and
  when the pane is collapsed the Source section header still names the item.
- **`SegmentSelector` loses its card, keeps its brain.** Frame-accurate inputs, duration maths and
  preview seeking all survive; the scrubber becomes the primary control and the popover keeps the
  numbers. What disappears is the card wrapper and header.
- **The Source section means "what these settings apply to"**, distinct from the queue's "what's lined
  up". That distinction only works if queue selection drives it.
- **The ledger says `pending`, not `N/A`.** Output fields are derived from the filter chain; an
  unresolved row reads as dim `pending` rather than presenting five `N/A`s as if they were data.

## Build order

Each step ships and reverts independently. Steps 1–4 are the ~380px; 5–7 are the agreed revisions.

1. ~~**Tokens**~~ — **done.** Neutral ramp + accent in the Tailwind config; 726 class replacements
   across 28 files. Nothing moved, everything changed colour. → `tailwind.config.js`, `src/index.css`,
   `electron/windowManager.ts`
2. ~~**Rail and strip**~~ — **done.** `Header.tsx` (332 lines, 80px tall) is gone, replaced by
   `AppRail.tsx` (56px, full height, icons only) and `TitleStrip.tsx` (44px, data not boxes). The three
   workflow buttons collapsed into one rail menu; the centred wordmark and tagline are gone; the
   privacy indicator no longer renders twice. → `AppRail.tsx`, `TitleStrip.tsx`, `App.tsx`, `Logo.tsx`
3. ~~**Bottom bar**~~ — **done.** `ProgressPanel.tsx` and `ActionButtons.tsx` are gone, replaced by
   `ActionBar.tsx` (52px, full width, progress is its top edge), `ConsoleDrawer.tsx` (opens over the
   preview, costs nothing closed) and `EngineBuildBanner.tsx`. The no-filters banner became an inline
   chip. Actions are now reachable at any scroll position. → `ActionBar.tsx`, `ConsoleDrawer.tsx`,
   `EngineBuildBanner.tsx`, `App.tsx`
4. ~~**Flatten the settings column**~~ — **done.** `Section.tsx` is the column's only structural
   device: a sticky 32px header plus a hairline, in place of five cards' borders, padding and gaps.
   Source, Filters, Colorimetry, Output and Input→Output are all sections. Filter rows are flat and
   hairline-separated, with a left edge carrying AI-vs-custom instead of two competing hues, and the
   accent is back to marking only active / selected / primary. `FilterStepPanel.tsx` deleted as dead
   code. → `Section.tsx`, `App.tsx`, all five panels
5. ~~**Queue to the left pane**~~ — **done.** `QueuePanel` was horizontal 288px cards built for a
   bottom panel; it is now a 240px vertical list of 32px rows outside the `PanelGroup`, so opening it
   costs the preview width rather than its height. Row actions appear on hover. The editing banner is
   retired — the Source header now reads `editing N of M`. → `QueuePanel.tsx`, `App.tsx`,
   `VideoInputPanel.tsx`
6. ~~**Scrubber and segment**~~ — **done.** `Scrubber.tsx` is a 40px timeline under the preview:
   drag the handles to set in and out, excluded region dims, playhead marks the frame the preview is
   showing. Frame-exact entry, duration maths, reset and “preview selection” all live in the popover,
   plus new “in/out here” actions that set a handle from the playhead. `SegmentSelector.tsx` deleted.
   → `Scrubber.tsx`, `App.tsx`, `ModelSelectionPanel.tsx`
7. ~~**Ledger**~~ — **done.** Five paired rows, accent only where input and output actually differ, so
   a resize that did not take or an interlaced source that stays interlaced reads as a missing colour.
   Unresolved rows say `pending` in dim italic rather than five `N/A`s. Interlaced input is flagged in
   `warn` regardless. Section meta counts the changes. → `VideoPanel.tsx`

**All seven steps are complete.** The migration aliases have been removed from `tailwind.config.js`;
a grep for `dark-*` / `primary-*` / `accent-cyan` across `src/` and `electron/` returns nothing, and the
built CSS contains no blue-500, purple, cyan or default-gray values.

## Implementation notes

**Don't sweep `emerald` or `teal` when recolouring.** The first codemod pass mapped every cool hue to
the accent, which silently turned the GPU meter's healthy state (`emerald`) and the Preview button
(`teal`) into accent teal — collapsing two things that carried meaning into decoration. Both are now on
`ok-*` / neutral `ink-*`. The hues safe to sweep are `blue`, `purple`, `violet`, `indigo`, `cyan`, `sky`.

**The app is deliberately over-accented after step 1.** Everything that used to be blue *or* purple *or*
cyan is now the same teal, which is far more accent than the design calls for. Steps 2–4 dial it back
component by component as each one is rebuilt — the target is accent on active/selected/primary only,
with structure carried entirely by `ink-*`.

**Migration aliases have been removed.** They served their purpose across steps 1–7 and are gone. Every
colour class in `src/` now resolves through `ink-*` / `accent-*` / `ok` / `warn` / `bad`.

**Nothing inside a section outranks its header.** The 13px section header is the largest text in the
settings column; field labels are 10px uppercase, controls 11–12.5px at 28px tall, and the code editor
runs at 12px. The first pass missed the filter panel’s expanded content (model picker, templates,
description, editor), which kept card-era `text-base` and inverted the hierarchy. Sections are also
separated by an 8px groove of bare column background before the next rule and header band.

**The rail expands.** A toggle at its foot switches 56px icons ↔ 184px icons-with-labels (persisted).
The queue toggle lives on the rail with a live count badge — panes are shown and hidden from the rail,
not from inside a settings section.

**The middle of the window is flush, like the top and bottom.** The strip and action bar run edge to
edge, so the panes between them do too — no padded gutter, no rounded cards, hairline (`ink-800`)
boundaries between panes. The settings column is a fixed 400px (not proportional): on a 2560px display
a percentage column stretched to ~970px and the dense controls looked lost in it. Resizing is a
pixel-based drag on the column’s left edge (320–720px clamp, persisted in localStorage), replacing
the `react-resizable-panels` percentage split.

**Verify colours in the built CSS as `rgb(R G B / …)`, not hex.** Tailwind emits the rgb form for any
colour that supports opacity modifiers, so grepping the bundle for `#3b82f6` proves nothing — it only
finds literals written directly in `index.css`. Two real bugs hid behind that mistake:

- Tailwind's default `--tw-ring-color` is blue-500 and its ring offset is white, so every focus ring in
  the app would have flashed blue on a dark ground. Both are now overridden in the config.
- `bad-300` and `bad-900` did not exist in the semantic scales, so `hover:text-bad-300` on the filter
  delete button rendered as no colour at all. All three ramps are now full 200–900.
