# Video Index Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a real-percentage progress bar inside the input video panel while BestSource indexes a newly loaded video, and switch the load probe to write a reusable `.bsindex` file so the upscale step doesn't re-index.

**Architecture:** Backend parses `vspipe -i` stderr in real time for BestSource progress lines, exposes the percentage via a new IPC channel `video-index-progress`. Renderer subscribes in `useVideoProcessing` and renders a thin bar inside `VideoInputPanel` below the drop zone. Cachemode is bumped from 0 → 3 in the load probe script.

**Tech Stack:** TypeScript, Electron 32, React 18, Vitest, VapourSynth/BestSource (external).

**Spec:** [docs/superpowers/specs/2026-04-27-video-index-progress-design.md](../specs/2026-04-27-video-index-progress-design.md)

---

## File Structure

**Created:**
- `electron/bestSourceProgressParser.ts` — pure stderr-chunk parser; testable in isolation.
- `electron/bestSourceProgressParser.test.ts` — vitest unit tests.

**Modified:**
- `electron/videoUtils.ts` — `getVideoFrameCount` accepts `onProgress` callback, uses parser, switches `cachemode=0` → `cachemode=3`.
- `electron/videoHandlers.ts` — `get-video-info` handler wires callback to IPC channel.
- `electron/preload.ts` — exposes `onVideoIndexProgress`.
- `src/electron.d.ts` — types for new API.
- `src/hooks/useVideoProcessing.ts` — `indexingProgress` state + IPC subscription.
- `src/App.tsx` — passes `indexingProgress` into `VideoInputPanel`.
- `src/components/VideoInputPanel.tsx` — conditionally renders bar below drop zone.

---

## Task 1: BestSource progress parser (pure function + tests)

**Files:**
- Create: `electron/bestSourceProgressParser.ts`
- Create: `electron/bestSourceProgressParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/bestSourceProgressParser.test.ts` with this exact content:

```ts
import { describe, it, expect } from 'vitest';
import { parseBestSourceProgress } from './bestSourceProgressParser';

describe('parseBestSourceProgress', () => {
  it('returns empty array for chunks with no progress lines', () => {
    expect(parseBestSourceProgress('some unrelated stderr text')).toEqual([]);
    expect(parseBestSourceProgress('')).toEqual([]);
  });

  it('extracts percentage from a single progress line', () => {
    const chunk = 'VideoSource track #0 index progress 47%';
    expect(parseBestSourceProgress(chunk)).toEqual([47]);
  });

  it('extracts multiple percentages from a multi-line chunk', () => {
    const chunk = [
      'VideoSource track #0 index progress 10%',
      'VideoSource track #0 index progress 20%',
      'VideoSource track #0 index progress 30%',
    ].join('\n');
    expect(parseBestSourceProgress(chunk)).toEqual([10, 20, 30]);
  });

  it('matches lines with VapourSynth log-level prefixes', () => {
    const chunk = 'Information: VideoSource track #0 index progress 75%';
    expect(parseBestSourceProgress(chunk)).toEqual([75]);
  });

  it('matches any track number', () => {
    const chunk = 'VideoSource track #3 index progress 50%';
    expect(parseBestSourceProgress(chunk)).toEqual([50]);
  });

  it('ignores the MB variant (unknown filesize case)', () => {
    const chunk = 'VideoSource track #0 index progress 123MB';
    expect(parseBestSourceProgress(chunk)).toEqual([]);
  });

  it('ignores non-progress BestSource lines', () => {
    expect(parseBestSourceProgress('VideoSource track #0 indexing complete')).toEqual([]);
    expect(parseBestSourceProgress('VideoSource track #0 using CPU decoding fallback')).toEqual([]);
  });

  it('clamps percentages to 0-100 range', () => {
    expect(parseBestSourceProgress('VideoSource track #0 index progress 150%')).toEqual([100]);
  });

  it('handles a chunk that mixes progress lines with unrelated noise', () => {
    const chunk = [
      'random noise',
      'VideoSource track #0 index progress 25%',
      'more noise',
      'VideoSource track #0 index progress 50%',
      'unrelated',
    ].join('\n');
    expect(parseBestSourceProgress(chunk)).toEqual([25, 50]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:electron -- bestSourceProgressParser`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `electron/bestSourceProgressParser.ts` with this exact content:

