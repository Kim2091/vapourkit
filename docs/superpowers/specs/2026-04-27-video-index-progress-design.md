# Video Index Progress UI

**Date:** 2026-04-27
**Status:** Approved for implementation

## Problem

When a video is loaded (drag-drop, file picker, or queue requeue), `getVideoInfo` runs BestSource via `vspipe -i` to extract the exact frame count. For large files this can take many seconds to minutes with no UI feedback — the app appears frozen on the input panel.

Bonus problem discovered during investigation: the load probe uses `cachemode=0` (no cache), but the upscale script uses `cachemode=3` (cache to `.bsindex`). Every video load currently throws away the index it just built, then the upscale step re-indexes the same file from scratch. Loading the video twice is paying for indexing twice.

## Goal

Show an inline progress bar under the input video drop area while indexing is in flight, with a real percentage parsed from BestSource's own progress reporting. Bundle the cachemode fix so the index built during load is reused at upscale time.

## Non-goals

- No progress UI for video info extraction by other paths (audio probes, thumbnail extraction).
- No cancellation button for indexing (deferred — indexing always completes or errors).
- No "estimated time remaining" — just percentage.

The bar shows for any `getVideoInfo` call that triggers indexing, including queue-item processing — the IPC channel is global and the bar always reflects the currently loaded video, which the queue processor sets via `setVideoInfo` anyway.

## Source signal

BestSource exposes a `showprogress` parameter (default ON). When enabled, the VapourSynth wrapper emits log messages of the form:

```
VideoSource track #0 index progress 47%
VideoSource track #0 indexing complete
```

