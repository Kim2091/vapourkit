# Pipeline reliability and measurement

VapourSynth remains pinned to R79. Its API3/API4 compatibility is retained. No core upgrade, automatic GPU scheduling change, or dependency upgrade is part of this change.

## Encoding reliability

A cold TensorRT build previously inherited the media producer's stdout. Builder progress could therefore precede Matroska's EBML header and make FFmpeg report `EBML header parsing failed`, followed by a stdin EOF. The runtime now sends builder stdout/stderr to descriptor 2, and the builder entry point also redirects native stdout. Generated Python scripts route `print()` to stderr without redirecting the media descriptor itself.

The Node handoff checks the initial Matroska header across chunk boundaries and keeps normal stream backpressure. It fails with an upstream diagnostic if stdout contains text or no header. It does not strip arbitrary bytes or attempt to repair corrupt media. Render completion requires both VapourSynth and FFmpeg to succeed, so an FFmpeg exit of zero cannot hide a late producer failure. Python traceback details take priority over a generic downstream input error.

This is a reproducible cause of the reported symptom, rather than proof of the precise source in a log that contains only FFmpeg's final error. CI exercises noisy cold-build output, real R79 frames, the Node relay, and FFmpeg decoding; GPU execution is stubbed in that transport test.

## Controls

Settings → Processing contains pipeline controls:

- Concurrent frame requests: automatic (the unchanged default), or a bounded vspipe request count. More requests may increase RAM/VRAM without improving throughput. The existing model inference-stream setting remains separate.
- Encoding preview height and frame rate: default 720 pixels and 1 fps. These affect only the JPEG preview output. Turning preview off before rendering removes that output branch.
- Keep RGB between adjacent AI models: experimental and off by default. Eligible adjacent AI stages avoid the intermediate RGB → YUV444P16 → RGB conversion. Custom filters, retained reference steps, and chain ends remain boundaries. Preview taps receive their own YUV view. Eliminating a conversion can change rounding and subsequent neural outputs; compare results before adopting it.

Saved controls apply to new validations/renders. Reopen an existing preview to apply them. No automatic tuner selects a winner from a different GPU or video.

## Repeatable benchmarks

Load a video and workflow, then select **Export current pipeline benchmark bundle** in Settings → Processing. A new directory contains `benchmark.json`, `source.vpy`, `workflow.vpy`, and `workflow-rgb.vpy`. It references your current installation, source and models; it does not copy those assets or change your workflow. Scripts can execute custom filter code exactly as a normal workflow does. Review paths before sharing a bundle/report.

Use a checkout of this branch, `npm ci`, `npm run build`, and Python 3.12. The app's private Python is suitable if its dependencies are installed. From the checkout, for example:

```sh
python scripts/benchmarkPipeline.py --bundle /path/to/benchmark.json --node node --frames 96 --runs 3 --requests 1,4 --threads 4 --output legacy.json
python scripts/benchmarkPipeline.py --bundle /path/to/benchmark.json --node node --variant rgb --frames 96 --runs 3 --requests 1,4 --threads 4 --output rgb.json
```

On Windows replace `python` with the full path to `data/vapoursynth-portable/python.exe` and quote paths containing spaces. Bundle vspipe/FFmpeg paths are used unless explicitly overridden. `--node` includes the actual Node/MatroskaPipe relay; omitting it measures a direct OS pipe and labels that limitation in the report.

The four stages are source evaluation (decode), full graph evaluation without media serialization (filter), encoding a fixed uncompressed snapshot (encode), and the full video pipeline through the Matroska pipe (combined). The filter stage includes decoding. Encoder-only includes reading/demuxing the warm snapshot. Do not subtract these parallel stage timings to invent isolated costs. The benchmark excludes audio/subtitle muxing and final container writes; it is not a full queue job timing.

Reports record bounded frame counts, per-run times, medians/FPS, actual core/thread/format metadata, encoder arguments, and Node producer/consumer status. Graph preparation and snapshot warmup are separate; each measured run still includes fresh process startup. Engine creation during graph preparation is excluded from measured medians. Compare cold-build/startup logs separately. Normal render logs now include time to first media bytes, first encoded progress, and total encode-run time.

