# Auto-install Plugins at End of Setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the post-setup "click to install plugins" prompt with an automatic plugin install that runs as the final step of the unified `SetupScreen` flow, with auto-retry-once and a Retry / Continue-without-plugins recovery flow on hard failure.

**Architecture:** The plugin installer gains a setup-mode entry point that emits on the existing `setup-progress` IPC channel (with `component: 'Plugins'`) so the renderer sees one continuous progress stream. The `setup-dependencies` handler chains plugin install after core dep setup. The "All Dependencies complete" emission moves to the handler so it only fires after both phases finish. SetupScreen renders a new step and a plugin-specific error branch with two recovery buttons. `PluginsModal` stays unchanged for menu access.

**Tech Stack:** Electron (main + preload + renderer), TypeScript, React, IPC channels (`setup-progress`, `plugin-dependency-progress`, new `retry-setup-plugins`).

**Spec:** [docs/superpowers/specs/2026-05-13-auto-install-plugins-design.md](../specs/2026-05-13-auto-install-plugins-design.md)

---

## File Structure

**Modified files** (no new files):
- `electron/pluginInstaller.ts` — add channel-flag-based `sendProgress`, add `installDependenciesForSetup()` method with auto-retry-once.
- `electron/dependencyManager.ts` — remove the trailing "All Dependencies → complete" emission (moves to the handler).
- `electron/dependencyHandlers.ts` — chain plugin install after core setup; register new `retry-setup-plugins` IPC handler; emit final completion event.
- `electron/preload.ts` — expose `retrySetupPlugins` on `window.electronAPI`.
- `src/electron.d.ts` — declare `retrySetupPlugins` on `ElectronAPI`; extend `SetupProgress` type to include `'installing'`.
- `src/components/SetupScreen.tsx` — add `'plugins'` step, plugin-specific error branch with two buttons, new props.
- `src/hooks/useSetup.ts` — delete `showPluginPrompt` and `hasShownPluginPrompt`; add `pluginInstallError`, `handleRetryPlugins`, `handleContinueWithoutPlugins`.
- `src/App.tsx` — drop `showPluginPrompt` plumbing; wire new SetupScreen props.
- `src/components/AppModals.tsx` — drop `showPluginPrompt` prop.

There are no automated tests for the renderer setup flow or for the IPC plugin handlers in this repo; the existing test suite (`*.test.ts`) covers `errorMessageHandler`, `ffmpegConfig`, and `modelUtils` only. This plan does not add new automated tests — the change is wiring/UI-flow oriented and verification is manual per the spec's testing section. Each task ends with a build/typecheck step and a commit.

---

## Task 1: Extend SetupProgress type and add `retrySetupPlugins` to the preload surface

**Files:**
- Modify: `src/electron.d.ts:5-6,183-184,221-226`
- Modify: `electron/preload.ts:177-185`

- [ ] **Step 1: Add `'installing'` to the `SetupProgress.type` union and declare `retrySetupPlugins` on `ElectronAPI`**

In `src/electron.d.ts`, find the `SetupProgress` interface around line 221 and extend the union:

```ts
export interface SetupProgress {
  type: 'download' | 'extract' | 'installing' | 'complete' | 'error' | 'model-extract';
  component: string;
  progress: number;
  message: string;
}
```

Then add the new IPC method to the `ElectronAPI` interface near the existing plugin dependency entries (around line 183):

```ts
  installPluginDependencies: () => Promise<{ success: boolean; error?: string }>;
  retrySetupPlugins: () => Promise<{ success: boolean; error?: string }>;
  uninstallPluginDependencies: () => Promise<{ success: boolean; error?: string }>;
```

- [ ] **Step 2: Expose `retrySetupPlugins` on the preload bridge**

In `electron/preload.ts`, after line 177 (`installPluginDependencies`), add:

```ts
  installPluginDependencies: () => ipcRenderer.invoke('install-plugin-dependencies'),
  retrySetupPlugins: () => ipcRenderer.invoke('retry-setup-plugins'),
  uninstallPluginDependencies: () => ipcRenderer.invoke('uninstall-plugin-dependencies'),
```

- [ ] **Step 3: Typecheck**

