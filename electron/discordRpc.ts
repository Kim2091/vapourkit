import * as net from 'node:net';
import * as path from 'node:path';

const DISCORD_RPC_VERSION = 1;
const MAX_FRAME_SIZE = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 1_000;
const RECONNECT_DELAY_MS = 30_000;

const enum Opcode {
  Handshake = 0,
  Frame = 1,
  Close = 2,
  Ping = 3,
  Pong = 4,
}

export interface DiscordRichPresenceActivity {
  details?: string;
  state?: string;
  /** Unix timestamp in seconds. */
  startTimestamp?: number;
}

interface DiscordFrame {
  opcode: number;
  payload: Record<string, unknown>;
}

interface DiscordWireActivity {
  details?: string;
  state?: string;
  timestamps?: { start: number };
}

function trimActivityText(value: string | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, 128);
  return trimmed || undefined;
}

/** Converts application activity into the compact payload Discord expects. */
export function normalizeDiscordActivity(activity: DiscordRichPresenceActivity): DiscordWireActivity {
  const details = trimActivityText(activity.details);
  const state = trimActivityText(activity.state);
  const startTimestamp = Number.isFinite(activity.startTimestamp)
    ? Math.floor(activity.startTimestamp!)
    : undefined;

  return {
    ...(details ? { details } : {}),
    ...(state ? { state } : {}),
    ...(startTimestamp && startTimestamp > 0 ? { timestamps: { start: startTimestamp } } : {}),
  };
}

export function encodeDiscordFrame(opcode: number, payload: Record<string, unknown>): Buffer {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(encodedPayload.length, 4);
  return Buffer.concat([header, encodedPayload]);
}

export function decodeDiscordFrames(buffer: Buffer): { frames: DiscordFrame[]; remainder: Buffer } {
  const frames: DiscordFrame[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const opcode = buffer.readUInt32LE(offset);
    const payloadLength = buffer.readUInt32LE(offset + 4);
    if (payloadLength > MAX_FRAME_SIZE) {
      throw new Error(`Discord RPC frame exceeds ${MAX_FRAME_SIZE} bytes`);
    }
    if (offset + 8 + payloadLength > buffer.length) break;

    const payloadBuffer = buffer.subarray(offset + 8, offset + 8 + payloadLength);
    const parsedPayload = JSON.parse(payloadBuffer.toString('utf8')) as unknown;
    if (typeof parsedPayload === 'object' && parsedPayload !== null && !Array.isArray(parsedPayload)) {
      frames.push({ opcode, payload: parsedPayload as Record<string, unknown> });
    }
    offset += 8 + payloadLength;
  }

  return { frames, remainder: buffer.subarray(offset) };
}

function getDiscordIpcEndpoints(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    return Array.from({ length: 10 }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }

  const runtimeDirectories = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp',
  ].filter((directory): directory is string => Boolean(directory));

  return [...new Set(runtimeDirectories)].flatMap(directory =>
    Array.from({ length: 10 }, (_, index) => path.join(directory, `discord-ipc-${index}`))
  );
}

/**
 * Small, dependency-free Discord IPC client. It deliberately treats Discord as
 * optional: a missing desktop client never blocks or errors the Vapourkit UI.
 */
export class DiscordRpcClient {
  private socket: net.Socket | null = null;
  private receiveBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private clientId = '';
  private desiredActivity: DiscordWireActivity | null = null;
  private isReady = false;
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionGeneration = 0;

  setActivity(clientId: string, activity: DiscordRichPresenceActivity): void {
    const normalizedClientId = clientId.trim();
    const activityChanged = JSON.stringify(this.desiredActivity) !== JSON.stringify(normalizeDiscordActivity(activity));
    const clientChanged = this.clientId !== normalizedClientId;

    this.clientId = normalizedClientId;
    this.desiredActivity = normalizeDiscordActivity(activity);

    if (clientChanged) {
      this.disconnect(false);
    }

    if (this.socket && this.isReady) {
      if (activityChanged || clientChanged) this.sendActivity();
      return;
    }

    this.connect();
  }

