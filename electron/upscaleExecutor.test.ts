import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock('fs-extra', () => ({ pathExists: async () => true, readFile: async () => 'script' }));
vi.mock('./logger', () => ({
  logger: {
    upscale: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    errorWithDialog: vi.fn(), separator: vi.fn(), getLogPath: () => '/log',
  },
}));
vi.mock('./constants', () => ({ PATHS: { PLUGINS: '/plugins' } }));
vi.mock('./utils', () => ({ setupVSEnvironment: () => ({}), pollGpuStats: async () => null }));
vi.mock('./ffmpegManager', () => ({
  FFmpegManager: { getFFmpegPath: () => '/ffmpeg', isInstalled: async () => true },
}));
vi.mock('./configManager', () => ({ configManager: {} }));
vi.mock('./ffmpegSettingsManager', () => ({
  FFmpegSettingsManager: { loadFFmpegConfig: vi.fn(async () => ({ videoArgs: [] })) },
}));
vi.mock('./processLifecycle', () => ({
  createWorkloadSpawnOptions: (o: unknown) => o,
  terminateProcessTree: vi.fn(),
}));

let releaseProbe: (info: object) => void = () => {};
vi.mock('./vapourSynthInfoExtractor', () => ({
  VapourSynthInfoExtractor: class {
    onBuildStatus?: unknown;
    cancelAll() {
      releaseProbe({ frames: 0, resolution: null, fps: null, fpsString: null, error: 'killed' });
    }
    getOutputInfo() {
      return new Promise(resolve => { releaseProbe = resolve; });
    }
  },
}));

import { UpscaleExecutor, type RunProbes } from './upscaleExecutor';
import { FFmpegSettingsManager } from './ffmpegSettingsManager';

const okInfo = { frames: 10, resolution: '64x64', fps: 24, fpsString: '24/1', pixelFormat: 'YUV420P8', error: null };
const source = { hasAudio: false, hasSubtitles: false, dar: null, duration: null, startTime: null, audioStreams: 0, subtitleStreams: 0 };
const probes = (output: RunProbes['output'] = okInfo): RunProbes => ({ source, output });