Start with 48–120 frames. The default snapshot limit is 1 GiB and available disk is checked; lower `--frames` for high resolution/RGB float clips. `--max-cache-mib` raises the explicit budget. `--streams 1,2` sweeps managed TensorRT calls in benchmark copies only; unsupported scripts fail rather than silently ignore it. `--requests`, `--threads`, and `--streams` combinations are limited to 32. `--preview` adds the encoding preview branch; compare the same workflow with it off/on. Use `--preview-height` and `--preview-fps` to explore its cost.

Exported encoder arguments are used, with source metadata/audio/subtitle mappings omitted and listed in the report. Advanced extra inputs/complex filter graphs require a video-only `--encoder-args` JSON array. For a CPU baseline, use `--encoder-args '["-c:v","libx264","-preset","veryfast","-crf","18","-threads","4"]'` (adjust shell quoting on Windows). Keep encoder, preview, source, frame range, cache state and hardware identical between comparisons. Rerun close/noisy results, then verify output quality and memory use on real models before changing production settings.

## Development measurement (CPU fixture, not a GPU promise)

An R79/BestSource fixture used 96 frames of 1280×720 `testsrc2`, two RGB floating-point clamp operations, four VS threads, libx264 veryfast/CRF18/four encoder threads, the Node relay, and three measured samples. The legacy script inserted a YUV444P16 roundtrip between the clamps; the RGB script retained RGB. Median wall times in milliseconds:

| Layout | Requests | Decode | Filter | Encode | Combined |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | 1 | 368.7 | 968.3 | 597.2 | 1506.7 |
| Legacy | 4 | 318.7 | 795.4 | 579.2 | 1413.4 |
| RGB | 1 | 315.2 | 718.3 | 626.2 | 1306.1 |
| RGB | 4 | 315.0 | 599.5 | 570.9 | 1272.7 |

At four requests this fixture reduced measured filter time by about 25% and combined time by about 10%. A shorter 360p fixture gave mixed results, reinforcing the need for measurement. These are CPU conversion measurements, not measured TensorRT speedups. A first-frame 8-bit YUV comparison differed by at most one code value in this fixture; this does not bound differences after arbitrary neural models. RGB chaining therefore remains opt-in. No physical GPU throughput claim has been established.

## Engine reuse and follow-up UI fixes

Engine compatibility uses an explicit adapter ABI, model/weight hashes, GPU and runtime identity, precision, profile coverage, and engine integrity. The helper's entire source-file hash is diagnostic; an unrelated logging/cache edit does not invalidate every engine. Plugin location is diagnostic too, while the loaded binary's content hash and version fields remain compatibility checks. Legacy plugin paths are fingerprinted when available; an unresolved old path is not silently trusted. Breaking adapter changes must bump `ENGINE_ABI`.

A validated cached engine with a different filename can be reused if all checks pass and its profile covers the requested stage dimensions. Preview, validation, and render processes coordinate preparation of the same cache key with an OS file lock, then recheck the published engine after waiting. Locks release on process exit. No architecture's profiles are automatically expanded. An uncovered resolution, changed model/weights, precision, GPU, runtime, or damaged engine can still require a build. `[vk-cache]` stderr lines identify reuse, waits, and rebuild reasons. This addresses concrete cache invalidation/selection gaps; a client log is still needed to identify the exact cause of a reported rebuild on a particular machine.

The in-memory cache also distinguishes requested precision. Tests cover fresh process reuse, concurrent cold preparation producing just one build, broader validated profile reuse, and rejection of incompatible GPU/ABI/precision/profile or corrupt engine contents. GPU inference remains stubbed in CPU transport CI; these are cache/transport checks rather than physical GPU throughput measurements.

Opening a new model build/import clears old progress and errors immediately. The preview pane remains when disabled, showing “Preview is disabled”; an open console fills that pane. Enabling preview restores the console's bottom drawer. Its width follows the preview pane and never covers the settings column.

Normal encoding edits regenerate the advanced argument baseline immediately. Entering Advanced starts from the current normal controls automatically, replacing an earlier advanced draft. Raw edits apply while Advanced is selected; returning to normal and reopening Advanced regenerates the baseline. Saved workflows already in Advanced retain their arguments when loaded.

## Processing outcomes and diagnosing slow models