Run: `npm run build` (or `npx tsc --noEmit` if a faster typecheck script is preferred)
Expected: PASS — no new TypeScript errors. The handler for `retry-setup-plugins` does not exist yet but TypeScript does not check IPC channel string literals.

- [ ] **Step 4: Commit**

```bash
git add src/electron.d.ts electron/preload.ts
git commit -m "Add retrySetupPlugins IPC and 'installing' SetupProgress variant"
```

---

## Task 2: Refactor `pluginInstaller.sendProgress` to support a channel flag

**Files:**
- Modify: `electron/pluginInstaller.ts:13-32`

- [ ] **Step 1: Add a `useSetupChannel` instance flag and route `sendProgress` accordingly**

In `electron/pluginInstaller.ts`, change the class fields and `sendProgress` (lines 13–32). The existing `PluginDependencyProgress` type stays for menu-mode emissions; setup-mode emissions are shaped as `SetupProgress`. Replace the class definition's top section:

```ts
export interface PluginDependencyProgress {
  type: 'installing' | 'complete' | 'error';
  progress: number;
  message: string;
}

interface SetupProgressEvent {
  type: 'installing' | 'complete' | 'error';
  component: string;
  progress: number;
  message: string;
}

export class PluginInstaller {
  private mainWindow: BrowserWindow | null;
  private installProcess: ChildProcess | null = null;
  private isCancelled: boolean = false;
  private useSetupChannel: boolean = false;

  constructor(mainWindow: BrowserWindow | null = null) {
    this.mainWindow = mainWindow;
  }

  private sendProgress(progress: PluginDependencyProgress) {
    if (!this.mainWindow) return;
    if (this.useSetupChannel) {
      const setupEvent: SetupProgressEvent = {
        type: progress.type,
        component: 'Plugins',
        progress: progress.progress,
        message: progress.message,
      };
      this.mainWindow.webContents.send('setup-progress', setupEvent);
    } else {
      this.mainWindow.webContents.send('plugin-dependency-progress', progress);
    }
  }
```

Leave every other method (`runPipInstall`, `installDependencies`, `extractAllPlugins`, etc.) unchanged — they all funnel through `sendProgress`, so the channel switch propagates automatically.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS — pure refactor, no callers changed yet.

- [ ] **Step 3: Commit**

```bash
git add electron/pluginInstaller.ts
git commit -m "Route pluginInstaller progress through setup-progress when in setup mode"
```

---

## Task 3: Add `installDependenciesForSetup()` with auto-retry-once

**Files:**
- Modify: `electron/pluginInstaller.ts` (append a new public method after `installDependencies`)

- [ ] **Step 1: Add the new method**

In `electron/pluginInstaller.ts`, after the closing `}` of `installDependencies()` (around line 350) and before `async checkInstalled()`, add:

```ts
  async installDependenciesForSetup(): Promise<{ success: boolean; error?: string }> {
    this.useSetupChannel = true;
    try {
      logger.info('Starting plugin dependency installation (setup mode, attempt 1/2)');
      const firstResult = await this.installDependencies();
      if (firstResult.success) {
        return firstResult;
      }

      if (this.isCancelled) {
        return firstResult;
      }

      logger.info(`Plugin install attempt 1 failed (${firstResult.error}); retrying once`);
      this.isCancelled = false;
      const secondResult = await this.installDependencies();
      if (!secondResult.success) {
        logger.error(`Plugin install retry failed: ${secondResult.error}`);
      }
      return secondResult;
    } finally {
      this.useSetupChannel = false;
    }
  }
```