Reference: [bestsource/src/vapoursynth.cpp:204](https://github.com/vapoursynth/bestsource/blob/master/src/vapoursynth.cpp#L204).

These flow to `vspipe`'s stderr today and are captured into a buffer that's only inspected at process exit. The fix streams them.

When the source filesize is unknown, BestSource emits "MB" instead of "%". In that case the bar is suppressed (treated as no-op); the user just waits without a bar. This is rare and acceptable.

## Architecture

### Backend

**1. `electron/videoUtils.ts` — `getVideoFrameCount`**

- Add an optional second parameter: `onProgress?: (percentage: number) => void`.
- Replace bulk-buffer stderr accumulation with a chunk-by-chunk parser. For each stderr `data` event, scan for `/VideoSource track #\d+ index progress (\d+)%/g` matches and invoke `onProgress(parseInt(match[1], 10))` for each.
- Continue accumulating into the existing buffer for the final "Frames: N" parse — don't break that path.
- Switch the script template from `cachemode=0` to `cachemode=3` (bundled cachemode fix). The temp script directory should still be cleaned up; only the `.bsindex` next to the source video persists.

**2. `electron/videoHandlers.ts` — `get-video-info` handler**

- Pass an `onProgress` callback into `getVideoFrameCount`.
- Inside the callback: `mainWindow?.webContents.send('video-index-progress', { percentage })`.
- After the call resolves (or rejects): send `{ percentage: 100, complete: true }` so the renderer can clear the bar even if the last % event was 99 or never fired (cached case).

**3. `electron/preload.ts`**

- Expose `onVideoIndexProgress(callback: (progress: { percentage: number; complete: boolean }) => void): () => void` mirroring the existing `onUpscaleProgress` signature (returns an unsubscribe function). The `complete` flag tells the renderer when to clear the bar without special-casing `percentage === 100`.

**4. `src/electron.d.ts`**

- Add `onVideoIndexProgress` to the `electronAPI` type definition.

### Frontend

**1. `src/hooks/useVideoProcessing.ts`**

- New state: `const [indexingProgress, setIndexingProgress] = useState<number | null>(null)`.
- New `useEffect` that subscribes to `window.electronAPI.onVideoIndexProgress`, stores the latest percentage. Returns the unsubscribe.
- In `loadVideoInfo`: set `indexingProgress` to `0` before calling `getVideoInfo`; on error, clear to `null` in a `catch` block before re-throwing. On success, the backend's terminal `complete: true` IPC event clears it asynchronously — a renderer-side `finally` would prematurely null the bar before `setVideoInfo` runs and cause a visible flicker.
- Return `indexingProgress` from the hook.

**2. `src/App.tsx`**

- Pull `indexingProgress` out of `useVideoProcessing` and pass it as a prop into `VideoInputPanel`.

**3. `src/components/VideoInputPanel.tsx`**

- New optional prop: `indexingProgress: number | null`.
- Below the drop zone div, conditionally render a thin progress row when `indexingProgress !== null`:
  - Tailwind progress bar matching existing dark-themed bars elsewhere in the app (study `ProgressPanel.tsx` for visual consistency).
  - Label: `Indexing video — {percentage}%`.
  - No cancel button.

## Data flow

```
User drops video
  → useVideoDragDrop.handleDrop
  → useVideoProcessing.loadVideoInfo
      ├── setIndexingProgress(0)
      ├── window.electronAPI.getVideoInfo(filePath)
      │     → IPC: get-video-info
      │     → videoHandlers: extractVideoMetadata + getVideoFrameCount(path, onProgress)
      │           → spawn vspipe -i (cachemode=3)
      │           → stderr chunks parsed for "index progress N%"
      │           → onProgress(N) → mainWindow.webContents.send('video-index-progress', { percentage: N })
      │                              → renderer subscribed listener → setIndexingProgress(N)
      │                              → VideoInputPanel re-renders bar
      │           → vspipe exits → final frame count returned
      ├── (in finally) setIndexingProgress(null) → bar disappears
      └── setVideoInfo(info)
```

## Edge cases

| Case | Behavior |
|------|----------|
| Cached video (already has `.bsindex`) | No progress events fire. Bar appears at 0% only briefly (between `setIndexingProgress(0)` and `getVideoInfo` resolving). Acceptable; if too flickery in practice, defer first paint by 200ms. |
| Indexing fails | `getVideoInfo` rejects → `finally` clears progress → existing error path shows toast. |
| Two loads in quick succession | State is a single number, latest event wins. No race because each `loadVideoInfo` awaits its own `getVideoInfo` and the IPC channel is shared (last-emitted wins). |
| BestSource emits "MB" instead of "%" | Regex matches percentage form only — "MB" form ignored. Bar stays at 0% until completion, then disappears. Acceptable for the rare unknown-filesize case. |
| Queue item mid-processing | `useQueueProcessing` calls `getVideoInfo` directly, but the same IPC events would fire. The bar is gated to render only when `indexingProgress` is set in `useVideoProcessing` state, which is only updated when *its own* `loadVideoInfo` runs. So queue indexing won't show the bar — by design. |

## Testing

- Manual: load a fresh large video (no existing `.bsindex` next to it). Verify bar appears, percentage climbs, disappears on completion.
- Manual: load the same video again. Verify no bar appears (or only flickers briefly), since indexing is cached.
- Manual: start an upscale on the just-loaded video. Verify the upscale step does NOT re-index (check log for absence of "indexing complete" during the upscale step).
- No new automated tests required — the IPC streaming path mirrors the existing upscale-progress pattern which is exercised by manual use.

## Risks

- **BestSource output format changes between versions.** The regex is brittle. Mitigation: regex is permissive (`#\d+` for any track), and if it fails to match the bar simply doesn't update — the operation still completes correctly via the existing exit-code path.
- **`cachemode=3` writes a `.bsindex` file next to the source video.** If the user's source dir is read-only, BestSource will fail. This was already the behavior at upscale time, so no regression — the failure surface just moves earlier (to load instead of upscale start).

## Out of scope

- Cancellation of indexing.
- Progress for the queue's own `getVideoInfo` calls.
- Replacing the toast notification system.
- Showing time-remaining estimates.
