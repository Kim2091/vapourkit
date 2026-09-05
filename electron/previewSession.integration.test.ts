// End-to-end check of the preview session against a real VapourSynth install.
//
// Opt-in: it spawns python, decodes a real file, and needs a clip on disk, so
// it stays out of the default run. Point VK_SMOKE_CLIP at a video and
// VK_SMOKE_DIR at a writable directory to run it:
//
//   VK_SMOKE_CLIP=/path/clip.mp4 VK_SMOKE_DIR=/tmp/out //     npx vitest run -c vitest.config.electron.ts electron/previewSession.integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { spawnSync } from 'child_process';

vi.mock('electron', async () => {
  const p = await import('path');
  return {
    app: {
      isPackaged: false,
      getAppPath: () => p.resolve(__dirname, '..'),
      getPath: () => p.resolve(__dirname, '..'),
    },
  };
});

vi.mock('./configManager', () => ({
  configManager: {
    isModelFp32: () => false,
    getModelType: () => 'image' as const,
    getTemporalFrames: () => undefined,
  },
}));

vi.mock('./logger', () => ({
  logger: { info: console.log, warn: console.warn, error: console.error, debug: console.log },
}));

import { VapourSynthScriptGenerator } from './scriptGenerator';
import { PreviewSession } from './previewSession';

const repo = path.resolve(__dirname, '..');

const configured = Boolean(process.env.VK_SMOKE_CLIP && process.env.VK_SMOKE_DIR);

describe.skipIf(!configured)('preview session, end to end', () => {
  it('opens a generated chain and renders every step', async () => {
    const clip = process.env.VK_SMOKE_CLIP!;
    const outDir = process.env.VK_SMOKE_DIR!;

    const scriptPath = await new VapourSynthScriptGenerator('win32').generateScript({
      inputVideo: clip,
      enginePath: '',
      pluginsPath: '',
      generatePreviewOutputs: true,
      filters: [
        {
          id: 'a',
          enabled: true,
          filterType: 'custom',
          preset: 'Upscale 2x',
          code: 'clip = core.resize.Spline36(clip, width=clip.width*2, height=clip.height*2)',
          order: 0,
        },
        {
          id: 'b',
          enabled: true,
          filterType: 'custom',
          preset: 'Colour grade',
          code: 'clip = core.std.Levels(clip, min_in=16, max_in=235, min_out=16, max_out=140, planes=0)',
          order: 1,
        },
      ],
    });

    const session = new PreviewSession();
    await session.start();

    const t0 = Date.now();
    const outputs = await session.open(scriptPath, 1000);
    console.log(`open: ${Date.now() - t0} ms`);
    console.log(outputs);

    expect(outputs).toHaveLength(3);
    expect(outputs[1].width).toBe(outputs[0].width * 2);

    for (const output of outputs) {
      await session.select(output.index);

      const warm = Date.now();
      const frame = await session.frame(48, 1280);
      const elapsed = Date.now() - warm;

      expect(frame.data.length).toBe(frame.width * frame.height * 3);
      expect(frame.output).toBe(output.index);
      console.log(
        `output ${output.index}: ${frame.width}x${frame.height} ` +
          `${frame.data.length} bytes in ${elapsed} ms`,
      );

      // Same frame again — this is the node cache doing its job.
      const again = Date.now();
      await session.frame(48, 1280);
      console.log(`  same frame again: ${Date.now() - again} ms`);

      const png = path.join(outDir, `step-${output.index}.png`);
      spawnSync(
        path.join(repo, 'data', 'ffmpeg', 'bin', 'ffmpeg.exe'),
        ['-y', '-hide_banner', '-loglevel', 'error',
         '-f', 'rawvideo', '-pix_fmt', 'rgb24',
         '-s', `${frame.width}x${frame.height}`, '-i', 'pipe:0', png],
        { input: frame.data },
      );
    }

    // A seek in the same warm process.
    await session.select(2);
    const seek = Date.now();
    await session.frame(12, 1280);
    console.log(`new seek in warm process: ${Date.now() - seek} ms`);

    session.dispose();
    await fs.remove(scriptPath);
  }, 120000);
});
