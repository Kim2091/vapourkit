import { memo, useCallback, useEffect, useState } from 'react';
import { Cpu, FolderOpen, Info } from 'lucide-react';
import type { RocmMode, RocmSettingResult } from '../electron.d';

const MODES: { id: RocmMode; label: string; description: string }[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Uses $ROCM_PATH, or /opt/rocm. Its libraries load ahead of any other ROCm on your library path, and its migraphx-driver compiles models.',
  },
  {
    id: 'environment',
    label: 'Use my environment',
    description: 'Vapourkit leaves the library path alone: your LD_LIBRARY_PATH and loader cache decide which ROCm loads.',
  },
  {
    id: 'custom',
    label: 'Custom folder',
    description: 'A ROCm root you choose, such as a TheRock tarball\'s install folder. Used the same way as Auto.',
  },
];

/**
 * Which ROCm install the MIGraphX backend runs against (electron/rocmEnvironment.ts).
 * Loads and saves itself, and renders nothing off Linux.
 */
export const RocmSettingsSection = memo(() => {
  const [result, setResult] = useState<RocmSettingResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getRocmSetting()
      .then(loaded => { if (!cancelled) setResult(loaded); })
      .catch(() => { /* the section just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (mode: RocmMode, customRoot?: string) => {
    setResult(await window.electronAPI.setRocmSetting({ mode, ...(customRoot ? { customRoot } : {}) }));
  }, []);

  const browse = useCallback(async () => {
    const folder = await window.electronAPI.selectFolder();
    if (folder) await save('custom', folder);
  }, [save]);

  if (!result?.status.supported) return null;
  const { setting, status } = result;
  const ok = status.hasMigraphxLibrary && status.hasMigraphxDriver;

  return (
    <section className="mt-2 border-t border-ink-700">
      <div className="h-9 flex items-stretch gap-2.5 bg-ink-850 border-b border-ink-800">
        <span className="w-[3px] bg-accent-500 flex-shrink-0" aria-hidden="true" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Cpu className="w-3.5 h-3.5 text-ink-500" />
          <h3 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-100">ROCm Installation</h3>
        </div>
      </div>

      <p className="px-4 pt-2.5 pb-1 text-[11px] text-ink-500">
        Which ROCm the MIGraphX backend loads and compiles with. Change this if you have more than one ROCm installed.
      </p>
      {MODES.map(mode => (
        <label key={mode.id} className="flex items-start gap-3 cursor-pointer px-4 py-2 border-b border-ink-900 hover:bg-ink-850 transition-colors">
          <input
            type="radio"
            name="rocm-mode"
            checked={setting.mode === mode.id}
            onChange={() => save(mode.id, setting.customRoot)}
            className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] text-ink-200">{mode.label}</p>
            <p className="text-[11px] text-ink-500 mt-0.5">{mode.description}</p>
          </div>
        </label>
      ))}

      {setting.mode === 'custom' && (
        <div className="px-4 py-2.5 border-b border-ink-900">
          <div className="flex gap-2">
            <input
              type="text"
              value={setting.customRoot || ''}
              readOnly
              className="flex-1 min-w-0 h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] text-ink-300 placeholder-ink-500 focus:outline-none focus:border-accent-500 transition-colors"
              placeholder="No folder chosen"
            />
            <button
              onClick={browse}
              className="h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-[11.5px] font-semibold bg-ink-850 border border-ink-750 text-ink-300 hover:bg-ink-800 hover:border-ink-700 transition-colors flex-shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Browse
            </button>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2.5 px-4 py-2.5">
        <Info className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${ok ? 'text-accent-400' : 'text-ink-500'}`} />
        <p className={`text-[11px] min-w-0 break-words ${ok ? 'text-ink-300' : 'text-ink-500'}`}>{status.summary}</p>
      </div>
    </section>
  );
});

RocmSettingsSection.displayName = 'RocmSettingsSection';