```ts
const PROGRESS_LINE = /VideoSource track #\d+ index progress (\d+)%/g;

/**
 * Parses BestSource progress lines from a stderr chunk.
 * Returns the percentages extracted (in order). Empty array if no matches.
 * Percentages are clamped to [0, 100].
 */
export function parseBestSourceProgress(chunk: string): number[] {
  const out: number[] = [];
  PROGRESS_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROGRESS_LINE.exec(chunk)) !== null) {
    const raw = parseInt(match[1], 10);
    if (Number.isFinite(raw)) {
      out.push(Math.max(0, Math.min(100, raw)));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:electron -- bestSourceProgressParser`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/bestSourceProgressParser.ts electron/bestSourceProgressParser.test.ts
git commit -m "Add BestSource stderr progress parser"
```

---

## Task 2: Wire progress callback into getVideoFrameCount + cachemode fix

**Files:**
- Modify: `electron/videoUtils.ts:162-260`

- [ ] **Step 1: Update the function signature and stderr handling**

In `electron/videoUtils.ts`, replace the existing `getVideoFrameCount` function (currently around lines 162-260) with this version:

```ts
export async function getVideoFrameCount(
  filePath: string,
  onProgress?: (percentage: number) => void
): Promise<number | undefined> {
  try {
    if (!fs.existsSync(PATHS.VSPIPE)) {
      logger.warn('VapourSynth vspipe not available for frame count extraction');
      return undefined;
    }

    if (!fs.existsSync(PATHS.PYTHON)) {
      logger.warn('VapourSynth Python not available for frame count extraction');
      return undefined;
    }

    const bestSourcePath = path.join(PATHS.PLUGINS, 'bestsource.dll');
    if (!fs.existsSync(bestSourcePath)) {
      logger.warn('BestSource plugin not available for frame count extraction');
      return undefined;
    }

    const tempDir = path.join(os.tmpdir(), 'vapourkit_framecount');
    await fs.ensureDir(tempDir);

    const scriptPath = path.join(tempDir, `framecount_${Date.now()}.vpy`);
    const escapedPath = filePath.replace(/\\/g, '\\\\');

    // cachemode=3 writes a .bsindex next to the source so the upscale step reuses it.
    const script = `import vapoursynth as vs
core = vs.core

clip = core.bs.VideoSource(source="${escapedPath}", cachemode=3)
clip.set_output()
`;

    await fs.writeFile(scriptPath, script, 'utf8');
    logger.info(`Created temporary frame count script: ${scriptPath}`);

    return new Promise<number | undefined>((resolve) => {
      const env = setupVSEnvironment(PATHS.PYTHON);

      const vspipe = spawn(PATHS.VSPIPE, ['-i', scriptPath, '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env,
        cwd: PATHS.VS
      });

      let output = '';

      const handleChunk = (data: Buffer) => {
        const text = data.toString();
        output += text;
        if (onProgress) {
          for (const pct of parseBestSourceProgress(text)) {
            onProgress(pct);
          }
        }
      };

      if (vspipe.stdout) {
        vspipe.stdout.on('data', handleChunk);
      }
      if (vspipe.stderr) {
        vspipe.stderr.on('data', handleChunk);
      }

      vspipe.on('close', async (code) => {
        try {
          await fs.remove(scriptPath);
        } catch (e) {
          // Ignore cleanup errors
        }

        if (code === 0) {
          const match = output.match(/Frames:\s*(\d+)/i);
          if (match) {
            const frames = parseInt(match[1], 10);
            logger.info(`Detected ${frames} frames from BestSource`);
            resolve(frames);
          } else {
            logger.warn('Could not parse frame count from vspipe output');
            logger.debug(`vspipe output: ${output.substring(0, 500)}`);
            resolve(undefined);
          }
        } else {
          logger.warn(`vspipe failed with code ${code}, could not get frame count`);
          logger.debug(`vspipe output: ${output.substring(0, 500)}`);
          resolve(undefined);
        }
      });
    });
  } catch (error) {
    logger.error('Error in getVideoFrameCount:', error);
    return undefined;
  }
}
```

- [ ] **Step 2: Add the parser import**

At the top of `electron/videoUtils.ts`, in the existing import block (the imports currently include `spawn`, `fs`, `path`, `os`, `PATHS`, `logger`, `setupVSEnvironment`), add:

```ts
import { parseBestSourceProgress } from './bestSourceProgressParser';
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc -p tsconfig.electron.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify existing tests still pass**

