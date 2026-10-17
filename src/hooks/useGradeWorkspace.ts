// src/hooks/useGradeWorkspace.ts - The colour grading workspace: tools, scopes, layout and the preview's parking.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Filter, FilterParameterValues } from '../electron';
import type { CompareMode, PickMode } from '../components/ColorGradeOverlay';
import type { ViewerControls } from '../components/PreviewStepRail';
import type { ToolRailControls } from '../components/GradeToolRail';
import type { ScopeKind } from '../components/GradeScopes';
import { GRADE_COMPACT_BELOW, GRADE_DOCK_HEIGHT, GRADE_DOCK_COMPACT_HEIGHT } from '../components/ColorGradeDock';
import { solveScopeColumnWidth, clampScopeColumnWidth } from '../components/GradeScopeColumn';
import { solveBlackPoint, solveWhitePoint, solveNeutral, autoBalance } from '../utils/colorGrade';
import { getPortableModelName } from '../utils/modelUtils';
import { notify } from '../utils/notifications';
import { useColorGrade } from './useColorGrade';
import type { useChainPreview } from './useChainPreview';

interface UseGradeWorkspaceOptions {
  /** The step open in a visual editor, if any. */
  activeFilterEditor: Filter | null;
  activeFilterEditorId: string | null;
  setActiveFilterEditorId: (id: string | null) => void;
  onParametersChange: (filterId: string, parameters: FilterParameterValues) => void;
  filters: Filter[];
  chainPreview: ReturnType<typeof useChainPreview>;
  /** The source frame's size, for the picture's aspect. */
  cropSourceSize: { width: number; height: number } | null;
  showQueue: boolean;
  settingsWidth: number;
  addConsoleLog: (message: string) => void;
}