describe('stopping an upscale before it spawns', () => {
  beforeEach(() => spawn.mockReset());

  it.each(['cancel', 'kill'] as const)('%s during the graph probe starts nothing', async (stop) => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const probe = executor.getOutputInfo('/s.vpy');
    executor[stop]();
    const output = await probe;

    await expect(executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes(output))).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
    expect(executor.isStopped).toBe(true);
  });

  it.each(['cancel', 'kill'] as const)('%s while execute() is still preparing starts nothing', async (stop) => {
    let releaseConfig: (() => void) | null = null;
    vi.mocked(FFmpegSettingsManager.loadFFmpegConfig).mockImplementationOnce(
      () => new Promise(resolve => { releaseConfig = () => resolve({ videoArgs: [] } as never); }),
    );
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes());
    await vi.waitFor(() => expect(releaseConfig).not.toBeNull());
    executor[stop]();
    releaseConfig!();

    await expect(run).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a stopped executor refuses a new run', async () => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    executor.cancel();
    await expect(executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes())).rejects.toThrow('Canceled');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports a failed graph probe instead of starting the run', async () => {
    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes({ ...okInfo, resolution: null, error: 'Python exception: no module' }));

    await expect(run).rejects.toThrow('Python exception: no module');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('stopping a running upscale', () => {
  it('kill() still reaches an ffmpeg that cancel() left finishing its encode', async () => {
    const { EventEmitter } = await import('events');
    const { PassThrough } = await import('stream');
    const { terminateProcessTree } = await import('./processLifecycle');
    const fakeProcess = () => Object.assign(new EventEmitter(), {
      pid: 1, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const vspipe = fakeProcess();
    const ffmpeg = fakeProcess();
    spawn.mockReset();
    spawn.mockReturnValueOnce(vspipe).mockReturnValueOnce(ffmpeg);
    vi.mocked(terminateProcessTree).mockClear();

    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    executor.cancel();
    expect(terminateProcessTree).toHaveBeenCalledWith(vspipe, 'SIGTERM');
    expect(terminateProcessTree).not.toHaveBeenCalledWith(ffmpeg);

    executor.kill();
    expect(terminateProcessTree).toHaveBeenCalledWith(ffmpeg);

    ffmpeg.emit('close', 1);
    await expect(run).rejects.toThrow('Processing was stopped');
  });
});

describe('a failing run', () => {
  it('reports a VapourSynth failure once, not again when the app stops ffmpeg', async () => {
    const { EventEmitter } = await import('events');
    const { PassThrough } = await import('stream');
    const fakeProcess = () => Object.assign(new EventEmitter(), {
      pid: 1, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const vspipe = fakeProcess();
    const ffmpeg = fakeProcess();
    spawn.mockReset();
    spawn.mockReturnValueOnce(vspipe).mockReturnValueOnce(ffmpeg);

    const executor = new UpscaleExecutor('/vs/vspipe', '/py');
    const sent: Array<{ type: string; message: string }> = [];
    (executor as unknown as { sendProgress: (p: { type: string; message: string }) => void }).sendProgress = p => sent.push(p);
    const run = executor.execute('/s.vpy', '/out.mkv', '/in.mkv', probes());
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    vspipe.stderr.write('Error: frame 4 failed\n');
    await new Promise(resolve => setImmediate(resolve));
    vspipe.emit('close', 1);
    expect(ffmpeg.kill).toHaveBeenCalled();
    ffmpeg.emit('close', null);

    await expect(run).rejects.toThrow('frame 4 failed');
    expect(sent.filter(p => p.type === 'error')).toHaveLength(1);
  });
});

describe('binary handoff completion', () => {
  it('does not report a partial encode as complete before the producer succeeds', async () => {
    const { EventEmitter } = await import('events'); const { PassThrough } = await import('stream');
    const fake = () => Object.assign(new EventEmitter(), { pid:1,killed:false,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn() });
    const producer=fake(), consumer=fake(); spawn.mockReset(); spawn.mockReturnValueOnce(producer).mockReturnValueOnce(consumer);
    const executor=new UpscaleExecutor('/vs/vspipe','/py'); const messages: string[]=[];
    (executor as unknown as {sendProgress:(p:{type:string})=>void}).sendProgress=p=>messages.push(p.type);
    const run=executor.execute('/script','/out','/in',probes());
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(2));
    producer.stdout.write(Buffer.from('1a45dfa3','hex'));
    consumer.emit('close',0);
    expect(messages).not.toContain('complete');
    producer.stderr.write('Python exception: model inference failed\n');
    producer.emit('close',1);
    await expect(run).rejects.toThrow('model inference failed');
    expect(messages).not.toContain('complete');
  });
  it('reports stdout contamination as the upstream problem', async () => {
    const { EventEmitter } = await import('events'); const { PassThrough } = await import('stream');
    const fake = () => Object.assign(new EventEmitter(), { pid:1,killed:false,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn() });
    const producer=fake(), consumer=fake(); spawn.mockReset(); spawn.mockReturnValueOnce(producer).mockReturnValueOnce(consumer);
    const executor=new UpscaleExecutor('/vs/vspipe','/py');
    const run=executor.execute('/script','/out','/in',probes());
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(2));
    producer.stdout.write('[vk-build] compiling\n');
    await expect(run).rejects.toThrow('diagnostics to stdout');
  });
});

describe('confirmed processing outcomes', () => {
  it('reports cancelled with flushed encoded frames, never planned frames or completion', async () => {
    const { EventEmitter } = await import('events'); const { PassThrough } = await import('stream');
    const fake = () => Object.assign(new EventEmitter(), {pid:1,killed:false,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    const producer=fake(), consumer=fake(); spawn.mockReset(); spawn.mockReturnValueOnce(producer).mockReturnValueOnce(consumer);
    const executor=new UpscaleExecutor('/vs/vspipe','/py'); const messages: string[]=[]; const logs: string[]=[];
    (executor as unknown as {sendProgress:(p:{type:string})=>void}).sendProgress=p=>messages.push(p.type);
    executor.onDiagnostic = message => logs.push(message);
    const run=executor.execute('/script','/out','/in',probes());
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(2));
    producer.stdout.write(Buffer.from('1a45dfa3','hex'));
    consumer.stderr.write('frame=2\nfps=3\nprogress=continue\n');
    executor.cancel();
    producer.emit('close',1);
    consumer.stderr.write('frame=4\nfps=3\nprogress=end\n');
    consumer.emit('close',0);
    await expect(run).rejects.toThrow('Processing was stopped');
    expect(messages).not.toContain('complete');
    const report=JSON.parse(logs.find(line=>line.startsWith('[pipeline-summary]'))!.slice('[pipeline-summary] '.length));
    expect(report).toMatchObject({status:'cancelled',plannedFrames:10,encodedFrames:4,producedFrames:null});
  });
  it('records actual producer and encoder counts for a successful run', async () => {
    const { EventEmitter } = await import('events'); const { PassThrough } = await import('stream');
    const fake = () => Object.assign(new EventEmitter(), {pid:1,killed:false,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    const producer=fake(), consumer=fake(); spawn.mockReset(); spawn.mockReturnValueOnce(producer).mockReturnValueOnce(consumer);
    const executor=new UpscaleExecutor('/vs/vspipe','/py'); const logs: string[]=[]; executor.onDiagnostic=line=>logs.push(line);
    const run=executor.execute('/script','/out','/in',probes());
    await vi.waitFor(()=>expect(spawn).toHaveBeenCalledTimes(2));
    producer.stdout.write(Buffer.from('1a45dfa3','hex'));
    producer.stderr.write('Output 10 video frames and 0 audio samples in 2.50 seconds\n');
    producer.emit('close',0);
    consumer.stderr.write('frame=10\nfps=4\nprogress=end\n');consumer.emit('close',0);
    await run;
    const report=JSON.parse(logs.find(line=>line.startsWith('[pipeline-summary]'))!.slice('[pipeline-summary] '.length));
    expect(report).toMatchObject({status:'completed',encodedFrames:10,producedFrames:10,producerFps:4,producerTimingIncludesDownstreamBackpressure:true});
  });
});
