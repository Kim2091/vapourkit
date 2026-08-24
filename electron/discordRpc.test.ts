import { describe, expect, it } from 'vitest';
import { decodeDiscordFrames, encodeDiscordFrame, normalizeDiscordActivity } from './discordRpc';

describe('Discord RPC framing', () => {
  it('round-trips a frame and preserves an incomplete trailing frame', () => {
    const first = encodeDiscordFrame(0, { v: 1, client_id: '123456789012345678' });
    const second = encodeDiscordFrame(1, { cmd: 'SET_ACTIVITY' });
    const partial = Buffer.concat([first, second.subarray(0, 5)]);

    const decoded = decodeDiscordFrames(partial);

    expect(decoded.frames).toEqual([{ opcode: 0, payload: { v: 1, client_id: '123456789012345678' } }]);
    expect(decoded.remainder).toEqual(second.subarray(0, 5));
  });

  it('normalizes text and timestamps to Discord Rich Presence limits', () => {
    const activity = normalizeDiscordActivity({
      details: `  ${'d'.repeat(150)}  `,
      state: '  Processing  ',
      startTimestamp: 1_700_000_000.9,
    });

    expect(activity).toEqual({
      details: 'd'.repeat(128),
      state: 'Processing',
      timestamps: { start: 1_700_000_000 },
    });
  });

  it('rejects oversized incoming frames before trying to parse them', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(1, 0);
    header.writeUInt32LE(1024 * 1024 + 1, 4);

    expect(() => decodeDiscordFrames(header)).toThrow('Discord RPC frame exceeds');
  });
});
