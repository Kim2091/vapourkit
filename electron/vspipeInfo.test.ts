import { describe, expect, it } from 'vitest';
import { parseVspipeInfo } from './vspipeInfo';

const info = (fps: string, extra = '') => `${extra}Output Index: 0
Type: Video
Width: 1920
Height: 1080
Frames: 108
FPS: ${fps}
Format Name: YUV420P10
Color Family: YUV
`;

describe('reading vspipe -i', () => {
  it('reads a constant rate exactly', () => {
    expect(parseVspipeInfo(info('24000/1001 (23.976 fps)'))).toEqual({
      frames: 108, resolution: '1920x1080', fps: 23.976, fpsString: '24000/1001', pixelFormat: 'YUV420P10', variableFrameRate: false,
    });
  });

  it('accepts a variable rate and takes the average the script reported', () => {
    const stderr = '[vk-timing] vfr average_rate=107000000/3966667 The source has a variable frame rate (23.998 to 30.003 fps); the output keeps each frame\'s timestamp.\r\n';
    const parsed = parseVspipeInfo(info('Variable', stderr));
    expect(parsed.variableFrameRate).toBe(true);
    expect(parsed.fpsString).toBe('107000000/3966667');
    expect(parsed.fps).toBe(26.975);
    expect(parsed.frames).toBe(108);
  });

  it('accepts a variable rate with no average, rather than falling back to a guess', () => {
    const parsed = parseVspipeInfo(info('Variable'));
    expect(parsed).toMatchObject({ variableFrameRate: true, fps: null, fpsString: null, resolution: '1920x1080' });
  });

  it('is not confused by a timing note on a constant rate output', () => {
    const stderr = '[vk-timing] cfr The source has a variable frame rate (24.000 to 30.000 fps); the steps set a constant 60.000 fps, which the output keeps.\n';
    expect(parseVspipeInfo(info('60/1 (60.000 fps)', stderr))).toMatchObject({ fps: 60, fpsString: '60/1', variableFrameRate: false, frames: 108 });
  });
});
