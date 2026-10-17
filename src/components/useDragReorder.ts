import { useState } from 'react';
import type { DragEvent } from 'react';
import type { Filter } from '../electron.d';
import { isSideChainHead } from '../../electron/chainGraph';

/**
 * Where a dragged step may land. A step lands beside any other step and
 * joins that step's chain, or on a Load Video to become the first step of
 * its side chain: dragging is how a step moves into or out of a side chain,
 * and the indent it lands in shows which video it now runs on. A Load Video
 * lands only on another Load Video, moving its whole side chain.
 */
export function canDropOn(steps: Filter[], sourceId: string | null, targetId: string): boolean {
  const source = steps.find(f => f.id === sourceId);
  const target = steps.find(f => f.id === targetId);
  if (!source || !target) return true;
  if (isSideChainHead(source)) return isSideChainHead(target);
  return true;
}

/** The chain a step dropped on `target` joins: a Load Video's own, or the target's. */
function chainAfterDrop(target: Filter): string | undefined {
  return isSideChainHead(target) ? target.id : target.chain;
}

/** Moves a step into a chain, keeping `chain` absent for the main one as saved workflows expect. */
export function withChain(step: Filter, chain: string | undefined): Filter {
  const { chain: _old, ...rest } = step;
  void _old;
  return chain ? { ...rest, chain } : rest;
}

/**
 * The steps with `draggedId` moved to where `targetId` is, numbered in their
 * new order. A step takes the chain of where it lands; a Load Video keeps its
 * own, and normalizing regroups its side chain under it wherever it landed.
 * `reveal` is the side chain a step was dropped into the head of. Null when
 * the drop does nothing.
 */
export function moveStepOnto(
  steps: Filter[],
  draggedId: string | null,
  targetId: string,
): { steps: Filter[]; reveal?: string } | null {
  if (!draggedId || draggedId === targetId || !canDropOn(steps, draggedId, targetId)) return null;

  const draggedIndex = steps.findIndex(f => f.id === draggedId);
  const targetIndex = steps.findIndex(f => f.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1) return null;

  const next = [...steps];
  const [dragged] = next.splice(draggedIndex, 1);
  const target = steps[targetIndex];
  const moved = isSideChainHead(dragged) ? dragged : withChain(dragged, chainAfterDrop(target));
  next.splice(targetIndex, 0, moved);
  const reveal = isSideChainHead(target) && !isSideChainHead(dragged) ? target.id : undefined;

  return { steps: next.map((f, index) => ({ ...f, order: index })), reveal };
}

/** The steps with `draggedId` moved after the last step of side chain `chainId`; null for a Load Video. */
export function moveStepToChainEnd(steps: Filter[], draggedId: string | null, chainId: string): Filter[] | null {
  const dragged = steps.find(f => f.id === draggedId);
  if (!dragged || isSideChainHead(dragged)) return null;
  const last = steps.filter(f => f.id === chainId || f.chain === chainId)
    .reduce((max, f) => Math.max(max, f.order), -1);
  return steps.map(f => f.id === dragged.id ? { ...withChain(f, chainId), order: last + 0.5 } : f);
}

interface DragReorderOptions {
  steps: Filter[];
  /** Commits a reordered chain. */
  commit: (steps: Filter[]) => void;
  /** Unfolds a side chain a step was dropped into. */
  reveal: (chainId: string) => void;
}

/** Dragging steps to reorder the chain, and into and out of side chains. */
export function useDragReorder({ steps, commit, reveal }: DragReorderOptions) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const dragged = steps.find(f => f.id === draggedId);
  /** A Load Video is being dragged, so a drop moves a whole side chain. */
  const draggingHead = dragged !== undefined && isSideChainHead(dragged);
  /** A step (not a Load Video) is being dragged. */
  const draggingStep = draggedId !== null && !draggingHead;

  const onDragStart = (e: DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e: DragEvent, id: string) => {
    if (draggedId && !canDropOn(steps, draggedId, id)) {
      e.dataTransfer.dropEffect = 'none';
      setDragOverId(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedId !== id) {
      setDragOverId(id);
    }
  };

  const onDragLeave = () => {
    setDragOverId(null);
  };

  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const result = moveStepOnto(steps, draggedId, targetId);
    if (result) {
      if (result.reveal) reveal(result.reveal);
      commit(result.steps);
    }
    setDraggedId(null);
  };

  /** The zone under a side chain's last step while a step is dragged. */
  const onChainEndDragOver = (e: DragEvent, chainId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(`end:${chainId}`);
  };

  const onDropAtChainEnd = (e: DragEvent, chainId: string) => {
    e.preventDefault();
    setDragOverId(null);
    const moved = moveStepToChainEnd(steps, draggedId, chainId);
    setDraggedId(null);
    if (!moved) return;
    reveal(chainId);
    commit(moved);
  };

  const onDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  return {
    draggedId,
    dragOverId,
    draggingHead,
    draggingStep,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    onChainEndDragOver,
    onDropAtChainEnd,
    onDragEnd,
  };
}