FFmpeg now reports structured `-progress` blocks rather than parsing its human status line. The parser handles split/multiple blocks and final flush counts. Cancellation never emits a successful completion or fills in the planned frame count as if it had been encoded. Graceful cancellation can still leave a playable partial output; failed/cancelled source indexes are retained. A stale cancelled request cannot clear a newer render's UI state.

Each normal render records `[pipeline-settings]` and `[pipeline-summary]` in the main and item logs. Summaries distinguish planned frames, confirmed encoded frames, producer frames, elapsed time, and average pipeline FPS. Unknown counts remain null. Execution timing begins after the graph probe; indexing/build preflight has its separate startup timings. Producer timing measured while piped includes downstream backpressure; it is not an isolated inference benchmark. NVIDIA samples are device-wide on the first reported GPU, not per-process attribution. Missing telemetry stays null.

Before rendering, Vapourkit closes its in-app interactive preview processes and waits for actual process closure. Those sessions can otherwise retain a second model/stream allocation and compete with encoding for VRAM/compute. The encoding JPEG preview remains available according to its saved setting. Reopen interactive inspection/playback after rendering. A separately launched external vs-view window remains under the user's control; close it for a controlled benchmark. This removes a concrete contention risk without asserting a measured GPU speedup on hardware unavailable to CI.

Use `--compare-preview` with the exported benchmark bundle to run otherwise identical off/on preview cases. Reports now retain the bounded `vspipe --filter-time` table for each filter sample, including model and conversion nodes. These per-filter times can overlap and must not be added as sequential costs. Keep the model, input/output dimensions, precision, frame sample, requests and streams unchanged when comparing CPU/NVENC via `--encoder-args`. Complete samples rather than cancelling them midway. The four-stage benchmark, followed by these real-device measurements, is needed to establish a remaining model-specific bottleneck; a fast NVENC preset alone does not establish whole-workflow throughput.

## BestSource index ownership and cleanup

Managed source reads (frame counting, generated workflows, side-chain video loading and alignment) now direct BestSource indexes into `data/cache/bestsource/<source-hash>/`. They do not create new indexes next to source videos. Existing source-adjacent indexes are left untouched because ownership is unknown. A first run after moving to this cache can need indexing once.

Every Python reader holds an OS-backed lease, shared across script/preview/encode processes. Successful real encodes mark their sources for cleanup; cleanup waits for all reader leases and pending/processing queue references to release. Deferred cleanup retries periodically. OS locks release even after a reader is killed. A new render attempt supersedes an older completion marker, so its failure or cancellation retains the index for retry. Graph validation, preview alone and benchmark runs do not count as successful encodes.

Only known BestSource index files inside app-owned source directories are removed. Small coordination files/directories can remain. Cleanup is separate from TensorRT engine caches. Arbitrary user filter code that calls BestSource directly controls its own cache paths and is outside this ownership policy.

## Shared engine accuracy validation

For new RGB engine builds, the ONNX Runtime comparison receives the exact plane values supplied to TensorRT, including input precision rounding. Previously a newly converted FP16-input engine could receive rounded pixels while the FP32 ONNX reference received unrounded pixels. That compared different inputs and could falsely reject a correct engine. The common path covers supported image and channel-packed temporal RGB models.

Shape mismatch, non-finite output, and numerical mismatch are now distinct failures. Numerical reports include input/output shapes, engine I/O types, maximum/mean absolute error, fraction of elements outside tolerance, and the worst coordinate/values. The existing absolute 0.01 and relative 0.02 tolerances remain unchanged. Accuracy comparison remains at the first profile shape, while profile endpoints also receive finite-frame execution checks; these synthetic checks do not certify every possible input/model architecture.

A numerical mismatch can trigger one retry with TF32 disabled, only when TensorRT exposes that control and the model has FP32 input or weights. Graph FP16/BF16 types are preserved. Layout errors and NaN/Inf do not take this retry. An explicit no-TF32 build or a second mismatch stops. Failed candidates never replace a working engine. The sidecar records the final TF32 policy and attempt history, and compilation fallback caches distinguish that policy.

`<engine>.validation-report.json` records failed or recovered validation attempts. Build progress reaches 100% only after validation and publication. These checks repair a shared validation defect without certifying every model export. Existing validated engine caches are retained.