Note: `installDependencies()` already emits a `setup-progress { type: 'error', ... }` event (with `component: 'Plugins'`) on failure because `sendProgress` is routed through the setup channel while `useSetupChannel` is true. No additional error emission is needed here.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/pluginInstaller.ts
git commit -m "Add installDependenciesForSetup with auto-retry-once"
```

---

## Task 4: Move "All Dependencies → complete" emission out of `dependencyManager`

**Files:**
- Modify: `electron/dependencyManager.ts:552-567`

- [ ] **Step 1: Remove the trailing complete emission**

In `electron/dependencyManager.ts`, find the block ending around line 567 and delete the `sendProgress({ type: 'complete', component: 'All Dependencies', ... })` call. The `logger` and `initializeUserConfig` calls stay. The result:

```ts
      // NOTE: Plugin extraction has been moved to the manual "Install Plugins" button
      // in the Plugins modal. This allows users to install plugins on-demand rather
      // than during initial setup.
      
      // Initialize user config files
      await this.initializeUserConfig();

      logger.dependency('All dependencies setup completed successfully');
      logger.separator();

    } catch (error) {
```

Also update the obsolete `NOTE` comment in the same region — replace those three comment lines with:

```ts
      // Plugin install runs after this method returns, orchestrated by the
      // setup-dependencies IPC handler. The final 'All Dependencies complete'
      // event is emitted from the handler once plugins finish.
      
      // Initialize user config files
      await this.initializeUserConfig();
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS. The renderer will temporarily stop receiving the complete event until Task 5 lands — that's expected and the next task fixes it.

- [ ] **Step 3: Commit**

```bash
git add electron/dependencyManager.ts
git commit -m "Move 'All Dependencies complete' emission out of dependencyManager"
```

---

## Task 5: Chain plugin install in `setup-dependencies` and register `retry-setup-plugins`

**Files:**
- Modify: `electron/dependencyHandlers.ts:40-65`

- [ ] **Step 1: Update the `setup-dependencies` handler to run plugin install and emit the final complete event**

In `electron/dependencyHandlers.ts`, replace the existing `setup-dependencies` handler (lines 40–52) with:

```ts
  ipcMain.handle('setup-dependencies',
    createIpcHandler(
      'setup-dependencies',
      async () => {
        await dependencyManager.setupDependencies();
        // Reload config after setup to get the stock config with model metadata
        await configManager.load();
        logger.info('Config reloaded after core setup');

        // Auto-install plugins as the final phase of unified setup.
        logger.info('Starting plugin install phase of unified setup');
        const pluginResult = await pluginInstaller.installDependenciesForSetup();
        if (!pluginResult.success) {
          logger.error(`Plugin install failed during setup: ${pluginResult.error}`);
          // pluginInstaller already emitted a setup-progress error event with
          // component='Plugins'. Return failure so the renderer can show recovery UI.
          return { success: false, error: pluginResult.error };
        }

        // Reload config again so any plugin-extracted templates/filters are picked up.
        await configManager.load();

        // Final unified setup completion event — fires only after BOTH phases succeed.
        if (mainWindowRef()) {
          mainWindowRef()!.webContents.send('setup-progress', {
            type: 'complete',
            component: 'All Dependencies',
            progress: 100,
            message: 'All dependencies and plugins installed successfully!',
          });
        }
        return { success: true };
      },
      { useLogSeparator: true }
    )
  );
```

There is no existing `mainWindowRef()` helper — use whatever the file already has. Check what pattern the handler should use: `pluginInstaller` is passed into `registerDependencyHandlers`, and `pluginInstaller` already holds a `mainWindow` reference internally. The cleanest approach is to ask the installer to send the final event. Replace the block:

```ts
        // Final unified setup completion event — fires only after BOTH phases succeed.
        if (mainWindowRef()) {
          mainWindowRef()!.webContents.send('setup-progress', {
            type: 'complete',
            component: 'All Dependencies',
            progress: 100,
            message: 'All dependencies and plugins installed successfully!',
          });
        }
```

with a call to a new tiny helper on the installer. Add to `electron/pluginInstaller.ts` (next to `cancel()`):

```ts
  emitSetupComplete(): void {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('setup-progress', {
        type: 'complete',
        component: 'All Dependencies',
        progress: 100,
        message: 'All dependencies and plugins installed successfully!',
      });
    }
  }
```

Then in `electron/dependencyHandlers.ts` the success branch becomes:

```ts
        // Final unified setup completion event — fires only after BOTH phases succeed.
        pluginInstaller.emitSetupComplete();
        return { success: true };
```

- [ ] **Step 2: Register the `retry-setup-plugins` IPC handler**

In the same file, after the existing `cancel-plugin-dependency-install` handler (around line 95), add:

```ts
  ipcMain.handle('retry-setup-plugins', async () => {
    logger.info('User-initiated retry of plugin install (setup mode)');
    try {
      const result = await pluginInstaller.installDependenciesForSetup();
      if (result.success) {
        await configManager.load();
        pluginInstaller.emitSetupComplete();
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error retrying plugin install:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/pluginInstaller.ts electron/dependencyHandlers.ts
git commit -m "Chain plugin install into setup flow and add retry-setup-plugins IPC"
```

---

## Task 6: Add 'plugins' step and error-recovery UI to `SetupScreen`

**Files:**
- Modify: `src/components/SetupScreen.tsx:6-13, 26-50, 161-171, 213-220`

- [ ] **Step 1: Extend the props interface with three new fields**

In `src/components/SetupScreen.tsx`, update `SetupScreenProps`:

```ts
interface SetupScreenProps {
  isCheckingDeps: boolean;
  isSetupComplete: boolean;
  hasCudaSupport: boolean | null;
  setupProgress: SetupProgress | null;
  isSettingUp: boolean;
  onSetup: () => Promise<void>;
  pluginInstallError: string | null;
  onRetryPlugins: () => Promise<void>;
  onContinueWithoutPlugins: () => void;
}
```

And destructure the new props in the component signature:

```ts
export const SetupScreen = memo<SetupScreenProps>(({
  isCheckingDeps,
  isSetupComplete,
  hasCudaSupport,
  setupProgress,
  isSettingUp,
  onSetup,
  pluginInstallError,
  onRetryPlugins,
  onContinueWithoutPlugins,
}: SetupScreenProps) => {
```

- [ ] **Step 2: Append the 'plugins' step to `setupSteps`**

Inside the `useMemo` block (after the `ffmpeg` push around line 47), add `plugins` as the last step:

```ts
    steps.push(
      { id: 'python', name: 'Python Embedded', description: 'Python runtime for VapourSynth', component: 'Python Embedded' },
      { id: 'models', name: 'ONNX Models', description: 'Bundled AI upscaling models', component: 'ONNX Models' },
      { id: 'ffmpeg', name: 'FFmpeg', description: 'Video encoding/decoding', component: 'FFmpeg' },
      { id: 'plugins', name: 'Plugins & Filters', description: 'PyTorch, vsjetpack, and bundled VapourSynth plugins', component: 'Plugins' }
    );

    return steps;
  }, [hasCudaSupport]);
```

- [ ] **Step 3: Add a Download icon color branch for the plugins step**

In the Download icon class list around line 161–171, add a `'plugins'` case:

```tsx
                      <Download className={`w-5 h-5 flex-shrink-0 ${
                        step.id === 'vapoursynth' ? 'text-primary-blue' :
                        step.id === 'tensorrt' ? 'text-primary-purple' :
                        step.id === 'onnx' ? 'text-accent-cyan' :
                        step.id === 'bestsource' ? 'text-green-400' :
                        step.id === 'video-compare' ? 'text-yellow-400' :
                        step.id === 'python' ? 'text-orange-400' :
                        step.id === 'models' ? 'text-pink-400' :
                        step.id === 'ffmpeg' ? 'text-blue-400' :
                        step.id === 'plugins' ? 'text-primary-purple' :
                        'text-gray-400'
                      }`} />
```

- [ ] **Step 4: Replace the existing error message block with a branch for plugin-specific errors**

Find the existing error message block around line 213:

```tsx
            {/* Error Message */}
            {setupProgress?.type === 'error' && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-red-400 text-sm flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  {setupProgress.message}
                </p>
              </div>
            )}
```

Replace it with:

```tsx
            {/* Error Message */}
            {setupProgress?.type === 'error' && !pluginInstallError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                <p className="text-red-400 text-sm flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  {setupProgress.message}
                </p>
              </div>
            )}

            {/* Plugin install error with recovery options */}
            {pluginInstallError && (
              <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg space-y-3">
                <p className="text-red-400 text-sm flex items-center gap-2">
                  <XCircle className="w-4 h-4 flex-shrink-0" />
                  Plugin install failed: {pluginInstallError}
                </p>
                <p className="text-gray-400 text-xs">
                  You can retry now, or continue without plugins and install them later from the Plugins menu.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={onRetryPlugins}
                    disabled={isSettingUp}
                    className="flex-1 bg-gradient-to-r from-primary-blue to-primary-purple hover:from-blue-600 hover:to-purple-600 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium py-2 px-4 rounded-lg transition-all duration-200"
                  >
                    Retry plugins
                  </button>
                  <button
                    onClick={onContinueWithoutPlugins}
                    disabled={isSettingUp}
                    className="flex-1 bg-dark-surface hover:bg-gray-700 disabled:bg-dark-surface disabled:cursor-not-allowed text-gray-200 text-sm font-medium py-2 px-4 rounded-lg transition-colors"
                  >
                    Continue without plugins
                  </button>
                </div>
              </div>
            )}
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS — `pluginInstallError`, `onRetryPlugins`, `onContinueWithoutPlugins` are required props now; the caller in App.tsx will be updated in Task 8, so typecheck will currently FAIL on the App.tsx call site. That is expected — proceed to Task 7. If you want a clean typecheck per task, swap the order of Task 7 and Task 8 below — both must land together to compile.

- [ ] **Step 6: Commit**

```bash
git add src/components/SetupScreen.tsx
git commit -m "Add plugins step and plugin-error recovery UI to SetupScreen"
```

---

## Task 7: Update `useSetup` — remove prompt state, add plugin error/retry/continue

**Files:**
- Modify: `src/hooks/useSetup.ts` (full rewrite of state and effects)

- [ ] **Step 1: Replace the hook body**

Replace the entire contents of `src/hooks/useSetup.ts` with:

```ts
import { useState, useEffect, useCallback } from 'react';
import type { SetupProgress } from '../electron.d';
import { getErrorMessage } from '../types/errors';

export function useSetup(onLog: (message: string) => void) {
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isCheckingDeps, setIsCheckingDeps] = useState(true);
  const [hasCudaSupport, setHasCudaSupport] = useState<boolean | null>(null);
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [pluginInstallError, setPluginInstallError] = useState<string | null>(null);

  // Setup progress listener
  useEffect(() => {
    const unsubscribe = window.electronAPI.onSetupProgress((progress: SetupProgress) => {
      setSetupProgress(progress);
      onLog(`[Setup] ${progress.message} (${progress.progress}%)`);

      if (progress.type === 'error' && progress.component.startsWith('Plugins')) {
        // Plugin install error after the installer's internal auto-retry.
        // Keep isSettingUp false so the recovery buttons are enabled; surface
        // the error in dedicated state so SetupScreen renders the recovery UI.
        setPluginInstallError(progress.message);
        setIsSettingUp(false);
        return;
      }

      if (progress.type === 'complete' && progress.component === 'All Dependencies') {
        setIsSetupComplete(true);
        setIsSettingUp(false);
        setPluginInstallError(null);
      }
    });

    return unsubscribe;
  }, [onLog]);

  const checkDependencies = useCallback(async (): Promise<void> => {
    setIsCheckingDeps(true);
    try {
      const cudaSupport = await window.electronAPI.detectCudaSupport();
      setHasCudaSupport(cudaSupport);
      onLog(`CUDA support: ${cudaSupport ? 'detected' : 'not detected'}`);

      const isComplete = await window.electronAPI.checkDependencies();
      setIsSetupComplete(isComplete);
      if (!isComplete) {
        onLog('Dependencies not found - setup required');
      } else {
        onLog('All dependencies present');
      }
    } catch (error) {
      onLog(`Error checking dependencies: ${getErrorMessage(error)}`);
    } finally {
      setIsCheckingDeps(false);
    }
  }, [onLog]);

  const handleSetup = async (): Promise<void> => {
    setIsSettingUp(true);
    setPluginInstallError(null);

    // Clear localStorage to prevent persistence issues from previous installations.
    onLog('Clearing previous application data...');
    localStorage.clear();

    onLog('Starting dependency setup...');
    await window.electronAPI.setupDependencies();
  };

  const handleRetryPlugins = useCallback(async (): Promise<void> => {
    setIsSettingUp(true);
    setPluginInstallError(null);
    onLog('Retrying plugin install...');
    await window.electronAPI.retrySetupPlugins();
  }, [onLog]);

  const handleContinueWithoutPlugins = useCallback((): void => {
    onLog('User chose to continue without plugins - entering main app');
    setPluginInstallError(null);
    setIsSettingUp(false);
    setIsSetupComplete(true);
  }, [onLog]);

  // Check dependencies on mount
  useEffect(() => {
    checkDependencies();
  }, [checkDependencies]);

  return {
    isSetupComplete,
    isCheckingDeps,
    hasCudaSupport,
    setupProgress,
    isSettingUp,
    handleSetup,
    pluginInstallError,
    handleRetryPlugins,
    handleContinueWithoutPlugins,
  };
}
```

Notes on what changed:
- Removed `showPluginPrompt`, `setShowPluginPrompt`, and `hasShownPluginPrompt` localStorage logic — plugin install now happens automatically inside the setup flow.
- `handleSetup` no longer preserves the deleted `hasShownPluginPrompt` key.
- Added `pluginInstallError`, `handleRetryPlugins`, `handleContinueWithoutPlugins`.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: FAIL — App.tsx still destructures `showPluginPrompt`/`setShowPluginPrompt`. Fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSetup.ts
git commit -m "Remove plugin prompt state from useSetup; add plugin error recovery"
```

