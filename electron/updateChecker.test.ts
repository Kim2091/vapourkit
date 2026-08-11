import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getAppPath: () => '.',
    getPath: () => '.',
    isPackaged: false
  }
}));

vi.mock('./logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}));

import { parseVersion, isUpdateAvailable } from './updateChecker';

describe('parseVersion', () => {
  it('parses a plain version', () => {
    expect(parseVersion('0.16.1')).toEqual({ core: [0, 16, 1], prerelease: null });
  });

  it('strips a leading v', () => {
    expect(parseVersion('v0.17.0')).toEqual({ core: [0, 17, 0], prerelease: null });
  });

  it('splits off nightly prerelease suffixes', () => {
    expect(parseVersion('v0.16.1-nightly.2026-05-13')).toEqual({
      core: [0, 16, 1],
      prerelease: 'nightly.2026-05-13'
    });
  });

  it('never produces NaN core components', () => {
    expect(parseVersion('0.16.x').core).toEqual([0, 16, 0]);
  });
});

describe('isUpdateAvailable', () => {
  it('offers a newer stable release', () => {
    expect(isUpdateAvailable('0.16.1', 'v0.17.0')).toBe(true);
    expect(isUpdateAvailable('0.16.1', 'v0.16.2')).toBe(true);
  });

  it('does not offer the same or an older stable release', () => {
    expect(isUpdateAvailable('0.16.1', 'v0.16.1')).toBe(false);
    expect(isUpdateAvailable('0.17.0', 'v0.16.1')).toBe(false);
  });

  it('does not offer a nightly the stable release it was cut from', () => {
    // Regression: "1-nightly" used to parse as NaN→0, so v0.16.1 looked newer
    expect(isUpdateAvailable('0.16.1-nightly.2026-05-13', 'v0.16.1')).toBe(false);
  });

  it('offers a nightly a stable release with a newer base version', () => {
    expect(isUpdateAvailable('0.16.1-nightly.2026-05-13', 'v0.17.0')).toBe(true);
  });

  it('does not offer a nightly an older stable release', () => {
    expect(isUpdateAvailable('0.17.0-nightly.2026-08-10', 'v0.16.1')).toBe(false);
  });

  it('handles cores of different lengths', () => {
    expect(isUpdateAvailable('0.16', 'v0.16.1')).toBe(true);
    expect(isUpdateAvailable('0.16.1', 'v0.16')).toBe(false);
  });
});
