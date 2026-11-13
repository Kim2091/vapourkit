import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { app, start } = vi.hoisted(() => ({
  app: { getVersion: vi.fn(() => '2.1.0'), exit: vi.fn() },
  start: vi.fn(),
}));
vi.mock('electron', () => ({ app }));
vi.mock('./main', () => { start(); return {}; });
const originalArgv = process.argv;

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); });

describe('Electron entry point', () => {
  it('prints the version and exits without importing application services', async () => {
    process.argv = ['vapourkit', '--version'];
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('./bootstrap');
    expect(output).toHaveBeenCalledWith('2.1.0');
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(start).not.toHaveBeenCalled();
  });
  it('loads the existing application for normal launches', async () => {
    process.argv = ['vapourkit'];
    await import('./bootstrap');
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(app.exit).not.toHaveBeenCalled();
  });
});
