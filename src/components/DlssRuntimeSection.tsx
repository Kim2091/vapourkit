// Importing the DLSS 5 Neural Uplift runtime.
//
// nvngx_dlssnr.dll is not shipped with the NVIDIA driver and is not published by NVIDIA, so it
// cannot be downloaded - it arrives inside games that integrate DLSS 5. The user points at
// their copy once and Vapourkit puts it where the plugin looks for it.

import { memo, useCallback, useEffect, useState } from 'react';
import { CheckCircle, FolderOpen, Loader2, Sparkles, XCircle } from 'lucide-react';

import { ModalSectionHeader } from './ModalSectionHeader';
import type { DlssRuntimeStatus } from '../electron.d';

export const DlssRuntimeSection = memo(() => {
  const [status, setStatus] = useState<DlssRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.electronAPI.dlssRuntimeStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the runtime status.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleImport = async () => {
    setIsImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.dlssRuntimeImport();
      if (result.canceled) return;
      if (!result.success) {
        setError(result.error ?? 'The runtime could not be imported.');
      } else {
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The runtime could not be imported.');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <section className="mt-2 border-t border-ink-700">
      <ModalSectionHeader icon={Sparkles} title="DLSS 5 Neural Uplift" />

      <div className="px-4 py-3 border-b border-ink-900">
        <p className="text-[11px] leading-relaxed text-ink-400">
          The DLSS Neural Uplift filter needs
          <span className="font-mono text-ink-300"> nvngx_dlssnr.dll</span>, which NVIDIA does not
          ship with the driver — it comes bundled inside games that support DLSS 5. Point Vapourkit
          at your copy and it will be installed for you.
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 py-3 border-b border-ink-900 flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-ink-400 animate-spin" />
          <p className="text-[12.5px] text-ink-400">Checking for the runtime</p>
        </div>
      ) : (
        <div className="px-4 py-3 border-b border-ink-900 flex items-start gap-3">
          {status?.installed ? (
            <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-ok-400" />
          ) : (
            <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-ink-500" />
          )}
          <div className="min-w-0 flex-1">
            <p className={`text-[12.5px] font-medium ${status?.installed ? 'text-ok-400' : 'text-ink-300'}`}>
              {status?.installed ? 'Runtime installed' : 'Runtime not installed'}
            </p>
            <p className="text-[11px] leading-relaxed text-ink-500 mt-0.5">
              {status?.installed
                ? `Version ${status.installedVersion ?? 'unknown'}`
                : 'The DLSS Neural Uplift filter will not run until this is imported.'}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-3 border-b border-ink-900 bg-bad-500/5">
          <p className="text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-bad-400 mb-1">
            Error
          </p>
          <p className="text-[11.5px] leading-relaxed text-bad-300 whitespace-pre-wrap">{error}</p>
        </div>
      )}

      <div className="px-4 py-3">
        <button
          onClick={handleImport}
          disabled={isImporting || isLoading}
          className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-accent-500 text-ink-950 hover:bg-accent-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isImporting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Importing
            </>
          ) : (
            <>
              <FolderOpen className="w-3.5 h-3.5" />
              {status?.installed ? 'Replace runtime' : 'Import DLSS 5 runtime'}
            </>
          )}
        </button>
      </div>
    </section>
  );
});