---

## Task 8: Wire new SetupScreen props and remove `showPluginPrompt` plumbing in `App.tsx` and `AppModals`

**Files:**
- Modify: `src/App.tsx:67, 654-664, 943-945`
- Modify: `src/components/AppModals.tsx:60-63, 135-139`

- [ ] **Step 1: Update the `useSetup` destructure in `App.tsx`**

Find around line 67:

```ts
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, setupProgress, isSettingUp, handleSetup, showPluginPrompt, setShowPluginPrompt } = useSetup(addConsoleLog);
```

Replace with:

```ts
  const { isSetupComplete, isCheckingDeps, hasCudaSupport, setupProgress, isSettingUp, handleSetup, pluginInstallError, handleRetryPlugins, handleContinueWithoutPlugins } = useSetup(addConsoleLog);
```

- [ ] **Step 2: Pass the new props to `SetupScreen`**

Find around line 654:

```tsx
  if (isCheckingDeps || !isSetupComplete) {
    return (
      <SetupScreen
        isCheckingDeps={isCheckingDeps}
        isSetupComplete={isSetupComplete}
        hasCudaSupport={hasCudaSupport}
        setupProgress={setupProgress}
        isSettingUp={isSettingUp}
        onSetup={handleSetup}
      />
    );
  }
```

