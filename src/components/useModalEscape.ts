import { useEffect, useRef } from 'react';

// Open modals that close on Escape, oldest first. Escape closes only the
// newest one, so a dialog opened over another closes before the one beneath.
const stack: Array<() => void> = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || stack.length === 0) return;
  // A confirmation prompt (ConfirmDialogHost) answers its own Escape.
  if (document.querySelector('[role="alertdialog"]')) return;
  event.preventDefault();
  stack[stack.length - 1]();
}

/**
 * Puts a modal's close on top of the Escape stack. The returned function
 * takes it off again.
 */
export function pushModalEscape(close: () => void): () => void {
  const entry = () => close();
  stack.push(entry);
  if (stack.length === 1) window.addEventListener('keydown', onKeyDown);
  return () => {
    const index = stack.indexOf(entry);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0) window.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * Closes the modal on Escape while `enabled`. The key is read in the bubble
 * phase, after the modal's own controls: a control that uses Escape itself
 * (an open suggestion list, say) stops its propagation to keep the modal open.
 */
export function useModalEscape(onClose: (() => void) | undefined, enabled = true): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!enabled) return;
    return pushModalEscape(() => onCloseRef.current?.());
  }, [enabled]);
}
