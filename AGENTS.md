# AGENTS.md — Vapourkit

## What this is
Electron + React + Vite + TypeScript GUI for VapourSynth video upscaling. Frontend in `src/`, main process in `electron/`. Bundled with Windows-specific native dependencies (TensorRT, DirectML, FFmpeg, VapourSynth).

## Exact build & test commands

| Goal | Command |
|------|---------|
| Full dev (Vite + Electron) | `npm run dev` |
| Build renderer only | `vite build` |
| Build main process only | `npm run build:electron` (`tsc -p tsconfig.electron.json`) |
| Build everything | `npm run build` (`tsc && vite build && npm run build:electron`) |
| Frontend unit tests | `npm test` (`vitest run`, covers `src/**/*.test.ts`) |
| Main-process unit tests | `npm run test:electron` (`vitest run -c vitest.config.electron.ts`, covers `electron/**/*.test.ts`) |
| Single test file | `npx vitest run src/utils/foo.test.ts` |
| Package installer (Windows) | `npm run build:setup` |
| Portable 7z | `npm run build:7z` |

**Important**: `npm run build` runs `tsc` first (renderer typecheck, no emit), then `vite build`, then electron compilation. If renderer TS fails, electron never compiles.

## TypeScript boundaries

- `tsconfig.json` — renderer only (`"include": ["src"]`), `noEmit: true`, `allowImportingTsExtensions: true`, strict with `noUnusedLocals` and `noUnusedParameters`. Dead imports **will** fail the build.
- `tsconfig.electron.json` — main process only (`"include": ["electron/**/*"]`), CommonJS output to `dist/electron`.
- `tsconfig.node.json` — Vite config only.

Never change `tsconfig.json` include/exclude without checking that both `tsc` and `vite build` still pass.

## Electron architecture

- Entry: `electron/main.ts` **must import `./asarFix` first** (fixes `7zip-bin` paths before any module loads `7zip-min`).
- IPC contract: `src/electron.d.ts` defines the API surface. `electron/preload.ts` exposes it. `electron/ipcRegistry.ts` wires handlers. If you add IPC methods, update all three.
- When packaged, `userData` is forced to a portable folder next to the executable (`data/user-data`).
- Custom `video://` protocol is registered in `main.ts` for local video playback; query strings are stripped for cache busting.

## Frontend architecture

- React entry: `src/main.tsx`. Root component: `src/App.tsx`.
- `App.tsx` is an orchestrator — it composes ~15 custom hooks from `src/hooks/`. Business logic lives in hooks, not components.
- `src/electron.d.ts` also contains shared types (`VideoInfo`, `Filter`, `QueueItem`, `WorkflowData`, etc.) consumed by both frontend and Electron.

## Testing conventions

- Both test configs use `environment: 'node'`.
- Mock file-I/O modules (e.g. `vi.mock('./logger', ...)`) to avoid side effects in unit tests.
- Example patterns in `electron/errorMessageHandler.test.ts` and `src/utils/generateOutputSuffix.test.ts`.

## Code style & constraints

- No ESLint/Prettier config is present. Follow existing patterns.
- Renderer TS is strict: unused variables/parameters fail compilation.
- Keep hook signatures stable — `App.tsx` passes many props; signature changes require updates there and in related hooks.

## Directory ownership

| Directory | Purpose |
|-----------|---------|
| `src/` | React frontend, hooks, components, utilities |
| `electron/` | Main process, IPC handlers, native orchestration |
| `include/` | Bundled native assets (models, plugins, scripts, templates) |
| `scripts/` | Build-time TS scripts (rename portable, update docs) |
| `dist/` | Build output (`dist/renderer` from Vite, `dist/electron` from tsc) |
| `release/` | Electron-builder output |

## Gotchas

- The `build` block in `package.json` controls Electron-builder packaging. The `asarUnpack` list must include anything that needs to be accessed outside the ASAR (native binaries, 7z archives, ONNX models).
- Vite dev server watches `src/` but ignores `data/`, `data2/`, and `release/`.
- `__APP_VERSION__` is injected at build time from `package.json`.
- There are no pre-commit hooks or CI workflows in this repo.
