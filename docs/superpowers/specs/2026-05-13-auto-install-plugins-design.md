# Auto-install Plugins at End of Setup

**Date:** 2026-05-13
**Status:** Approved for implementation

## Problem

After first-time dependency setup completes, the app shows a `PluginsModal` prompt asking the user to click "Install Plugins" to install PyTorch, vsjetpack, the bundled VapourSynth plugin archives, Selur's VS scripts, and filter templates. This is gated behind a `hasShownPluginPrompt` localStorage flag, fires only on the first successful setup, and requires a manual click. Without these plugins most filter workflows do not function, so the manual step is a friction point that strands new users who close the prompt without understanding it.

## Goal

Make plugin installation part of the unified `SetupScreen` flow so a first-time user sees one continuous progress experience and lands in a fully working app. Auto-retry once on plugin install failure. If the second attempt also fails, surface an inline error on `SetupScreen` with **Retry** and **Continue without plugins** options. The existing `PluginsModal` remains accessible from the menu for reinstall, uninstall, and post-decline installs.

## Non-goals

- No removal of `PluginsModal` — it stays as-is for menu-driven management.
- No "plugins not installed" warning banner in the main app for users who chose to continue without plugins.
- No refactor of pip flow, archive extraction, or script download logic inside `pluginInstaller.ts`.
- No persisted state tracking "user declined plugins this session" — next launch behaves like plugins-not-installed, matching existing baseline behavior.
- No progress UI for plugin install when triggered from the menu — that path keeps using `PluginsModal`'s existing `plugin-dependency-progress` channel.

## Architecture

### Two progress channels, one screen

The renderer already listens to two IPC channels:

- `setup-progress` — emitted by `dependencyManager` for the unified setup flow. Consumed by `useSetup.ts` and rendered on `SetupScreen`.
- `plugin-dependency-progress` — emitted by `pluginInstaller` when invoked from the plugins menu. Consumed by `PluginsModal`.

The plugin installer gains a second entry point that emits on `setup-progress` (with `component: 'Plugins'`) instead of `plugin-dependency-progress`. This keeps menu-driven plugin installs cleanly separated from setup-driven plugin installs.

### Components changing

**`electron/pluginInstaller.ts`**
- Refactor `sendProgress(...)` so the progress channel is chosen by an instance flag rather than hardcoded to `plugin-dependency-progress`.
- Add a public method `installDependenciesForSetup()` that:
  - Sets the instance flag to emit on `setup-progress` with `component: 'Plugins'`.
  - Calls the existing `installDependencies()` once. If it returns `{success: false}`, calls it a second time (pip cache makes the retry inexpensive). Returns the final `{success, error}` result.
  - Resets the flag before returning so subsequent menu-driven calls emit on the original channel.

**`electron/dependencyHandlers.ts`**
- The existing `setup-dependencies` handler currently awaits `dependencyManager.setupDependencies()` then `configManager.load()`. After config reload, additionally await `pluginInstaller.installDependenciesForSetup()`.
- On plugin install failure, return `{success: false, error}` from the handler. The `setup-progress` error event is already emitted by the installer.
- On success, emit `setup-progress { type: 'complete', component: 'All Dependencies', progress: 100, message: ... }` so the renderer's existing completion detection fires after both phases are done.

  Important: `dependencyManager.setupDependencies()` currently emits its own "All Dependencies complete" event at the end. That emission must move from `dependencyManager` to the handler (after plugins finish) so the renderer does not flip `isSetupComplete=true` between the two phases. The intermediate "core deps done" signal becomes a `setup-progress` event with `component: 'Plugins'` and `progress: 0` to indicate the next phase has started.

**`src/components/SetupScreen.tsx`**
- Append a step to `setupSteps`:
  ```ts
  { id: 'plugins', name: 'Plugins & Filters', description: 'PyTorch, vsjetpack, and bundled VapourSynth plugins', component: 'Plugins' }
  ```
- The existing `startsWith` matching in `stepStatuses` handles `component: 'Plugins'` automatically, rendering this step in progress while plugin install runs.
- Extend the error rendering: when `setupProgress.type === 'error'` AND `setupProgress.component.startsWith('Plugins')`, render two buttons inline near the existing error message:
  - **Retry plugins** — calls a new prop `onRetryPlugins`
  - **Continue without plugins** — calls a new prop `onContinueWithoutPlugins`
- For non-plugin setup errors, keep the existing error display unchanged (no retry button — those are fatal as today).

