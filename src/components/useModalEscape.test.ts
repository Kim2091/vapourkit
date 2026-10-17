import { afterEach, describe, expect, it, vi } from 'vitest';

const target = new EventTarget();
let alertOpen = false;
vi.stubGlobal('window', target);
vi.stubGlobal('document', { querySelector: () => (alertOpen ? {} : null) });

const { pushModalEscape } = await import('./useModalEscape');

function press(key: string) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key });
  target.dispatchEvent(event);
  return event;
}

describe('pushModalEscape', () => {
  const pops: Array<() => void> = [];
  afterEach(() => {
    pops.splice(0).forEach(pop => pop());
    alertOpen = false;
  });

  it('closes only the newest modal', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    pops.push(pushModalEscape(outer), pushModalEscape(inner));
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('hands Escape back to the modal beneath once the top one is gone', () => {
    const outer = vi.fn();
    pops.push(pushModalEscape(outer));
    const popInner = pushModalEscape(vi.fn());
    popInner();
    press('Escape');
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const close = vi.fn();
    pops.push(pushModalEscape(close));
    press('Enter');
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves Escape to an open confirmation prompt', () => {
    const close = vi.fn();
    pops.push(pushModalEscape(close));
    alertOpen = true;
    press('Escape');
    expect(close).not.toHaveBeenCalled();
  });

  it('stops listening when no modal is open', () => {
    const close = vi.fn();
    pushModalEscape(close)();
    press('Escape');
    expect(close).not.toHaveBeenCalled();
  });
});