Replace with:

```tsx
  if (isCheckingDeps || !isSetupComplete) {
    return (
      <SetupScreen
        isCheckingDeps={isCheckingDeps}
        isSetupComplete={isSetupComplete}
        hasCudaSupport={hasCudaSupport}
        setupProgress={setupProgress}
        isSettingUp={isSettingUp}
        onSetup={handleSetup}
        pluginInstallError={pluginInstallError}
        onRetryPlugins={handleRetryPlugins}
        onContinueWithoutPlugins={handleContinueWithoutPlugins}
      />
    );
  }
```

- [ ] **Step 3: Drop `showPluginPrompt` from the `AppModals` invocation**

Find around line 943:

```tsx
        showPlugins={showPlugins}
        showPluginPrompt={showPluginPrompt}
        onClosePlugins={() => closeModalWithFocusRestore(() => { setShowPlugins(false); setShowPluginPrompt(false); })}
```

Replace with:

```tsx
        showPlugins={showPlugins}
        onClosePlugins={() => closeModalWithFocusRestore(() => setShowPlugins(false))}
```

- [ ] **Step 4: Drop `showPluginPrompt` from `AppModals` interface and PluginsModal call**

In `src/components/AppModals.tsx`, remove the `showPluginPrompt: boolean;` line from the `Plugins` block of `AppModalsProps` (around line 61):

