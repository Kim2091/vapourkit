// src/utils/beforeClose.ts — work that must happen as the window closes, in order.
//
// Edits are held back in a few places (a step's code is committed when the
// editor loses focus) and saved on a delay in others (a queue item's edits,
// the queue itself). Closing the window skips both. One beforeunload listener
// runs everything registered here, and runs it in phases, because order
// matters: a held-back edit has to be committed before the queue is written,
// or the queue is written without it. Separate listeners run in the order they
// were added, which changes whenever a component remounts.

type Phase = 'commit' | 'save';

const handlers: Record<Phase, Set<() => void>> = {
  commit: new Set(),
  save: new Set(),
};

let installed = false;

function runAll(): void {
  for (const phase of ['commit', 'save'] as const) {
    for (const handler of handlers[phase]) {
      try {
        handler();
      } catch (error) {
        // One failure must not stop the rest from saving.
        console.error(`Error while closing (${phase}):`, error);
      }
    }
  }
}

/**
 * Run handler as the window closes: 'commit' handlers first (put held-back
 * edits into state), then 'save' handlers (write state to disk). Returns the
 * unregister function, for an effect's cleanup.
 */
export function onBeforeClose(phase: Phase, handler: () => void): () => void {
  if (!installed && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', runAll);
    installed = true;
  }
  handlers[phase].add(handler);
  return () => {
    handlers[phase].delete(handler);
  };
}
