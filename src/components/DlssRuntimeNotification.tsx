import { memo, useCallback, useEffect, useState } from 'react';
import { AlertCircle, FolderOpen, Loader2 } from 'lucide-react';

import type { Filter } from '../electron.d';
import { notify } from '../utils/notifications';

/**
 * Prompts for the DLSS 5 runtime when a workflow actually needs it.
 *
 * Same shape as ModelBuildNotification: a persistent bar that appears only when the workflow
 * cannot run as configured, with the fix one click away. The Plugins modal can import the
 * runtime too, but nobody thinks to look there until something has already failed - and the
 * failure without this is an NGX result code from deep inside a render.
 */

/**
 * Matches the plugin call rather than the template name, so a renamed template or hand-edited
 * filter code is still recognised.
 */
const DLSSNR_CALL = 'dlssnr.Enhance';

interface DlssRuntimeNotificationProps {
  filters: Filter[];
}

export const DlssRuntimeNotification = memo<DlssRuntimeNotificationProps>(({ filters }) => {
  const usesDlss = filters.some(f => f.enabled && f.code?.includes(DLSSNR_CALL));

  const [runtimeInstalled, setRuntimeInstalled] = useState<boolean | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await window.electronAPI.dlssRuntimeStatus();
      setRuntimeInstalled(status.installed);
    } catch {
      // A status probe that fails should not plant a banner claiming the runtime is missing.
      setRuntimeInstalled(true);
    }
  }, []);

  useEffect(() => {
    if (!usesDlss) return;
    void refresh();
  }, [usesDlss, refresh]);

  const handleImport = async () => {
    setIsImporting(true);
    try {
      const result = await window.electronAPI.dlssRuntimeImport();
      if (result.canceled) return;

      if (result.success) {
        notify.success(
          'DLSS 5 runtime installed',
          `Version ${result.version ?? 'unknown'} is ready. The Neural Uplift filter can run now.`,
        );
        await refresh();
      } else {
        notify.error('Could not install the DLSS 5 runtime', result.error ?? 'Unknown error.');
      }
    } catch (err) {
      notify.error(
        'Could not install the DLSS 5 runtime',
        err instanceof Error ? err.message : 'Unknown error.',
      );
    } finally {
      setIsImporting(false);
    }
  };

  // Nothing to say until a filter needs it and the probe has come back negative.
  if (!usesDlss || runtimeInstalled !== false) return null;

  return (
    <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-warn-500/10 border-b border-warn-500/30">
      <AlertCircle className="w-4 h-4 text-warn-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-ink-200 truncate">
          DLSS Neural Uplift needs the DLSS 5 runtime before it can run
        </p>
        <p className="text-[12px] text-ink-400">
          NVIDIA does not ship nvngx_dlssnr.dll with the driver — it comes with games that support
          DLSS 5. Point Vapourkit at your copy and it will be installed for you.
        </p>
      </div>
      <button
        onClick={handleImport}
        disabled={isImporting}
        className="h-8 px-3 rounded-md inline-flex items-center gap-2 text-[12.5px] font-semibold bg-warn-600 border border-warn-600 text-ink-950 hover:bg-warn-500 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isImporting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Importing
          </>
        ) : (
          <>
            <FolderOpen className="w-4 h-4" />
            Import runtime
          </>
        )}
      </button>
    </div>
  );
});