```ts
  // Plugins
  showPlugins: boolean;
  onClosePlugins: () => void;
  onInstallationComplete: () => void;
```

And change the PluginsModal usage around line 135:

```tsx
      <PluginsModal
        show={props.showPlugins}
        onClose={props.onClosePlugins}
        onInstallationComplete={props.onInstallationComplete}
      />
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS — all callers are now aligned.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/AppModals.tsx
git commit -m "Wire SetupScreen plugin recovery props; drop showPluginPrompt plumbing"
```

---

## Task 9: Manual verification

This task is checklist-only — no code changes. Run through each scenario from the spec's "Testing" section against a built dev binary. Mark each box only after you observe the behavior.

- [ ] **1. Happy path, fresh install**

Steps:
1. Delete or rename the app data folder so the app sees a fresh state.
2. Launch the dev app: `npm run dev` (or whatever the local equivalent is — check `package.json`).
3. Click **Start Setup** on SetupScreen.
4. Watch the progress through all components, ending with the new **Plugins & Filters** step.
5. App enters main UI.

Expected: One continuous progress flow; Plugins step appears last, runs to 100%, main app loads; PluginsModal opened from the menu shows "Plugins are installed".

- [ ] **2. Plugin install transient failure (auto-retry succeeds)**

Steps:
1. Fresh state.
2. Start setup; wait until the Plugins step starts (PyTorch download begins).
3. Briefly disconnect network, then reconnect within a few seconds.
4. Watch the installer retry internally.

