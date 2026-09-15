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

  it('streams frames under credit, and stops promptly', async () => {
    const clip = process.env.VK_SMOKE_CLIP!;
    const outDir = process.env.VK_SMOKE_DIR!;
    await fs.ensureDir(outDir);

    const generator = new VapourSynthScriptGenerator();
    const scriptPath = await generator.generateScript({
      inputVideo: clip,
      enginePath: '',
      pluginsPath: path.join(repo, 'data', 'vapoursynth-portable', 'Lib',
                             'site-packages', 'vapoursynth', 'plugins'),
      defaultBackend: 'tensorrt',
      useFp32: false,
      modelType: 'image' as const,
      upscalingEnabled: false,
      colorimetry: {},
      filters: [],
      numStreams: 2,
      outputFormat: 'vs.YUV420P8',
      generatePreviewOutputs: true,
    } as any);

    const session = new PreviewSession();
    await session.start();
    const outputs = await session.open(scriptPath, 1000);
    const last = outputs[outputs.length - 1];

    const received: number[] = [];
    let ended = false;
    session.onStream = event => {
      if (event.type === 'pframe') received.push(event.n);
      if (event.type === 'end') ended = true;
    };

    // Credit is the whole of the flow control: three granted, three delivered,
    // and then nothing until more is given.
    await session.play({ stream: 1, output: last.index, from: 100, width: 1280, credits: 3 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(received).toEqual([100, 101, 102]);

    session.credit(1, 2);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(received).toEqual([100, 101, 102, 103, 104]);

    // A stop has to beat the frame being rendered, not queue behind it.
    const before = Date.now();
    const lastFrame = await session.stop(1);
    const stopMs = Date.now() - before;
    console.log(`stop replied in ${stopMs} ms at frame ${lastFrame}`);
    expect(stopMs).toBeLessThan(1000);
    expect(ended).toBe(false);

    // Push throughput, against the pull ceiling the first test prints.
    await session.play({ stream: 2, output: last.index, from: 200, width: 1280, credits: 64 });
    const started = Date.now();
    let streamed = 0;
    session.onStream = event => {
      if (event.type !== 'pframe') return;
      streamed += 1;
      // Keep the window open, the way the pacer does on every present.
      session.credit(2, 1);
    };
    await new Promise(resolve => setTimeout(resolve, 5000));
    const fps = streamed / ((Date.now() - started) / 1000);
    console.log(`push: ${streamed} frames, ${fps.toFixed(1)} fps at 1280 wide`);
    expect(streamed).toBeGreaterThan(0);

    await session.stop(2);
    session.dispose();
    await fs.remove(scriptPath);
  }, 120000);
});