**`src/hooks/useSetup.ts`**
- Delete `showPluginPrompt` state, `setShowPluginPrompt`, and the `hasShownPluginPrompt` localStorage read/write/preservation logic.
- Add `pluginInstallError: string | null` state, set when `setupProgress.type === 'error'` AND `component.startsWith('Plugins')`.
- Add `handleRetryPlugins()` — calls a new IPC `retry-setup-plugins` (registered alongside the existing plugin handlers) that invokes `pluginInstaller.installDependenciesForSetup()` again. Progress flows through the same `setup-progress` channel and updates `setupProgress` state, so `SetupScreen` continues to render correctly during retry without any channel-coupling logic on the renderer side. Each user-initiated retry gets two install attempts (the installer's internal auto-retry runs again).
- Add `handleContinueWithoutPlugins()` — sets `isSetupComplete=true` and `pluginInstallError=null` directly.
- Return all three new fields from the hook.

**`src/App.tsx`**
- Remove `showPluginPrompt` and `setShowPluginPrompt` from the `useSetup` destructure.
- Pass the new `pluginInstallError`, `handleRetryPlugins`, and `handleContinueWithoutPlugins` to `SetupScreen`.
- Remove `showPluginPrompt={showPluginPrompt}` from `<AppModals>` and drop `setShowPluginPrompt(false)` from `onClosePlugins`.

**`src/components/AppModals.tsx`**
- Remove `showPluginPrompt: boolean` from `AppModalsProps`.
- Change `<PluginsModal show={props.showPlugins || props.showPluginPrompt}` to `show={props.showPlugins}`.

**`src/components/PluginsModal.tsx`** — no changes.

## Data flow

```
User clicks "Start Setup"
  ↓
setup-dependencies IPC handler runs:
  ↓
  dependencyManager.setupDependencies()
    → emits setup-progress for VapourSynth R72, BestSource R13,
      Video Compare Tool, vs-mlrt ONNX (and TensorRT if CUDA),
      Python Embedded, ONNX Models, FFmpeg
  ↓
  configManager.load()
  ↓
  pluginInstaller.installDependenciesForSetup()
    → emits setup-progress with component='Plugins' for the full
      pip + extract + scripts flow
    → on first failure: auto-retry once
    → on second failure: emits setup-progress { type: 'error', component: 'Plugins' }
       and returns {success: false}
  ↓
  On full success: emits setup-progress { type: 'complete',
                                          component: 'All Dependencies' }
  ↓
useSetup flips isSetupComplete=true → SetupScreen unmounts → main app renders
```

On plugin error after auto-retry:
- `SetupScreen` shows error message inline with `[Retry plugins] [Continue without plugins]`.
- **Retry plugins** → calls the plugin-install path again; `SetupScreen` stays mounted, progress continues to update via `setup-progress`. Another failure shows the error again.
- **Continue without plugins** → renderer sets `isSetupComplete=true`; main app renders; plugin menu remains available.

## Error handling

- **Core dependency failures** (VapourSynth, vs-mlrt, Python, models, ffmpeg): unchanged — the existing fatal error rendering applies.
- **Plugin install failures**: retry-once at the installer level is silent (no UI banner during the retry). After the second failure, `SetupScreen` shows the error with the two recovery buttons. The auto-retry uses no backoff — pip cache makes the second attempt fast.
- **Cancellation during setup**: the plugin installer's `cancel()` method exists for menu-driven cancellation. During setup-mode install, cancellation is not exposed in UI — the user waits, retries, or chooses "Continue without plugins" on failure. This matches existing setup behavior, which has no cancel button.

## Testing

- Unit tests exist for `errorMessageHandler` and config utilities; nothing in this change benefits from new unit tests at that layer.
- Manual verification scenarios:
  1. **Happy path, fresh install:** delete app data, run app, complete setup, verify the Plugins step appears last in `SetupScreen`, completes, app enters main UI with plugins working.
  2. **Plugin install transient failure:** disconnect network mid-PyTorch download once, reconnect; verify auto-retry succeeds and user sees no error UI.
  3. **Plugin install hard failure:** simulate persistent failure (e.g., invalid index URL); verify SetupScreen shows error with Retry + Continue buttons after the second attempt.
  4. **Continue without plugins:** click "Continue without plugins" on the error state; verify main app enters, plugins menu opens correctly, manual install from menu still works.
  5. **Retry from setup error:** click "Retry plugins"; verify progress bar resumes, success path completes setup.
  6. **Existing setup, no first-time prompt:** delete plugins only (not core deps); verify no auto-prompt on next launch (since `checkDependencies` says core deps are present and setup is skipped). User installs from menu via `PluginsModal` as today.
  7. **Reinstall / uninstall from menu:** open plugins menu post-setup; verify Reinstall and Uninstall buttons still work, progress renders in `PluginsModal` as today.

## Migration notes

- The `hasShownPluginPrompt` localStorage key is no longer read or written. Users who previously saw the prompt (key already set) are unaffected — the key just becomes dead.
- Users mid-upgrade who already have core deps installed but not plugins will not see the new flow on next launch (their setup screen does not appear). They use the existing plugin menu, unchanged.
- No state migration is required.
