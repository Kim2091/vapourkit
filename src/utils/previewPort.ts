// src/utils/previewPort.ts — catching the playback port.
//
// Frames stream main → renderer over a MessagePort rather than one `invoke`
// per frame. The port cannot cross contextBridge, so preload re-posts it into
// the main world with `window.postMessage(msg, '*', [port])` — the documented
// Electron handoff — and this is the other end of it.
//
// The awkward part is ordering. The port is sent from the main process the
// moment the session installs, and the `preview-open` invoke resolves through
// a different mechanism; neither guarantees which lands first. So ports that
// arrive early are held by token until someone asks, and asks that arrive
// early wait. Both orders are ordinary, and neither is an error.
//
// Nothing here trusts a message it did not expect: a port is taken only from
// our own window, on our own channel, with a token this session issued.

export const PREVIEW_PORT_CHANNEL = 'vk-preview-port';

interface PortMessage {
  channel?: unknown;
  token?: unknown;
}

/** Just enough of `window` to listen on, so this tests without a DOM. */
export interface PortEventTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface PreviewPortRegistry {
  /**
   * The port for `token`, whether it has already arrived or is still coming.
   * Rejects if it does not arrive in time — a session with no port can serve
   * single frames but cannot play, and the caller needs to know that now
   * rather than when the user presses play.
   */
  await(token: string, timeoutMs?: number): Promise<MessagePort>;
  /** Drop a held port without using it, e.g. when an open was superseded. */
  discard(token: string): void;
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function createPreviewPortRegistry(
  target: PortEventTarget,
  expectedSource: unknown = target,
): PreviewPortRegistry {
  const arrived = new Map<string, MessagePort>();
  const waiting = new Map<string, (port: MessagePort) => void>();

  const onMessage = (event: MessageEvent): void => {
    // A port is a capability. Only our own window, on our own channel.
    if (expectedSource !== undefined && event.source !== expectedSource) return;
    const data = event.data as PortMessage | null;
    if (!data || data.channel !== PREVIEW_PORT_CHANNEL) return;
    if (typeof data.token !== 'string') return;
    const port = event.ports?.[0];
    if (!port) return;

    const waiter = waiting.get(data.token);
    if (waiter) {
      waiting.delete(data.token);
      waiter(port);
      return;
    }
    // Nobody is asking yet. A second port for one token would mean two opens
    // raced; the later one is the live session, so the earlier is closed.
    arrived.get(data.token)?.close();
    arrived.set(data.token, port);
  };

  target.addEventListener('message', onMessage);

  return {
    await(token, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const already = arrived.get(token);
      if (already) {
        arrived.delete(token);
        return Promise.resolve(already);
      }
      return new Promise<MessagePort>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(token);
          reject(new Error('The preview session did not hand over a playback port.'));
        }, timeoutMs);
        waiting.set(token, (port) => {
          clearTimeout(timer);
          resolve(port);
        });
      });
    },

    discard(token) {
      arrived.get(token)?.close();
      arrived.delete(token);
      waiting.delete(token);
    },

    dispose() {
      target.removeEventListener('message', onMessage);
      for (const port of arrived.values()) port.close();
      arrived.clear();
      waiting.clear();
    },
  };
}

let shared: PreviewPortRegistry | null = null;

/** The renderer's one registry, created on first use. */
export function previewPorts(): PreviewPortRegistry {
  if (!shared) shared = createPreviewPortRegistry(window, window);
  return shared;
}
