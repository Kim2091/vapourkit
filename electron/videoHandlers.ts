import { ipcMain, BrowserWindow, shell, MessageChannelMain, type MessagePortMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { withLogSeparator } from './utils';
import { extractVideoMetadata, getVideoFrameCount, probeVideo } from './videoUtils';
import { formatBytes } from './ipcUtilities';
import { handleValidated } from './ipcValidation';
import { z } from 'zod';
import { VapourSynthScriptGenerator, type ScriptConfig } from './scriptGenerator';
import { resolveProvider, resolveBackendId } from './providers/registry';
import { UpscaleExecutor } from './upscaleExecutor';
import { VapourSynthInfoExtractor, type OutputInfo } from './vapourSynthInfoExtractor';
import { JobSlot } from './jobSlot';
import { DependencyManager } from './dependencyManager';
import { FFmpegSettingsManager } from './ffmpegSettingsManager';
import { splitArgs } from './encodingSettings';
import { FFmpegManager } from './ffmpegManager';
import { VsViewManager } from './vsViewManager';
import { PreviewSession } from './previewSession';
import { API3_UNSUPPORTED, describeCoreTooNew } from './vapoursynthCore';
import { QueueItemLogger } from './queueItemLogger';
import { ReportedRunError } from './errorMessageHandler';
import {
  getVideoCompareUnavailableMessage,
  launchVideoCompare,
  resolveVideoCompareCommand,
} from './videoCompare';

/** A processing run: its executor and its per-item log. */
interface UpscaleJob {
  executor: UpscaleExecutor;
  log: QueueItemLogger;
}

/** How an upscale is stopped, and the line its item log gets. */
interface UpscaleStop {
  mode: 'cancel' | 'kill';
  note: string;
}

/**
 * Runs that were cancelled and are letting ffmpeg finish what it has. Quitting
 * kills them; each leaves the set when its run settles.
 */
const drainingUpscales = new Set<UpscaleExecutor>();

const upscaleJob = new JobSlot<UpscaleJob, UpscaleStop>((job, { mode, note }) => {
  job.log.write(note);
  job.log.close();
  if (mode === 'cancel') {
    drainingUpscales.add(job.executor);
    job.executor.cancel();
  } else {
    job.executor.kill();
  }
});

/** A `vspipe -i` evaluation run for validation or as a preflight. */
const infoJob = new JobSlot<VapourSynthInfoExtractor>(extractor => extractor.cancelAll());

/** A preview session and how to remove the script it was opened on. */
interface PreviewJob {
  session: PreviewSession;
  removeScript: () => Promise<void>;
}

const stopPreviewJob = ({ session, removeScript }: PreviewJob) => {
  session.dispose();
  removeScript().catch(() => {});
};

/** The open session, which requests are served from. */
const previewJob = new JobSlot<PreviewJob>(stopPreviewJob);

/**
 * A session still opening its script. It replaces the open one only once it
 * has opened, so a chain that fails to open leaves the last good preview.
 */
const openingPreviewJob = new JobSlot<PreviewJob>(stopPreviewJob);

function openPreviewSession(): PreviewSession | null {
  return previewJob.current?.session ?? null;
}

/**
 * The renderer end of the playback channel.
 *
 * Frames are pushed down this rather than returned from one `invoke` per
 * frame. A port does not make the pixels cheaper to move — main and renderer
 * are separate processes, and Electron only transfers ports, never buffers —
 * but it removes the per-frame promise, and, because preload hands it to the
 * main world, the one copy that crossing contextBridge would have added.
 */
let previewPort: MessagePortMain | null = null;

/** Names the port for the open that created it, so a stale one is ignored. */
let previewPortToken: string | null = null;

function closePreviewPort(): void {
  previewPort?.close();
  previewPort = null;
  previewPortToken = null;
}

/**
 * Bumped by every open and by every cancel.
 *
 * Opening evaluates the graph, which can sit in an engine build for minutes,
 * and opens the source, which can take seconds, so a cancel usually lands
 * while an open is still in flight. Without this the cancelled open would go on to install
 * its session afterwards, and the user would be left with the thing they just
 * stopped.
 */
let previewOpenToken = 0;

/** Ends the preview: any open in flight, the session, its port and script. */
function closePreview(): void {
  previewOpenToken++;
  closePreviewPort();
  openingPreviewJob.stop();
  previewJob.stop();
}

/**
 * Cache ceiling for a preview session, in MB.
 *
 * Deliberately not the template's 15000: a preview process can be sitting
 * beside a running queue job, and the decoder's own floor dominates anyway.
 */
const PREVIEW_CACHE_MB = 1000;

/**
 * Stops every video job and its child processes, including cancelled runs
 * whose ffmpeg is still finishing.
 */
export function cancelAllVideoProcessing(): void {
  upscaleJob.stop({ mode: 'kill', note: 'Processing canceled (app shutdown)' });
  for (const executor of drainingUpscales) executor.kill();
  drainingUpscales.clear();
  infoJob.stop();
  closePreview();
}

/**
 * Registers all video-related IPC handlers
 */
export function registerVideoHandlers(
  mainWindow: BrowserWindow | null,
  scriptGenerator: VapourSynthScriptGenerator,
  dependencyManager: DependencyManager
) {
  /**
   * Evaluates a script once with `vspipe -i` in the info slot, replacing any
   * evaluation already running there. Engine builds it triggers show in the
   * app's build banner. A cancel, or a newer evaluation, kills it, and the
   * result then carries the error that left.
   */
  const evaluateScript = async (scriptPath: string): Promise<OutputInfo> => {
    const vspipePath = dependencyManager.getVSPipePath();
    const extractor = new VapourSynthInfoExtractor(
      vspipePath,
      dependencyManager.getPythonExecutablePath(),
      path.dirname(vspipePath),
    );
    extractor.onBuildStatus = status => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-build-progress', status);
      }
    };
    infoJob.start(extractor);
    const info = await extractor.getOutputInfo(scriptPath);
    infoJob.release(extractor);
    return info;
  };

  handleValidated('get-video-info', z.string().min(1), async (filePath) => {
    logger.info(`Getting video info for: ${filePath}`);
    try {
      const stats = await fs.stat(filePath);
      const metadata = await extractVideoMetadata(filePath);

      // Stream BestSource indexing progress to the renderer
      const onProgress = (percentage: number) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('video-index-progress', { percentage, complete: false });
        }
      };

      let frameCount: number | undefined;
      try {
        frameCount = await getVideoFrameCount(filePath, onProgress);
      } finally {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('video-index-progress', { percentage: 100, complete: true });
        }
      }

      const info = {
        path: filePath,
        name: path.basename(filePath),
        size: stats.size,
        sizeFormatted: formatBytes(stats.size),
        resolution: metadata.resolution,
        fps: metadata.fps,
        pixelFormat: metadata.pixelFormat,
        codec: metadata.codec,
        container: metadata.container,
        scanType: metadata.scanType,
        colorSpace: metadata.colorSpace,
        duration: metadata.duration,
        frameCount: frameCount
      };

      logger.info(`Video info: ${info.name}, ${info.sizeFormatted}, ${metadata.resolution || 'unknown resolution'}, ${metadata.fps ? metadata.fps + ' fps' : 'unknown fps'}, ${metadata.pixelFormat || 'unknown format'}${frameCount ? `, ${frameCount} frames` : ''}`);
      return info;
    } catch (error) {
      logger.error('Error getting video info:', error);
      // Inner finally already sent the terminal event if frame counting started.
      // Earlier failures (stat/metadata) happen before the renderer shows any
      // progress UI, so no terminal event is required.
      throw error;
    }
  });

  handleValidated('read-video-file', z.string().min(1), async (filePath) => {
    try {
      // Check file size first to prevent loading massive files into memory
      const stats = await fs.stat(filePath);

      // Warning: Reading large files into memory can cause the app to crash.
      // For playback, use the 'video://' protocol instead.
      if (stats.size > 500 * 1024 * 1024) {
         logger.warn(`Reading large file into memory: ${filePath} (${formatBytes(stats.size)})`);
      }

      return await fs.readFile(filePath);
    } catch (error) {
      logger.error('Error reading video file:', error);
      throw error;
    }
  });

  ipcMain.handle('get-output-resolution', async (
    event,
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: string,
    upscalingEnabled?: boolean,
    filters?: any[],
    upscalePosition?: number,
    numStreams?: number,
    sourceFps?: number
  ) => {
    logger.info(`Getting output info for: ${videoPath} (validation mode - first 5 seconds)`);
    try {
      // Validation always evaluates only the first seconds, without a segment.
      const config = buildScriptConfig(
        { videoPath, defaultBackend, filters, numStreams },
        { validationMode: true, sourceFps },
      );
      
      const scriptPath = await scriptGenerator.generateScript(config);

      // A cold-cache validation run can spend minutes building a TensorRT
      // engine; evaluateScript shows that in the build banner.
      const info = await evaluateScript(scriptPath);
      
      // Check if vspipe returned an error
      if (info.error) {
        await scriptGenerator.cleanupScript(scriptPath);
        logger.error('Workflow validation error:', info.error);
        return { resolution: null, fps: null, error: info.error };
      }
      
      // Get codec from settings
      const ffmpegConfig = await FFmpegSettingsManager.loadFFmpegConfig(configManager);
      // Infer codec from videoArgs or default
      let codec = 'H.264'; // Default assumption if not specified
      if (ffmpegConfig.videoArgs) {
          const args = ffmpegConfig.videoArgs.join(' ');
          if (args.includes('libx265') || args.includes('hevc')) codec = 'H.265 (HEVC)';
          else if (args.includes('libx264')) codec = 'H.264 (AVC)';
          else if (args.includes('prores')) codec = 'ProRes';
          else if (args.includes('vp9')) codec = 'VP9';
          else if (args.includes('av1')) codec = 'AV1';
          else {
              // Extract codec name directly from -c:v for custom/unknown codecs
              const codecMatch = args.match(/-c:v\s+(\S+)/);
              if (codecMatch) codec = codecMatch[1].toUpperCase();
          }
      }

      await scriptGenerator.cleanupScript(scriptPath);
      
      return {
        resolution: info.resolution,
        fps: info.fps,
        pixelFormat: info.pixelFormat,
        codec: codec,
        scanType: 'Progressive' // AI upscaling output is typically progressive
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error getting output info:', errorMsg);
      return { resolution: null, fps: null, error: errorMsg };
    }
  });

  // Cancel validation handler
  ipcMain.handle('cancel-validation', async () => {
    logger.info('Cancelling workflow validation');
    infoJob.stop();
    return { success: true, cancelled: true };
  });

  ipcMain.handle('start-upscale', async (
    event,
    videoPath: string,
    modelPath: string | null,
    outputPath: string,
    defaultBackend?: string,
    upscalingEnabled?: boolean,
    filters?: any[],
    upscalePosition?: number,
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number },
    benchmarkMode?: boolean
  ) => {
    return await withLogSeparator(async () => {
      const isUpscaling = upscalingEnabled !== false; // Default to true for backward compatibility
      
      // Create per-item log file for this processing run
      const videoName = videoPath.split(/[\\/]/).pop() || 'unknown';
      const itemLogger = new QueueItemLogger(videoName);
      await itemLogger.open();

      const vspipePath = dependencyManager.getVSPipePath();
      const pythonPath = dependencyManager.getPythonExecutablePath();
      const executor = new UpscaleExecutor(vspipePath, pythonPath, mainWindow);

      // The job is in the slot from here on, so a cancel at any later await
      // reaches it. Any previous run, and any validation, is stopped first.
      infoJob.stop();
      const job = upscaleJob.start(
        { executor, log: itemLogger },
        { mode: 'kill', note: 'Processing stopped: a new run started' },
      );

      // Helper to log to both main log and per-item log
      const qlog = (message: string) => {
        logger.upscale(message);
        itemLogger.write(message);
      };
      const qerror = (message: string) => {
        logger.error(message);
        itemLogger.error(message);
      };

      qlog('Starting processing');
      qlog(`Input: ${videoPath}`);
      qlog(`Upscaling: ${isUpscaling ? 'enabled' : 'disabled'}`);
      if (isUpscaling && modelPath) {
        qlog(`Model: ${modelPath}`);
        qlog(`Default backend: ${resolveProvider(defaultBackend).descriptor.label}`);
      }
      qlog(`Output: ${benchmarkMode ? '(benchmark - null output)' : outputPath}`);
      if (benchmarkMode) qlog('BENCHMARK MODE: Output will be discarded');
      qlog(`Item log: ${itemLogger.getLogPath()}`);
      
      // Log segment selection
      if (segment?.enabled) {
        qlog(`Segment: frames ${segment.startFrame} to ${segment.endFrame === -1 ? 'end' : segment.endFrame}`);
      }
      
      // Log filter status
      if (filters && filters.length > 0) {
        const enabledFilters = filters.filter(f => f.enabled);
        qlog(`Filters: ${enabledFilters.length} enabled`);
        enabledFilters.forEach(f => {
          itemLogger.write(`  Filter: ${f.templateName || f.id} (enabled)`);
        });
      }
      
      try {
        // Generate VapourSynth script
        qlog('Generating VapourSynth script');
        
        const config = buildScriptConfig({ videoPath, defaultBackend, filters, numStreams, segment });

        if (isUpscaling && modelPath) {
          qlog(`Model type: ${configManager.getModelType(modelPath)}`);
        }

        const scriptPath = await scriptGenerator.generateScript(config);
        qlog(`Script generated: ${scriptPath}`);

        // Log script content to per-item log for troubleshooting
        try {
          const scriptContent = await fs.readFile(scriptPath, 'utf-8');
          itemLogger.write('=== VapourSynth Script Content ===');
          itemLogger.write(scriptContent);
          itemLogger.write('=== End Script Content ===');
        } catch { /* ignore read errors */ }

        // One ffmpeg probe serves both the fps (needed for audio segment
        // trimming) and the stream layout the encode maps.
        const sourceProbe = await probeVideo(videoPath);
        const fps = sourceProbe.display.fps || 24;
        qlog(`Input video fps: ${fps}`);

        qlog(`VSPipe: ${vspipePath}`);
        qlog(`Python: ${pythonPath}`);

        // Record runtime engine builds per item — they can add minutes to a run,
        // so the item log should show why. The banner covers the live view.
        let buildLabel: string | null = null;
        executor.onEngineBuildStatus = (status) => {
          if (status.status === 'building' && status.label && status.label !== buildLabel) {
            buildLabel = status.label;
            qlog(`Engine build started: ${status.label}`);
          } else if (status.status === 'idle' && buildLabel) {
            qlog(`Engine build finished: ${buildLabel}`);
            buildLabel = null;
          }
        };

        // Evaluate the graph once for the frame count and output format. Stream
        // BestSource indexing progress so a cold cache doesn't look like a hang.
        // A stop during it kills the probe, and execute() then refuses to run.
        qlog('Getting frame count');
        let lastIndexPct = -1;
        const outputInfo = await executor.getOutputInfo(scriptPath, (pct) => {
          if (pct !== lastIndexPct) {
            lastIndexPct = pct;
            qlog(`Indexing source: ${pct}%`);
          }
          mainWindow?.webContents.send('video-index-progress', { percentage: pct, complete: false });
        });
        const totalFrames = outputInfo.frames;
        qlog(`Total frames to process: ${totalFrames}`);

        mainWindow?.webContents.send('video-index-progress', { percentage: 100, complete: true });
        if (executor.isStopped) {
          logger.upscale('Upscale canceled before execution started');
          return { success: false, error: 'Canceled' };
        }

        qlog('Starting execution');
        await executor.execute(scriptPath, outputPath, videoPath, { source: sourceProbe.streams, output: outputInfo }, segment?.enabled ? segment : undefined, fps, benchmarkMode);

        // Cleanup
        qlog('Cleaning up script file');
        await scriptGenerator.cleanupScript(scriptPath);

        qlog('Processing completed successfully');
        return { success: true, outputPath };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        if (executor.isStopped) {
          logger.upscale(`Processing stopped: ${errorMsg}`);
        } else if (error instanceof ReportedRunError) {
          // The executor has written it to the main log already.
          itemLogger.error(`Processing failed: ${errorMsg}`);
        } else {
          qerror(`Processing failed: ${errorMsg}`);
        }
        return { success: false, error: errorMsg };
      } finally {
        upscaleJob.release(job);
        drainingUpscales.delete(executor);
        itemLogger.close();
      }
    });
  });

  ipcMain.handle('cancel-upscale', async () => {
    logger.upscale('Canceling upscale process');
    if (upscaleJob.stop({ mode: 'cancel', note: 'Processing canceled by user' })) {
      logger.upscale('Upscale canceled');
    }
    return { success: true };
  });

  ipcMain.handle('kill-upscale', async () => {
    logger.upscale('Force killing upscale process');
    if (upscaleJob.stop({ mode: 'kill', note: 'Processing force killed' })) {
      logger.upscale('Upscale force killed');
    }
    // A run cancelled earlier may still be letting ffmpeg finish.
    for (const executor of drainingUpscales) executor.kill();
    return { success: true };
  });

  handleValidated('compare-videos', z.tuple([z.string().min(1), z.string().min(1)]), async ([inputPath, outputPath]) => {
    logger.info(`Launching video comparison tool`);
    logger.info(`Input: ${inputPath}`);
    logger.info(`Output: ${outputPath}`);
    try {
      // Windows ships an app-managed binary. Linux uses an optional host
      // command, so resolve it through PATH rather than fs.existsSync on the
      // literal string "video-compare".
      const videoComparePath = resolveVideoCompareCommand(PATHS.VIDEO_COMPARE_EXE);
      if (!videoComparePath) {
        throw new Error(getVideoCompareUnavailableMessage());
      }
      
      // Check if both video files exist
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input video not found: ${inputPath}`);
      }
      if (!fs.existsSync(outputPath)) {
        throw new Error(`Output video not found: ${outputPath}`);
      }
      
      // Launch video-compare with both videos
      logger.info(`Launching: ${videoComparePath}`);
      
      // Get custom args from config
      const videoCompareArgsString = configManager.getVideoCompareArgs();
      const customArgs = splitArgs(videoCompareArgsString);
      
      // Combine args with video paths
      const allArgs = [...customArgs, inputPath, outputPath];
      logger.info(`Video compare args: ${allArgs.join(' ')}`);
      
      await launchVideoCompare(videoComparePath, allArgs);
      
      logger.info('Video comparison tool launched successfully');
      return { success: true };
    } catch (error) {
      logger.error('Error launching video comparison tool:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  });

  // Launch vs-view with a VapourSynth script
  ipcMain.handle('launch-vse-previewer', async (
    event,
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: string,
    upscalingEnabled?: boolean,
    filters?: any[],
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number }
  ) => {
    logger.info(`Launching vs-view for video: ${videoPath}`);
    try {
      // Generate VapourSynth script with the current workflow, with an output
      // after each step for filter comparison
      const scriptPath = await scriptGenerator.generateScript(buildScriptConfig(
        { videoPath, defaultBackend, filters, numStreams, segment },
        { generatePreviewOutputs: true },
      ));
      logger.info(`Generated preview script: ${scriptPath}`);

      // Evaluate the graph before handing it to vs-view. Any runtime engine
      // build then happens here, under the app's build banner and with the
      // launch spinner still up, instead of freezing vs-view's own window — and
      // script errors surface with our error handling rather than vs-view's.
      const preflight = await evaluateScript(scriptPath);

      if (preflight.error) {
        logger.error('vs-view preflight failed:', preflight.error);
        await scriptGenerator.cleanupScript(scriptPath);
        return { success: false, error: preflight.error };
      }

      // Launch vs-view with the generated script
      const result = await VsViewManager.launch(scriptPath);

      if (result.success) {
        logger.info('vs-view launched successfully');
      } else {
        logger.error(`Failed to launch vs-view: ${result.error}`);
      }

      return result;
    } catch (error) {
      logger.error('Error launching vs-view:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  });

  // ---- In-app chain preview ------------------------------------------------
  //
  // The same generated multi-output script vs-view is handed, executed instead
  // by a warm python session this app talks to directly. One session lives for
  // as long as the preview panel is open; a change to the chain closes it and
  // opens a new one, because the output indices move when filters do.

  ipcMain.handle('preview-open', async (
    event,
    videoPath: string,
    modelPath: string | null,
    defaultBackend?: string,
    upscalingEnabled?: boolean,
    filters?: any[],
    numStreams?: number,
    segment?: { enabled: boolean; startFrame: number; endFrame: number }
  ) => {
    const token = ++previewOpenToken;
    const superseded = () => token !== previewOpenToken;
    let openingJob: PreviewJob | null = null;

    try {
      const scriptPath = await scriptGenerator.generateScript(buildScriptConfig(
        { videoPath, defaultBackend, filters, numStreams, segment },
        { generatePreviewOutputs: true },
      ));
      if (superseded()) {
        await scriptGenerator.cleanupScript(scriptPath).catch(() => {});
        return { success: false, cancelled: true };
      }

      // The session evaluates the graph when it opens the script, which is
      // where a TensorRT step with no cached engine builds it; its stderr
      // feeds the build banner so a minutes-long open explains itself. It
      // waits in its own slot, so a cancel or the app quitting stops it too.
      const session = new PreviewSession();
      session.onBuildStatus = status => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine-build-progress', status);
        }
      };
      openingJob = openingPreviewJob.start({
        session,
        removeScript: () => scriptGenerator.cleanupScript(scriptPath),
      });
      await session.start();
      let outputs;
      try {
        outputs = await session.open(scriptPath, PREVIEW_CACHE_MB);
      } catch (error) {
        // A core too new for the installed plugins only says so on stderr;
        // the traceback it leads to names the wrong cause.
        if (!superseded() && API3_UNSUPPORTED.test(session.recentStderr)) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          throw new Error(`${describeCoreTooNew()}\n\n${errorMsg}`);
        }
        throw error;
      }

      // Opening a cold source can take seconds, which is plenty of time for a
      // cancel to arrive. Do not keep a session nobody is waiting for.
      if (superseded() || !openingPreviewJob.holds(openingJob)) {
        if (openingPreviewJob.holds(openingJob)) openingPreviewJob.stop();
        return { success: false, cancelled: true };
      }
      openingPreviewJob.release(openingJob);
      previewJob.start(openingJob);

      // The playback channel. Created here rather than on first play so the
      // renderer has it before the user can press anything, and so its `close`
      // is the signal that the renderer went away — a reload mid-playback
      // would otherwise leave python rendering into a pipe nobody reads.
      closePreviewPort();
      const { port1, port2 } = new MessageChannelMain();
      const portToken = randomUUID();
      previewPort = port1;
      previewPortToken = portToken;

      port1.on('message', messageEvent => {
        const data = messageEvent.data as { type?: string; stream?: number; count?: number };
        if (data?.type === 'credit' && typeof data.stream === 'number') {
          session.credit(data.stream, Number(data.count) || 1);
        }
      });
      port1.on('close', () => {
        if (previewPortToken !== portToken) return;
        previewPort = null;
        previewPortToken = null;
      });
      port1.start();

      session.onStream = streamEvent => {
        if (previewPortToken !== portToken) return;
        previewPort?.postMessage(streamEvent);
      };

      // postMessage rather than an invoke result: the port itself can only
      // travel this way, and preload re-posts it into the main world.
      event.sender.postMessage('preview-port', { token: portToken }, [port2]);

      logger.info(`Preview session open with ${outputs.length} steps`);
      return { success: true, outputs, token: portToken };
    } catch (error) {
      if (openingJob && openingPreviewJob.holds(openingJob)) openingPreviewJob.stop();
      if (superseded()) return { success: false, cancelled: true };
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error opening preview session:', error);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('preview-cancel', async () => {
    logger.info('Cancelling the preview session');
    // Invalidates any open still in flight, so it tears itself down instead
    // of installing a session after the user asked to stop.
    closePreview();
    return { success: true, cancelled: true };
  });

  handleValidated(
    'preview-play',
    z.object({
      stream: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      from: z.number().int().nonnegative(),
      width: z.number().int().nonnegative(),
      credits: z.number().int().positive().max(64),
      prefetch: z.number().int().positive().max(16).optional(),
    }),
    async (options) => {
      const previewSession = openPreviewSession();
      if (!previewSession) return { success: false, error: 'No preview session is open' };
      if (!previewPort) return { success: false, error: 'The preview session has no playback channel' };
      try {
        const started = await previewSession.play(options);
        return { success: true, ...started };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  handleValidated(
    'preview-stop',
    z.number().int().nonnegative(),
    async (stream) => {
      const previewSession = openPreviewSession();
      if (!previewSession) return { success: true, n: null };
      try {
        return { success: true, n: await previewSession.stop(stream) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle('preview-select', async (event, index: number) => {
    const previewSession = openPreviewSession();
    if (!previewSession) return { success: false, error: 'No preview session is open' };
    try {
      await previewSession.select(index);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Returns pixels through invoke, which copies them. That is affordable for
  // the one frame this handler serves; playback replaces it with a
  // MessageChannel port so frames are transferred rather than cloned.
  ipcMain.handle('preview-frame', async (event, n: number, width: number) => {
    const previewSession = openPreviewSession();
    if (!previewSession) return { success: false, error: 'No preview session is open' };
    try {
      const frame = await previewSession.frame(n, width);
      return {
        success: true,
        n: frame.n,
        width: frame.width,
        height: frame.height,
        output: frame.output,
        data: frame.data,
        levels: frame.levels,
        source: frame.source,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('preview-close', async () => {
    closePreview();
    return { success: true };
  });

  // Extract embedded thumbnail from video file
  ipcMain.handle('get-video-thumbnail', async (event, videoPath: string): Promise<string | null> => {
    try {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        logger.warn('FFmpeg not available for thumbnail extraction');
        return null;
      }

      // Check if video file exists
      if (!fs.existsSync(videoPath)) {
        logger.warn(`Video file not found for thumbnail: ${videoPath}`);
        return null;
      }

      // Create a hash of the video path for caching
      const crypto = require('crypto');
      const pathHash = crypto.createHash('md5').update(videoPath).digest('hex');
      const thumbnailDir = path.join(os.tmpdir(), 'vapourkit_thumbnails');
      const thumbnailPath = path.join(thumbnailDir, `${pathHash}.jpg`);

      // Check if thumbnail already exists in cache
      if (fs.existsSync(thumbnailPath)) {
        const thumbnailData = await fs.readFile(thumbnailPath);
        return `data:image/jpeg;base64,${thumbnailData.toString('base64')}`;
      }

      // Ensure thumbnail directory exists
      await fs.ensureDir(thumbnailDir);

      // Try to extract embedded thumbnail first (faster, uses existing thumbnail in file)
      const extractEmbedded = (): Promise<boolean> => {
        return new Promise((resolve) => {
          const proc = spawn(ffmpegPath, [
            '-i', videoPath,
            '-map', '0:v:0',      // First video stream (often the thumbnail)
            '-c:v', 'mjpeg',      // Output as JPEG
            '-frames:v', '1',     // Only one frame
            '-an',                // No audio
            '-y',                 // Overwrite
            thumbnailPath
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          let hasOutput = false;
          
          proc.on('close', async (code) => {
            // Check if file was created and has content
            if (code === 0 && fs.existsSync(thumbnailPath)) {
              const stats = await fs.stat(thumbnailPath);
              hasOutput = stats.size > 0;
            }
            resolve(hasOutput);
          });

          proc.on('error', () => resolve(false));
          
          // Timeout after 3 seconds
          setTimeout(() => {
            proc.kill();
            resolve(false);
          }, 3000);
        });
      };

      // Extract a frame from the video at 1 second mark as fallback
      const extractFrame = (): Promise<boolean> => {
        return new Promise((resolve) => {
          const proc = spawn(ffmpegPath, [
            '-ss', '1',           // Seek to 1 second
            '-i', videoPath,
            '-frames:v', '1',     // Only one frame
            '-vf', 'scale=320:-1', // Scale to 320px width, maintain aspect ratio
            '-q:v', '5',          // Quality (2-31, lower is better)
            '-y',                 // Overwrite
            thumbnailPath
          ], { stdio: ['ignore', 'pipe', 'pipe'] });

          proc.on('close', async (code) => {
            if (code === 0 && fs.existsSync(thumbnailPath)) {
              const stats = await fs.stat(thumbnailPath);
              resolve(stats.size > 0);
            } else {
              resolve(false);
            }
          });

          proc.on('error', () => resolve(false));
          
          // Timeout after 5 seconds
          setTimeout(() => {
            proc.kill();
            resolve(false);
          }, 5000);
        });
      };

      // Try embedded first, then fallback to extracting a frame
      let success = await extractEmbedded();
      if (!success) {
        success = await extractFrame();
      }

      if (success && fs.existsSync(thumbnailPath)) {
        const thumbnailData = await fs.readFile(thumbnailPath);
        return `data:image/jpeg;base64,${thumbnailData.toString('base64')}`;
      }

      return null;
    } catch (error) {
      logger.warn('Error extracting video thumbnail:', error);
      return null;
    }
  });

  // Extract a frame at a specific frame number from video
  ipcMain.handle('get-video-frame-at', async (
    event, 
    videoPath: string, 
    frameNumber: number, 
    fps: number
  ): Promise<string | null> => {
    try {
      const ffmpegPath = FFmpegManager.getFFmpegPath();
      if (!ffmpegPath) {
        logger.warn('FFmpeg not available for frame extraction');
        return null;
      }

      // Check if video file exists
      if (!fs.existsSync(videoPath)) {
        logger.warn(`Video file not found for frame extraction: ${videoPath}`);
        return null;
      }

      // Calculate timestamp from frame number and fps
      const timestamp = frameNumber / (fps || 24);
      
      // Create a unique temp file for this frame
      const crypto = require('crypto');
      const frameHash = crypto.createHash('md5').update(`${videoPath}-${frameNumber}`).digest('hex');
      const frameDir = path.join(os.tmpdir(), 'vapourkit_frames');
      const framePath = path.join(frameDir, `${frameHash}.jpg`);

      // Ensure frame directory exists
      await fs.ensureDir(frameDir);

      // Extract frame using ffmpeg with fast seeking
      return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, [
          '-ss', timestamp.toFixed(3),  // Seek to timestamp (fast seek before input)
          '-i', videoPath,
          '-frames:v', '1',             // Only one frame
          '-vf', 'scale=640:-1',        // Scale to 640px width, maintain aspect ratio
          '-q:v', '3',                  // Quality (2-31, lower is better)
          '-y',                         // Overwrite
          framePath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.on('close', async (code) => {
          if (code === 0 && fs.existsSync(framePath)) {
            try {
              const frameData = await fs.readFile(framePath);
              // Clean up temp file
              await fs.remove(framePath).catch(() => {});
              resolve(`data:image/jpeg;base64,${frameData.toString('base64')}`);
            } catch (err) {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });

        proc.on('error', () => resolve(null));
        
        // Timeout after 5 seconds
        setTimeout(() => {
          proc.kill();
          resolve(null);
        }, 5000);
      });
    } catch (error) {
      logger.warn('Error extracting video frame:', error);
      return null;
    }
  });
}

/** The workflow parts of a script request, as the IPC handlers receive them. */
interface ScriptRequest {
  videoPath: string;
  defaultBackend?: string;
  filters?: any[];
  numStreams?: number;
  segment?: { enabled: boolean; startFrame: number; endFrame: number };
}

/**
 * Builds the generator config for a run, a validation or a preview from the
 * workflow and the app's colorimetry and processing-format settings.
 */
function buildScriptConfig(
  request: ScriptRequest,
  options: Pick<ScriptConfig, 'validationMode' | 'sourceFps' | 'generatePreviewOutputs'> = {},
): ScriptConfig {
  return {
    inputVideo: request.videoPath,
    defaultBackend: resolveBackendId(request.defaultBackend),
    colorimetry: configManager.getColorimetrySettings(),
    filters: request.filters ?? [],
    numStreams: request.numStreams || 2,
    outputFormat: configManager.getProcessingFormat(),
    segment: request.segment?.enabled ? request.segment : undefined,
    ...options,
  };
}