Expected: User sees no error UI. The plugin step continues (possibly restarts pip from the beginning, hitting pip cache for already-downloaded files), and setup completes normally.

- [ ] **3. Plugin install hard failure**

Steps:
1. Fresh state.
2. Disconnect network entirely before starting setup, or temporarily modify the PyTorch index URL in `pluginInstaller.ts` line 249 to an invalid host (revert after testing).
3. Start setup; let it fail twice (auto-retry runs once internally).

Expected: SetupScreen shows the plugin error inline with **Retry plugins** and **Continue without plugins** buttons. No other steps regress.

- [ ] **4. Continue without plugins**

Steps:
1. From the hard-failure state above (or by clicking Continue), click **Continue without plugins**.
2. Verify main app renders.
3. Open the Plugins menu from the app menu.
4. Verify PluginsModal opens and shows "Plugins are not installed" with a working Install button.

Expected: Main app is usable; manual install from menu works as today.

- [ ] **5. Retry plugins from error state**

Steps:
1. From the hard-failure state, restore network or revert the URL change.
2. Click **Retry plugins**.

Expected: Progress resumes on the Plugins step; on success setup completes and main app loads. On another failure the error UI returns.

- [ ] **6. Existing setup, no auto-prompt**

Steps:
1. Start from a state where core deps are installed but plugins were never installed (e.g., a prior install that ran setup before this change shipped).
2. Launch the app.

Expected: SetupScreen does not appear (core deps are present). No auto-prompt of PluginsModal. User installs from the menu.

- [ ] **7. Reinstall / uninstall from menu**

Steps:
1. With plugins installed, open the Plugins menu.
2. Click **Reinstall** — verify it re-runs and completes.
3. Click **Uninstall** — verify the packages get removed.

Expected: Both flows work as before; progress renders in PluginsModal (not SetupScreen) because menu-mode uses the original `plugin-dependency-progress` channel.

- [ ] **Final commit (if any manual fixes were needed during verification)**

If any issues were found and fixed during manual verification, commit the fix:

```bash
git add <fixed files>
git commit -m "Fix <issue> uncovered during manual verification"
```

If verification was clean, no commit is needed for this task.

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec (architecture, data flow, error handling, testing, migration) maps to one or more tasks above. Specifically: Task 2+3 implements the channel flag + auto-retry-once installer; Task 4+5 implements the handler chain and final-event move; Task 6+7+8 implements the renderer wiring; Task 9 covers all 7 manual verification scenarios from the spec.
- **Placeholder scan:** Every step has concrete code or commands. No TBDs or "add error handling as appropriate." The only intentional flexibility is in Task 9 step 1's `npm run dev` mention — Vapourkit uses an electron+vite dev flow, so the actual dev command should be looked up in `package.json` scripts when running it.
- **Type consistency:** `installDependenciesForSetup`, `emitSetupComplete`, `pluginInstallError`, `handleRetryPlugins`, `handleContinueWithoutPlugins`, `onRetryPlugins`, `onContinueWithoutPlugins`, `retrySetupPlugins`, and the new `'installing'` variant of `SetupProgress.type` all appear with matching names and signatures across tasks. The IPC channel name `'retry-setup-plugins'` matches between preload (Task 1), the handler (Task 5), and the renderer call (`window.electronAPI.retrySetupPlugins` in Task 7).
