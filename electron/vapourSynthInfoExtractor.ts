// electron/vapourSynthInfoExtractor.ts
import { spawn, ChildProcess } from 'child_process';
import { logger } from './logger';
import { setupVSEnvironment } from './utils';
import { ErrorMessageHandler } from './errorMessageHandler';
import { parseBestSourceProgress } from './bestSourceProgressParser';
import { createEngineBuildTracker, type EngineBuildStatus } from './engineBuildProtocol';
import { formatVapourSynthValidationError } from './vapourSynthErrorFormatter';
import { createWorkloadSpawnOptions, terminateProcessTree } from './processLifecycle';
import { parseVspipeInfo, type OutputInfo } from './vspipeInfo';

export type { OutputInfo } from './vspipeInfo';

/** parseVspipeInfo(), with what it found written to the log. */
function readVspipeInfo(output: string): OutputInfo {
  const info = parseVspipeInfo(output);
  if (info.frames > 0) {
    logger.upscale(`Detected ${info.frames} frames from vspipe info`);
  } else {
    logger.warn('Could not parse frame count from vspipe output');
  }
  if (info.resolution) {
    logger.upscale(`Detected output resolution: ${info.resolution}`);
  } else {
    logger.warn('Could not parse resolution from vspipe output');
  }
  if (info.variableFrameRate) {
    logger.upscale(`Detected variable output frame rate${info.fps ? ` (average ${info.fps} fps)` : ''}; each frame keeps its own timestamp`);
  } else if (info.fps) {
    logger.upscale(`Detected output FPS: ${info.fps} (${info.fpsString})`);
  } else {
    logger.warn('Could not parse FPS from vspipe output');
    logger.warn(`FPS regex did not match. Looking for pattern: FPS: num/den (decimal)`);
  }
  if (info.pixelFormat) {
    logger.upscale(`Detected output pixel format: ${info.pixelFormat}`);
  }
  if (!info.resolution && !info.fps) {
    logger.debug(`vspipe output: ${output}`);
  }
  return info;
}

/**
 * Utility class for extracting information from VapourSynth scripts
 */
export class VapourSynthInfoExtractor {
  private vspipePath: string;
  private pythonPath: string;
  private vsPath: string;
  private activeProcesses: Set<ChildProcess> = new Set();

  /**
   * Receives `[vk-build]` build-status updates parsed from vspipe's stderr.
   * Set by UpscaleExecutor, which owns the BrowserWindow these get sent to —
   * this class deliberately stays free of electron imports.
   */
  onBuildStatus?: (status: EngineBuildStatus) => void;

  constructor(vspipePath: string, pythonPath: string, vsPath: string) {
    this.vspipePath = vspipePath;
    this.pythonPath = pythonPath;
    this.vsPath = vsPath;
  }

  /**
   * Cancels all active vspipe info processes immediately
   */
  cancelAll(): void {
    logger.upscale(`Force killing ${this.activeProcesses.size} active vspipe info process(es)`);
    for (const proc of this.activeProcesses) {
      terminateProcessTree(proc);
    }
    this.activeProcesses.clear();
    // Anti-stick: a build banner must never outlive the process that raised it
    this.onBuildStatus?.({ status: 'idle' });
  }

  /**
   * Tracker for one vspipe run's stderr. Filters (and the app's own engine
   * builder, running inside vspipe through the trtexec shim) print `[vk-build]`
   * lines while they build TensorRT engines, which can take minutes — without
   * this the app just looks frozen.
   */
  private newBuildTracker() {
    return createEngineBuildTracker(status => this.onBuildStatus?.(status));
  }

  /**
   * Tracks a process and removes it when it exits
   */
  private trackProcess(proc: ChildProcess): void {
    this.activeProcesses.add(proc);
    proc.on('close', () => {
      this.activeProcesses.delete(proc);
    });
    proc.on('error', () => {
      this.activeProcesses.delete(proc);
    });
  }

  /**
   * Evaluates a VapourSynth script once with `vspipe -i` and returns its output
   * clip's frame count, resolution, frame rate and format, or the error that
   * stopped it. If onProgress is provided, BestSource indexing percentages
   * parsed from stderr are forwarded so a cold cache does not look hung.
   */
  async getOutputInfo(scriptPath: string, onProgress?: (percentage: number) => void): Promise<OutputInfo> {
    logger.upscale(`Getting output info from script: ${scriptPath}`);

    return new Promise((resolve) => {
      const env = setupVSEnvironment(this.pythonPath);

      // Use vspipe -i to get info
      const vspipe = spawn(this.vspipePath, ['-i', scriptPath, '-'], createWorkloadSpawnOptions({
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
        cwd: this.vsPath
      }));

      // Track the process for cleanup
      this.trackProcess(vspipe);

      let output = '';
      let stderrOutput = '';
      const buildTracker = this.newBuildTracker();

      if (vspipe.stdout) {
        vspipe.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
      }

      if (vspipe.stderr) {
        vspipe.stderr.on('data', (data: Buffer) => {
          const text = data.toString();
          output += text;
          stderrOutput += text;
          buildTracker.push(text);
          if (onProgress) {
            for (const pct of parseBestSourceProgress(text)) {
              onProgress(pct);
            }
          }
        });
      }

      vspipe.on('close', (code) => {
        buildTracker.reset();
        if (code === 0) {
          // Always log the full vspipe output for debugging
          logger.upscale('=== vspipe -i output ===');
          logger.upscale(output);
          logger.upscale('=== end vspipe -i output ===');
          resolve(readVspipeInfo(output));
        } else {
          logger.error(`vspipe info failed with code ${code}`);
          logger.error(`Full output: ${output}`);
          // Keep the complete output in the log, but remove repeated non-fatal API3
          // startup notices before it reaches the validation-error toast.
          const fullError = output.trim() || stderrOutput.trim() || 'Unknown error';
          const error = formatVapourSynthValidationError(fullError);
          resolve({ frames: 0, resolution: null, fps: null, fpsString: null, pixelFormat: null, error });
        }
      });

      vspipe.on('error', (error) => {
        buildTracker.reset();
        logger.error('vspipe info error:', error);
        resolve({ frames: 0, resolution: null, fps: null, fpsString: null, pixelFormat: null, error: error.message });
      });
    });
  }
}
