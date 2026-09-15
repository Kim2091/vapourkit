import { describe, it, expect, vi } from 'vitest';
import {
  createPreviewPortRegistry,
  PREVIEW_PORT_CHANNEL,
  type PortEventTarget,
} from './previewPort';

/** A stand-in for the one MessagePort method this module ever calls. */
function fakePort() {
  return { close: vi.fn() } as unknown as MessagePort;
}

function harness() {
  const listeners = new Set<(event: MessageEvent) => void>();
  const target: PortEventTarget = {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  const source = { name: 'window' };
  const registry = createPreviewPortRegistry(target, source);

  const deliver = (data: unknown, ports: MessagePort[], from: unknown = source) => {
    const event = { data, ports, source: from } as unknown as MessageEvent;
    for (const listener of listeners) listener(event);
  };

  return { registry, deliver, source, listenerCount: () => listeners.size };
}

const message = (token: string) => ({ channel: PREVIEW_PORT_CHANNEL, token });

describe('createPreviewPortRegistry', () => {
  it('hands over a port that arrived before anyone asked', async () => {
    const h = harness();
    const port = fakePort();
    h.deliver(message('abc'), [port]);

    await expect(h.registry.await('abc')).resolves.toBe(port);
  });

  it('hands over a port that arrives after the ask', async () => {
    const h = harness();
    const port = fakePort();
    const pending = h.registry.await('abc');
    h.deliver(message('abc'), [port]);

    await expect(pending).resolves.toBe(port);
  });

  it('keeps tokens apart, so a superseded open cannot answer a live one', async () => {
    const h = harness();
    const stale = fakePort();
    const live = fakePort();
    h.deliver(message('old'), [stale]);
    h.deliver(message('new'), [live]);

    await expect(h.registry.await('new')).resolves.toBe(live);
    await expect(h.registry.await('old')).resolves.toBe(stale);
  });

  it('gives each port out once', async () => {
    const h = harness();
    const port = fakePort();
    h.deliver(message('abc'), [port]);

    await expect(h.registry.await('abc')).resolves.toBe(port);
    await expect(h.registry.await('abc', 10)).rejects.toThrow(/playback port/);
  });

  it('closes the loser when two ports race for one token', async () => {
    const h = harness();
    const first = fakePort();
    const second = fakePort();
    h.deliver(message('abc'), [first]);
    h.deliver(message('abc'), [second]);

    expect(first.close).toHaveBeenCalled();
    await expect(h.registry.await('abc')).resolves.toBe(second);
  });

  it('ignores messages from anywhere but our own window', async () => {
    const h = harness();
    const port = fakePort();
    h.deliver(message('abc'), [port], { name: 'an iframe' });

    await expect(h.registry.await('abc', 10)).rejects.toThrow(/playback port/);
  });

  it('ignores traffic on other channels and malformed messages', async () => {
    const h = harness();
    h.deliver({ channel: 'something-else', token: 'abc' }, [fakePort()]);
    h.deliver({ channel: PREVIEW_PORT_CHANNEL }, [fakePort()]);
    h.deliver({ channel: PREVIEW_PORT_CHANNEL, token: 7 }, [fakePort()]);
    h.deliver(message('abc'), []);
    h.deliver(null, [fakePort()]);

    await expect(h.registry.await('abc', 10)).rejects.toThrow(/playback port/);
  });

  it('rejects rather than hanging when no port ever comes', async () => {
    const h = harness();
    await expect(h.registry.await('abc', 10)).rejects.toThrow(
      /did not hand over a playback port/,
    );
  });

  it('discards a held port, closing it', () => {
    const h = harness();
    const port = fakePort();
    h.deliver(message('abc'), [port]);

    h.registry.discard('abc');
    expect(port.close).toHaveBeenCalled();
  });

  it('unhooks the listener and closes what it held on dispose', () => {
    const h = harness();
    const port = fakePort();
    h.deliver(message('abc'), [port]);

    h.registry.dispose();

    expect(port.close).toHaveBeenCalled();
    expect(h.listenerCount()).toBe(0);
  });
});
