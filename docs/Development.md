### Prerequisites
- Node.js 18+
- npm or yarn

For the provider architecture and the checklist for adding an inference
runtime, see [Inference Backends](Inference%20Backends.md).

### Setup
```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build application
npm run build

# Build installer (Windows)
npm run build:setup

# Build portable 7z
npm run build:7z

# Build portable zip
npm run build:zip
```

### Runtime engine builds (the `[vk-build]` protocol)

Some filters build a TensorRT engine the first time they run — vs-mlrt's
`Backend.TRT` does, and so does `vs_temporalfix`. The build happens *inside*
vspipe, takes several minutes, and produces no output the app understands, so
the UI looks frozen. Users assume a crash, force-close, and a half-written
engine can then be picked up as a cache hit and break the filter permanently.

Vapourkit parses a small status protocol off vspipe's stderr. Any tool running
inside vspipe can emit it — three line shapes, each on its own line:

```
[vk-build] begin <human-readable label>
[vk-build] progress <integer 0-100>     (optional, repeatable)
[vk-build] end <label>
```

The marker may appear anywhere in the line, so existing log prefixes are fine.
What the app does with them:

- `begin` — shows a persistent banner naming the label, explaining that this is
  the first run at this resolution and can take minutes;
- `progress` — fills in a percentage (with no `progress` lines the banner just
  spins);
- `end`, or the process exiting/being cancelled for any reason — clears the
  banner. Builds are also written to the per-item queue log.

Emitting tools should write their engine atomically: build to `<path>.tmp` and
rename it into place, so a killed build leaves no truncated engine at the final
path where it would be reused as a cache hit. Vapourkit's own builder
(`include/build_trt_engine.py`) does both — it is the reference implementation,
and vs-mlrt's runtime builds go through it via the trtexec shim
(`electron/trtexecShim.ts`), so they get the banner for free.

Third-party filters opt in with a few `print(..., flush=True)` calls to stderr;
until then they build silently, which is exactly the situation this replaces.

As a stopgap, `KNOWN_BUILD_ANNOUNCEMENTS` in `engineBuildProtocol.ts` maps a
short list of filters' *existing* log lines onto the same events —
`vs_temporalfix` is there, since it builds per-resolution engines with the
TensorRT Python API and already logs "Building new TensorRT engine for
strength=… width=… height=…" / "Engine building complete." (Python logging,
which VapourSynth forwards to vspipe's stderr with a `Warning: ` prefix). Those
entries carry no progress, so the banner spins instead of filling a bar. Keep
that table to exact vendor strings — a false positive raises a banner nothing
will take down short of the process exiting — and delete an entry once its
filter emits `[vk-build]` itself.

Parsing lives in `electron/engineBuildProtocol.ts` (pure, unit-tested) and is
fed from the vspipe stderr handlers in `electron/vapourSynthInfoExtractor.ts`
and `electron/upscaleExecutor.ts`.