Run: `npm run test:electron`
Expected: all tests pass (parser tests from Task 1 plus pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add electron/videoUtils.ts
git commit -m "Stream BestSource progress via callback, switch load probe to cachemode=3"
```

---

## Task 3: IPC channel + preload + types

**Files:**
- Modify: `electron/videoHandlers.ts:60-91` (the `get-video-info` handler)
- Modify: `electron/preload.ts:20` (add new API alongside `getVideoInfo`)
- Modify: `src/electron.d.ts` (add type declaration alongside `getVideoInfo`)

- [ ] **Step 1: Wire callback to IPC in get-video-info handler**

In `electron/videoHandlers.ts`, replace the `get-video-info` handler body (currently around lines 60-91) with this version:

```ts
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
      // Make sure the renderer clears its progress UI even on error
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('video-index-progress', { percentage: 100, complete: true });
      }
      throw error;
    }
  });
```

- [ ] **Step 2: Expose onVideoIndexProgress in preload**

In `electron/preload.ts`, locate the line `getVideoInfo: (filePath: string) => ipcRenderer.invoke('get-video-info', filePath),` (around line 20). Immediately after that line, add:

```ts
  onVideoIndexProgress: (callback: (progress: { percentage: number; complete: boolean }) => void) => {
    const listener = (event: any, progress: { percentage: number; complete: boolean }) => callback(progress);
    ipcRenderer.on('video-index-progress', listener);
    return () => ipcRenderer.removeListener('video-index-progress', listener);
  },
```

- [ ] **Step 3: Add type to electron.d.ts**

In `src/electron.d.ts`, find the `getVideoInfo` declaration (search for `getVideoInfo:`). Immediately after its declaration line, add:

```ts
  onVideoIndexProgress: (callback: (progress: { percentage: number; complete: boolean }) => void) => () => void;
```

- [ ] **Step 4: Verify typecheck passes (both projects)**

Run: `npx tsc --noEmit && npx tsc -p tsconfig.electron.json --noEmit`
Expected: no errors in either project.

- [ ] **Step 5: Verify existing tests still pass**

Run: `npm test && npm run test:electron`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add electron/videoHandlers.ts electron/preload.ts src/electron.d.ts
git commit -m "Add video-index-progress IPC channel"
```

---

## Task 4: Renderer state + subscription in useVideoProcessing

**Files:**
- Modify: `src/hooks/useVideoProcessing.ts`

- [ ] **Step 1: Add the indexingProgress state and subscription**

In `src/hooks/useVideoProcessing.ts`, locate the existing state declarations near the top of the `useVideoProcessing` function (right around `const [videoLoadError, setVideoLoadError] = useState(false);`). Add directly after that line:

```ts
  const [indexingProgress, setIndexingProgress] = useState<number | null>(null);
```

- [ ] **Step 2: Add the IPC subscription effect**

In `src/hooks/useVideoProcessing.ts`, just after the existing `useEffect` that syncs `outputPathRef.current = outputPath;` (search for `outputPathRef.current = outputPath`), add this new effect:

```ts
  // Subscribe to BestSource indexing progress events from the backend
  useEffect(() => {
    const unsubscribe = window.electronAPI.onVideoIndexProgress((progress) => {
      if (progress.complete) {
        setIndexingProgress(null);
      } else {
        setIndexingProgress(progress.percentage);
      }
    });
    return unsubscribe;
  }, []);
```

- [ ] **Step 3: Initialize state on loadVideoInfo entry**

In `src/hooks/useVideoProcessing.ts`, find the `loadVideoInfo` function (currently around line 150) and replace its body with this version:

```ts
  const loadVideoInfo = useCallback(async (filePath: string): Promise<void> => {
    onLog(`Selected video: ${filePath}`);
    setIndexingProgress(0);
    let info;
    try {
      info = await window.electronAPI.getVideoInfo(filePath);
    } catch (error) {
      setIndexingProgress(null);
      throw error;
    }

    // Cleanup old blob URL before loading new video
    if (completedVideoBlobUrl) {
      URL.revokeObjectURL(completedVideoBlobUrl);
    }

    setVideoInfo(info);
    onLog(`Video info: ${info.resolution || 'unknown'} @ ${info.fps || 'unknown'} FPS`);

    const defaultFolderResult = await window.electronAPI.getDefaultOutputFolder();
    const defaultOutputFolder = defaultFolderResult.folder;

    let autoOutputPath: string;
    if (defaultOutputFolder) {
      const fileName = filePath.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '') || 'output';
      const separator = defaultOutputFolder.includes('\\') ? '\\' : '/';
      autoOutputPath = `${defaultOutputFolder}${separator}${fileName}_processed.${outputFormat}`;
      onLog(`Using default output folder: ${defaultOutputFolder}`);
    } else {
      autoOutputPath = filePath.replace(/\.[^/.]+$/, '') + '_processed.' + outputFormat;
    }
    setOutputPath(autoOutputPath);
    onLog(`Auto-suggested output path: ${autoOutputPath}`);

    setPreviewFrame(null);
    setCompletedVideoPath(null);
    setCompletedVideoBlobUrl(null);
    setVideoLoadError(false);
  }, [onLog, completedVideoBlobUrl, outputFormat]);
```