export function useGradeWorkspace({
  activeFilterEditor,
  activeFilterEditorId,
  setActiveFilterEditorId,
  onParametersChange: handleFilterParametersChange,
  filters,
  chainPreview,
  cropSourceSize,
  showQueue,
  settingsWidth,
  addConsoleLog,
}: UseGradeWorkspaceOptions) {
  const { isOpen: chainPreviewOpen, select: selectChainStep } = chainPreview;

  // Colour grading. The values live in the filter's parameters; the hook holds
  // the draft while a trackball is being dragged so history records one entry
  // per gesture rather than one per pixel of travel.
  const colorGrade = useColorGrade({
    filter: activeFilterEditor,
    onParametersChange: handleFilterParametersChange,
  });
  const [gradeCompareMode, setGradeCompareMode] = useState<CompareMode>('split');
  const [holdingBefore, setHoldingBefore] = useState(false);
  const [scopeSample, setScopeSample] = useState<Float32Array | null>(null);
  const [dockScope, setDockScope] = useState<ScopeKind>('parade');
  // The grading tools live in the dock, but their state lives here: the dock
  // and the viewer overlay both read it, and it has to survive the dock
  // remounting as the layout solver moves the tools between column and row.
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [showClipping, setShowClipping] = useState(false);
  const [toolsAvailable, setToolsAvailable] = useState({ canPick: false, canShowClipping: false });
  const [windowHeight, setWindowHeight] = useState(() => window.innerHeight);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => {
      setWindowHeight(window.innerHeight);
      setWindowWidth(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Grading is a mode, so it gets the window. A 16:9 window has no vertical
  // room to spare and the dock is the thing that needs width, so while a grade
  // is open the settings column folds to a strip and the preview column — dock
  // included — takes what it was using. One click brings the column back for
  // as long as this grade stays open.
  const [settingsRevealed, setSettingsRevealed] = useState(false);
  const gradeFocus = Boolean(colorGrade.editor) && !settingsRevealed;

  useEffect(() => {
    if (!colorGrade.editor) setSettingsRevealed(false);
  }, [colorGrade.editor]);

  // Where the scope column beside the picture gets its width, and why taking
  // it costs nothing. The picture is laid out object-contain, so in a pane
  // wider than the frame can use at that height the extra width goes nowhere.
  // In a 16:9 window it always is: the spare runs from 97px at 1200x675 to
  // 193px at 2560x1440 *beyond* the 380px the column asks for. So the column
  // is only ever offered out of width the picture had no use for, and it
  // disappears the moment that stops being true — a tall window, a portrait
  // source, or the settings column brought back over the top of a grade.
  // Dragged by hand this wins over the rule above, and is remembered. Null
  // means nobody has asked, so the spare-width rule keeps deciding — which is
  // also what double-clicking the handle puts it back to.
  const [scopeColumnOverride, setScopeColumnOverride] = useState<number | null>(() => {
    const stored = Number(window.localStorage.getItem('vk-scope-column-width'));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });

  useEffect(() => {
    if (scopeColumnOverride === null) window.localStorage.removeItem('vk-scope-column-width');
    else window.localStorage.setItem('vk-scope-column-width', String(scopeColumnOverride));
  }, [scopeColumnOverride]);

  const gradePaneWidth = windowWidth - 63
    - (showQueue ? 240 : 0)
    - (gradeFocus ? 34 : 5 + settingsWidth);

  const scopeColumnWidth = useMemo(() => {
    if (!colorGrade.editor) return 0;
    if (scopeColumnOverride !== null) {
      return clampScopeColumnWidth(scopeColumnOverride, gradePaneWidth);
    }
    const dockHeight = windowHeight < GRADE_COMPACT_BELOW ? GRADE_DOCK_COMPACT_HEIGHT : GRADE_DOCK_HEIGHT;
    const pictureHeight = windowHeight - (45 + 37 + dockHeight + 41) - 24;
    const aspect = cropSourceSize && cropSourceSize.height > 0
      ? cropSourceSize.width / cropSourceSize.height
      : 16 / 9;
    return solveScopeColumnWidth(gradePaneWidth, pictureHeight, aspect);
  }, [colorGrade.editor, scopeColumnOverride, gradePaneWidth, windowHeight, cropSourceSize]);

  const gradeStepLabel = useMemo(() => {
    if (!colorGrade.editor || !activeFilterEditor) return '';
    const enabled = filters.filter(filter => filter.enabled);
    const position = enabled.findIndex(filter => filter.id === activeFilterEditor.id);
    const previous = position > 0 ? enabled[position - 1] : null;
    const previousName = previous?.preset
      || (previous?.modelPath ? getPortableModelName(previous.modelPath) : null);
    if (position < 0) return 'this step is disabled';
    return previousName
      ? `step ${position + 1} of ${enabled.length} · after ${previousName}`
      : `step ${position + 1} of ${enabled.length} · from the source`;
  }, [activeFilterEditor, colorGrade.editor, filters]);

  // With a grade step open, park the session on the step BELOW it. That frame
  // is the picture entering the grade, and the shader applies the grade to it
  // on the GPU — so a trackball drag costs a draw call, not a script reload.
  // Selecting the grade's own output would show the values that were baked
  // into the script when it loaded, which is exactly the stale picture.
  // Both pickers solve the primaries ramp, not the final pixel, so contrast,
  // gamma and brightness still do what they were set to afterwards — which is
  // what a black or white point means in Resolve too.
  const handlePick = useCallback((sample: [number, number, number]) => {
    const wanted = pickMode;
    // One solve per arming, so a stray second click cannot re-solve against
    // the picture the first one just changed.
    setPickMode(null);
    if (!wanted) return;

    if (wanted === 'black') {
      const solved = solveBlackPoint(colorGrade.values, sample);
      if (!solved) {
        notify.warning(
          'Too bright for a black point',
          'That pixel is too far up the range to sit at black. Pick something in the shadows.',
        );
        return;
      }
      colorGrade.apply(solved.values);
      if (solved.clamped) {
        notify.info(
          'Black point set, partly',
          'The colour cast in those shadows is stronger than the lift ball can correct on its own.',
        );
      } else {
        addConsoleLog('Black point set from the picture');
      }
      return;
    }

    if (wanted === 'white') {
      const solved = solveWhitePoint(colorGrade.values, sample);
      if (!solved) {
        notify.warning(
          'Too dark for a white point',
          'That pixel is too far down the range to sit at white. Pick something in the highlights.',
        );
        return;
      }
      colorGrade.apply(solved.values);
      if (solved.clamped) {
        notify.info(
          'White point set, partly',
          'The colour cast in those highlights is stronger than the gain ball can correct on its own.',
        );
      } else {
        addConsoleLog('White point set from the picture');
      }
      return;
    }

    // Neutral is the odd one out: it writes the two tone sliders rather than a
    // ball, because temperature and tint are where a colour cast is stored.
    const solved = solveNeutral(colorGrade.values, sample);
    if (!solved) {
      notify.warning(
        'Nothing to balance there',
        'That pixel sits too near black or white to carry a cast. Pick something in the midtones.',
      );
      return;
    }
    colorGrade.apply(solved.values);
    if (solved.clamped) {
      notify.info(
        'Balanced, partly',
        'That cast runs further than temperature and tint reach. What is left is not a white balance error.',
      );
    } else {
      addConsoleLog(
        `Neutral picked — ${solved.values.temperature.toFixed(0)}K, tint ${solved.values.tint.toFixed(1)}`,
      );
    }
  }, [pickMode, colorGrade, addConsoleLog]);

  // Reads the two ends off the scope sample — the same 240px buffer the scopes
  // already grade, so this costs no extra readback — and solves lift and gain
  // together against them.
  const handleAutoBalance = useCallback(() => {
    const solved = autoBalance(colorGrade.values, scopeSample);
    if (!solved) {
      notify.warning(
        'Nothing to balance',
        'This frame has no usable range to read a black and a white off. Try a frame with more in it.',
      );
      return;
    }

    colorGrade.apply(solved.values);
    if (!solved.solved.black || !solved.solved.white) {
      // Half an answer is still worth having, but saying so is the difference
      // between a tool that missed and a tool that looks broken.
      const end = solved.solved.black ? 'black' : 'white';
      notify.info(
        `Only the ${end} point was set`,
        'The picture does not reach far enough the other way for both ends to be solved.',
      );
    } else if (solved.clamped) {
      notify.info(
        'Balanced, partly',
        'The cast in this frame is stronger than the lift and gain balls can correct on their own.',
      );
    } else {
      addConsoleLog('Auto balance set the black and white points from the frame');
    }
  }, [colorGrade, scopeSample, addConsoleLog]);

  // The panel reports on every frame change, so this only stores an answer
  // that actually changed — otherwise a new object each time would re-render
  // the whole grading surface behind every preview frame.
  const handleToolAvailability = useCallback((next: { canPick: boolean; canShowClipping: boolean }) => {
    setToolsAvailable(current =>
      current.canPick === next.canPick && current.canShowClipping === next.canShowClipping
        ? current
        : next);
  }, []);

  // A picker armed against a picture it can no longer be used on is a click
  // that will never land, so the panel's answer disarms it.
  useEffect(() => {
    if (!toolsAvailable.canPick) setPickMode(null);
  }, [toolsAvailable.canPick]);

  // Two groups, not one, because they are two kinds of thing. The viewer
  // controls change how the picture is shown and ride the step rail above it;
  // the tool rail changes what a click on the picture does. Auto balance is
  // neither — it is a command, and it goes to the dock header beside Reset all.
  const viewerControls = useMemo<ViewerControls>(() => ({
    compareMode: gradeCompareMode,
    onCompareModeChange: setGradeCompareMode,
    holdingBefore,
    showClipping,
    onShowClippingChange: setShowClipping,
    canShowClipping: toolsAvailable.canShowClipping,
    // Only a session can offer a choice: without one there is a single frame,
    // and the only "before" available is that frame ungraded.
    reference: chainPreview.isOpen
      ? {
          steps: chainPreview.steps.map(step => ({ index: step.index, label: step.label })),
          pinned: chainPreview.reference,
          onPin: chainPreview.setReference,
        }
      : null,
  }), [
    gradeCompareMode, holdingBefore, showClipping, toolsAvailable.canShowClipping,
    chainPreview.isOpen, chainPreview.steps, chainPreview.reference, chainPreview.setReference,
  ]);

  const toolRail = useMemo<ToolRailControls>(() => ({
    pickMode,
    onPickModeChange: setPickMode,
    canPick: toolsAvailable.canPick,
  }), [pickMode, toolsAvailable.canPick]);

  const gradeUpstreamOutput = useMemo(() => {
    if (!colorGrade.editor || !activeFilterEditor) return null;
    const enabled = filters.filter(filter => filter.enabled).sort((a, b) => a.order - b.order);
    const position = enabled.findIndex(filter => filter.id === activeFilterEditor.id);
    // Output 0 is the source, so the filter at position p produces output
    // p + 1 and receives output p.
    return position < 0 ? null : position;
  }, [colorGrade.editor, activeFilterEditor, filters]);

  const lastChainStep = chainPreview.steps.length
    ? chainPreview.steps[chainPreview.steps.length - 1].index
    : null;

  // Park once per open editor, rather than on a transition.
  //
  // Watching for a change in the step was wrong in a way that showed up only
  // in the ordering people actually use: opening takes a moment, and anything
  // that set the grade step while the session was still opening left the
  // before and after values equal by the time it was open. The effect then
  // concluded nothing had changed and never selected anything, so the session
  // sat on the last step until a tab was clicked by hand.
  //
  // Keyed on the editor instead, both orderings park exactly once, and a step
  // chosen by hand afterwards is left alone.
  const parkedForRef = useRef<string | null>(null);
  const parkKey = gradeUpstreamOutput === null
    ? null
    : `${activeFilterEditorId}:${gradeUpstreamOutput}`;

  useEffect(() => {
    if (!chainPreviewOpen) {
      parkedForRef.current = null;
      return;
    }

    if (parkKey === null) {
      // The grade closed, so show the whole chain again — once.
      if (parkedForRef.current !== null && lastChainStep !== null) {
        parkedForRef.current = null;
        selectChainStep(lastChainStep);
      }
      return;
    }

    if (parkedForRef.current === parkKey) return;
    parkedForRef.current = parkKey;
    selectChainStep(gradeUpstreamOutput!);
  }, [chainPreviewOpen, parkKey, gradeUpstreamOutput, lastChainStep, selectChainStep]);

  useEffect(() => {
    if (!activeFilterEditorId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveFilterEditorId(null);
      // Hold to see the frame entering this step. Ignored while typing, so a
      // "b" in the code editor or a filename never flickers the preview.
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (!typing && (event.key === 'b' || event.key === 'B')) setHoldingBefore(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'b' || event.key === 'B') setHoldingBefore(false);
    };
    // A window that loses focus mid-hold would otherwise stay stuck on "before".
    const onBlur = () => setHoldingBefore(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [activeFilterEditorId]);

  useEffect(() => {
    if (!colorGrade.editor) setHoldingBefore(false);
  }, [colorGrade.editor]);

  return {
    colorGrade,
    gradeCompareMode,
    holdingBefore,
    scopeSample,
    setScopeSample,
    dockScope,
    setDockScope,
    pickMode,
    showClipping,
    windowHeight,
    gradeFocus,
    setSettingsRevealed,
    scopeColumnWidth,
    setScopeColumnOverride,
    gradePaneWidth,
    gradeStepLabel,
    handlePick,
    handleAutoBalance,
    handleToolAvailability,
    viewerControls,
    toolRail,
    gradeUpstreamOutput,
  };
}
