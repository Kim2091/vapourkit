import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), model: vi.fn() },
}));
vi.mock('../../constants', () => ({
  PATHS: { PYTHON: 'C:\\vk\\python.exe', MODELS: 'C:\\vk\\models' },
}));
vi.mock('../../utils', () => ({ setupVSEnvironment: () => ({}) }));
vi.mock('../../processLifecycle', () => ({
  createWorkloadSpawnOptions: (options: object) => options,
  terminateProcessTree: vi.fn((child: FakeChild) => child.emit('close', 1)),
}));
vi.mock('../../trtexecShim', () => ({ ensureEngineBuilderScript: vi.fn(async () => 'C:\\vk\\build_trt_engine.py') }));

import { spawn } from 'child_process';
import { customBuildArgs, defaultBuildArgs, TrtEngineBuildJob } from './engineBuilder';
import type { EngineBuildParams } from '../types';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 1;
}

/** Each spawn runs the next script: lines to print on stdout/stderr, then an exit code. */
function scriptedBuilds(...runs: Array<{ stdout?: string; stderr?: string; code: number } | 'hang'>) {
  const children: FakeChild[] = [];
  vi.mocked(spawn).mockImplementation((() => {
    const child = new FakeChild();
    children.push(child);
    const run = runs[children.length - 1];
    if (run !== 'hang') {
      setTimeout(() => {
        if (run.stdout) child.stdout.emit('data', Buffer.from(run.stdout));
        if (run.stderr) child.stderr.emit('data', Buffer.from(run.stderr));
        child.emit('close', run.code);
      }, 0);
    }
    return child;
  }) as never);
  return children;
}

const params: EngineBuildParams = {
  onnxPath: 'C:\\My Models\\a.onnx',
  enginePath: 'C:\\My Models\\a_fp16.engine',
  minShapes: 'input:1x3x64x64',
  optShapes: 'input:1x3x256x256',
  maxShapes: 'input:1x3x512x512',
  useFp32: false,
  useStaticShape: false,
};

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe('build arguments', () => {
  it('passes paths with spaces unquoted, since they go to Python as an array', () => {
    const args = defaultBuildArgs(params.onnxPath, params.enginePath, 'i:1', 'i:2', 'i:3', false, false, false);
    expect(args).toEqual([
      '--onnx=C:\\My Models\\a.onnx', '--minShapes=i:1', '--optShapes=i:2', '--maxShapes=i:3',
      '--fp16', '--saveEngine=C:\\My Models\\a_fp16.engine', '--builderOptimizationLevel=3', '--verbose',
    ]);
  });

  it('splits a custom command before putting the engine path in', () => {
    expect(customBuildArgs(params.onnxPath, params.enginePath, '--fp16 --saveEngine=OUTPUT_PATH --timingCacheFile="C:\\a b\\c.cache"'))
      .toEqual(['--onnx=C:\\My Models\\a.onnx', '--fp16', '--saveEngine=C:\\My Models\\a_fp16.engine', '--timingCacheFile=C:\\a b\\c.cache']);
  });
});

describe('TrtEngineBuildJob', () => {
  it('reports progress and status from the [vk-build] protocol only', async () => {
    scriptedBuilds({
      stdout: '[vk-build] begin x\n[vk-build] status Parsing ONNX model...\nBuilding engine: 77%\n[vk-bu',
      stderr: 'warning 50%\n',
      code: 0,
    });
    const events: Array<[string, number]> = [];
    const outcome = await new TrtEngineBuildJob().buildWithProgress(params, 30, 60, (message, progress) => events.push([message, progress]));

    expect(outcome).toEqual({ kind: 'built' });
    expect(events).toEqual([
      ['Parsing ONNX model...', 30],
      ['Converting a.onnx... 100%', 90],
    ]);
    const [command, args] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('C:\\vk\\python.exe');
    expect(args.slice(0, 3)).toEqual(['-u', 'C:\\vk\\build_trt_engine.py', '--onnx=C:\\My Models\\a.onnx']);
  });

  it('keeps the progress it has reached when a status line arrives', async () => {
    scriptedBuilds({ stdout: '[vk-build] progress 50\n[vk-build] status Checking FP16 support...\n', code: 0 });
    const events: Array<[string, number]> = [];
    await new TrtEngineBuildJob().buildWithProgress(params, 0, 100, (message, progress) => events.push([message, progress]));
    expect(events[1]).toEqual(['Checking FP16 support...', 50]);
  });

  it('returns the static-shape fallback as a result, with the shape the model declares', async () => {
    scriptedBuilds(
      { stderr: 'Error: TensorRT engine build failed: Static model does not take explicit shapes since the shape of inference tensors will be determined by the model itself [1x3x256x256]\n', code: 1 },
      { code: 0 },
    );
    const outcome = await new TrtEngineBuildJob().build({ ...params, useStaticShape: true });
    expect(outcome).toEqual({ kind: 'built', staticShapeFallback: { detectedShape: '1x3x256x256' } });
    const retryArgs = vi.mocked(spawn).mock.calls[1][1] as string[];
    expect(retryArgs.some(arg => arg.includes('Shapes='))).toBe(false);
  });

  it('throws a real failure with both streams in the message', async () => {
    scriptedBuilds({ stdout: 'parsed\n', stderr: 'Error: out of memory\n', code: 2 });
    await expect(new TrtEngineBuildJob().build(params)).rejects.toThrow(/code 2: Error: out of memory\nparsed/);
  });

  it('ends as cancelled when cancelled mid-build', async () => {
    scriptedBuilds('hang');
    const job = new TrtEngineBuildJob();
    const build = job.build(params);
    await new Promise(resolve => setTimeout(resolve, 0));
    job.cancel();
    await expect(build).resolves.toEqual({ kind: 'cancelled' });
  });

  it('never starts a build cancelled before it began', async () => {
    scriptedBuilds({ code: 0 });
    const job = new TrtEngineBuildJob();
    job.forceStop();
    await expect(job.build(params)).resolves.toEqual({ kind: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