  clearActivity(): void {
    if (this.socket && this.isReady) {
      this.sendFrame(Opcode.Frame, {
        cmd: 'SET_ACTIVITY',
        nonce: this.createNonce(),
        args: { pid: process.pid, activity: null },
      });
    }
    this.desiredActivity = null;
    this.clientId = '';
    this.disconnect(false);
  }

  shutdown(): void {
    this.clearActivity();
  }

  private connect(): void {
    if (this.isConnecting || this.socket || !this.clientId || !this.desiredActivity) return;

    this.isConnecting = true;
    const generation = ++this.connectionGeneration;
    void this.connectToDiscord(generation);
  }

  private async connectToDiscord(generation: number): Promise<void> {
    try {
      for (const endpoint of getDiscordIpcEndpoints()) {
        if (generation !== this.connectionGeneration || !this.clientId) return;
        const socket = await this.connectToEndpoint(endpoint);
        if (!socket) continue;

        if (generation !== this.connectionGeneration || !this.clientId) {
          socket.destroy();
          return;
        }

        this.socket = socket;
        this.isConnecting = false;
        this.receiveBuffer = Buffer.alloc(0);
        this.attachSocketListeners(socket);
        this.sendFrame(Opcode.Handshake, {
          v: DISCORD_RPC_VERSION,
          client_id: this.clientId,
        });
        return;
      }
    } finally {
      if (generation === this.connectionGeneration) {
        this.isConnecting = false;
        if (!this.socket && this.clientId && this.desiredActivity) this.scheduleReconnect();
      }
    }
  }

  private connectToEndpoint(endpoint: string): Promise<net.Socket | null> {
    return new Promise(resolve => {
      const socket = net.createConnection(endpoint);
      let settled = false;
      const finish = (result: net.Socket | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        finish(null);
      }, CONNECT_TIMEOUT_MS);

      socket.once('connect', () => finish(socket));
      socket.once('error', () => finish(null));
    });
  }

  private attachSocketListeners(socket: net.Socket): void {
    socket.on('data', data => this.handleData(socket, data));
    socket.on('error', () => this.handleDisconnect(socket));
    socket.on('close', () => this.handleDisconnect(socket));
  }

  private handleData(socket: net.Socket, data: Buffer): void {
    if (socket !== this.socket) return;

    try {
      const decoded = decodeDiscordFrames(Buffer.concat([this.receiveBuffer, data]));
      this.receiveBuffer = decoded.remainder;
      for (const frame of decoded.frames) {
        if (frame.opcode === Opcode.Ping) {
          this.sendFrame(Opcode.Pong, frame.payload);
        } else if (frame.opcode === Opcode.Frame && frame.payload.evt === 'READY') {
          this.isReady = true;
          this.sendActivity();
        } else if (frame.opcode === Opcode.Close) {
          socket.destroy();
        }
      }
    } catch {
      // A corrupt or incompatible IPC stream is not actionable for users.
      socket.destroy();
    }
  }

  private sendActivity(): void {
    if (!this.desiredActivity) return;
    this.sendFrame(Opcode.Frame, {
      cmd: 'SET_ACTIVITY',
      nonce: this.createNonce(),
      args: {
        pid: process.pid,
        activity: this.desiredActivity,
      },
    });
  }

  private sendFrame(opcode: Opcode, payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(encodeDiscordFrame(opcode, payload));
  }

  private handleDisconnect(socket: net.Socket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.isReady = false;
    this.receiveBuffer = Buffer.alloc(0);
    if (!socket.destroyed) socket.destroy();
    if (this.clientId && this.desiredActivity) this.scheduleReconnect();
  }

  private disconnect(reconnect: boolean): void {
    this.connectionGeneration++;
    this.isConnecting = false;
    this.isReady = false;
    this.receiveBuffer = Buffer.alloc(0);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    if (reconnect) this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private createNonce(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