The `complete: true` event from the backend's `finally` block will clear `indexingProgress` even on success — so this code only resets it explicitly on the catch path, where the IPC event might not fire if the failure happened before frame counting started.

- [ ] **Step 4: Return indexingProgress from the hook**

At the end of `src/hooks/useVideoProcessing.ts`, find the `return {` block (around line 371). Add `indexingProgress,` as a new entry, alphabetized or grouped near the other video-state values (e.g., right after `videoLoadError,`):

```ts
    videoLoadError,
    indexingProgress,
    loadVideoInfo,
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Verify existing tests still pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useVideoProcessing.ts
git commit -m "Subscribe to video index progress in useVideoProcessing"
```

---

## Task 5: Render bar in VideoInputPanel + wire from App

**Files:**
- Modify: `src/App.tsx` (pull `indexingProgress` from hook, pass to `VideoInputPanel`)
- Modify: `src/components/VideoInputPanel.tsx` (new prop, conditional render)

- [ ] **Step 1: Pull indexingProgress from useVideoProcessing in App.tsx**

In `src/App.tsx`, find the destructuring from `useVideoProcessing` (search for `loadVideoInfo,` — there's a destructuring block that returns multiple values from the hook). Add `indexingProgress,` to that destructure block. Example: if you find a destructure like `const { videoInfo, ..., loadVideoInfo, ... } = useVideoProcessing(...)`, add `indexingProgress` alongside.

- [ ] **Step 2: Pass indexingProgress prop into VideoInputPanel**

In `src/App.tsx`, find the JSX element `<VideoInputPanel` (search for `<VideoInputPanel`). Add the new prop alongside the existing ones:

```tsx
<VideoInputPanel
  videoInfo={videoInfo}
  isDragging={isDragging}
  isProcessing={isProcessing}
  queueCount={queue.length}
  showQueue={showQueue}
  indexingProgress={indexingProgress}
  onSelectVideo={handleSelectVideo}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
  onToggleQueue={onToggleQueue}
/>
```

(Match the actual prop names and handler names already used at the existing `<VideoInputPanel>` site — this snippet shows the shape; copy the existing props verbatim and just add the `indexingProgress` line.)

- [ ] **Step 3: Add prop and bar to VideoInputPanel**

In `src/components/VideoInputPanel.tsx`, replace the file's contents with this version:

```tsx
import { memo } from 'react';
import { Upload, Video, List, PanelRightOpen, PanelRightClose } from 'lucide-react';
import type { VideoInfo } from '../electron.d';

interface VideoInputPanelProps {
  videoInfo: VideoInfo | null;
  isDragging: boolean;
  isProcessing: boolean;
  queueCount: number;
  showQueue: boolean;
  indexingProgress: number | null;
  onSelectVideo: () => Promise<void>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => Promise<void>;
  onToggleQueue: () => void;
}

export const VideoInputPanel = memo<VideoInputPanelProps>(({
  videoInfo,
  isDragging,
  isProcessing,
  queueCount,
  showQueue,
  indexingProgress,
  onSelectVideo,
  onDragOver,
  onDragLeave,
  onDrop,
  onToggleQueue,
}: VideoInputPanelProps) => {
  return (
    <div className="flex-shrink-0 bg-dark-elevated rounded-xl border border-gray-800 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <Upload className="w-4 h-4 text-primary-blue" />
          <h2 className="text-base font-semibold">Input Video</h2>
        </div>
        <button
          onClick={onToggleQueue}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-all border ${
            showQueue
              ? 'bg-blue-500/10 border-blue-500/50 text-blue-400'
              : 'bg-dark-surface hover:bg-dark-bg border-gray-700 text-gray-400 hover:text-gray-300'
          }`}
          title={showQueue ? 'Hide queue' : 'Show queue'}
        >
          <List className="w-3.5 h-3.5" />
          <span>Queue {queueCount > 0 && `(${queueCount})`}</span>
          {showQueue ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-all duration-300 ${
          isDragging
            ? 'border-primary-purple bg-primary-purple/10'
            : 'border-gray-700 hover:border-gray-600'
        } ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        onClick={!isProcessing ? onSelectVideo : undefined}
      >
        {videoInfo ? (
          <div>
            <Video className="w-8 h-8 text-primary-purple mx-auto mb-2" />
            <p className="text-sm font-medium mb-1 truncate">{videoInfo.name}</p>
            <p className="text-xs text-gray-400">{videoInfo.resolution} • {videoInfo.fps} FPS • {videoInfo.sizeFormatted}</p>
            <p className="text-xs text-gray-500 mt-0.5">{videoInfo.duration}</p>
          </div>
        ) : (
          <div>
            <Upload className="w-8 h-8 text-gray-600 mx-auto mb-2" />
            <p className="text-xs text-gray-400 mb-1">Drop video(s) here or click to browse</p>
            <p className="text-xs text-gray-500">Select multiple to add to queue</p>
          </div>
        )}
      </div>

      {indexingProgress !== null && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-400">Indexing video</span>
            <span className="text-xs text-gray-400 tabular-nums">{indexingProgress}%</span>
          </div>
          <div className="h-1.5 bg-dark-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-primary-blue transition-all duration-200 ease-out"
              style={{ width: `${indexingProgress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify all tests still pass**

Run: `npm test && npm run test:electron`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/VideoInputPanel.tsx
git commit -m "Render BestSource indexing progress bar under video drop zone"
```

---

## Task 6: Manual verification

**No file changes — verification only.** This task confirms the feature works end-to-end since the indexing path can't be unit-tested without a live vspipe + a real video.

- [ ] **Step 1: Build and launch the dev app**

Run: `npm run dev`
Expected: the Electron window opens on `http://localhost:5173`.

- [ ] **Step 2: Verify the bar appears for an un-indexed video**

Find a large video file (>200 MB) that does NOT have a `.bsindex` file next to it. (If unsure, delete any `<video>.bsindex` next to it first.)
Drag the video onto the input panel.
Expected:
- Bar appears under the drop zone within ~1 second.
- Percentage climbs (e.g., "Indexing video — 12%" → "47%" → "89%").
- Bar disappears the instant indexing finishes.
- Video info (resolution / FPS / size / duration) appears as normal.

- [ ] **Step 3: Verify the bar does NOT appear (or only flickers) for a cached video**

Drop the same video again (now that the `.bsindex` exists).
Expected: bar does not appear, OR only flickers at 0% for under a second before disappearing. Video info appears nearly instantly.

- [ ] **Step 4: Verify the index gets reused at upscale time**

Add at least one filter (any), set an output path, click Upscale.
Watch the upscale start log.
Expected: no "indexing complete" line in the log during upscale start — `getFrameCount` returns immediately because the cached `.bsindex` is present.

- [ ] **Step 5: Verify failure path clears the bar**

Drop a non-video file (e.g., a `.txt`). Or drop a corrupt video.
Expected: the bar appears briefly then disappears when the error toast shows. UI returns to its idle state cleanly.

- [ ] **Step 6: Note any drift from expected behavior**

If anything renders wrong, log the deviation and stop — return to Phase 1 of systematic-debugging before patching. If everything matches, the feature is done.

---

## Self-Review Notes

**Spec coverage check:**
- Inline bar under drop zone ✓ (Task 5)
- Real-percentage progress from BestSource ✓ (Tasks 1, 2)
- IPC channel pattern matching upscale-progress ✓ (Task 3)
- `cachemode=0` → `cachemode=3` bundled fix ✓ (Task 2)
- Edge cases: cached video / failure / multiple loads ✓ (Tasks 4, 6)
- "Complete" signal pattern ✓ (Task 3)
- Queue items show bar too (per updated non-goals) ✓ (Task 4 subscribes globally)

**Type consistency check:**
- `parseBestSourceProgress(chunk: string): number[]` — defined Task 1, consumed Task 2.
- IPC event payload `{ percentage: number; complete: boolean }` — emitted Task 3, consumed Task 4 (via preload type Task 3, then declared in `electron.d.ts` Task 3).
- `indexingProgress: number | null` — declared Task 4, returned Task 4, consumed Task 5.
- `onVideoIndexProgress` — defined preload Task 3, declared types Task 3, used hook Task 4.

All names match across tasks.
