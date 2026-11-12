import { memo, useCallback, useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type { BackendId, GpuInfo, GpuListResult } from '../electron.d';
import { BACKENDS } from '../utils/backends';

/** The API each backend numbers GPUs in (include/vk_gpus.py). */
const BACKEND_API: Record<BackendId, keyof Pick<GpuInfo, 'cuda' | 'dxgi' | 'vulkan' | 'hip'>> = {
  tensorrt: 'cuda',
  directml: 'dxgi',
  ncnn: 'vulkan',
  migraphx: 'hip',
};

function gpuLabel(gpu: GpuInfo): string {
  const memory = gpu.vramMB ? ` · ${gpu.vramMB >= 1024 ? `${Math.round(gpu.vramMB / 1024)} GB` : `${gpu.vramMB} MB`}` : '';
  const kind = gpu.type === 'integrated' ? ' · integrated' : '';
  return `${gpu.name}${memory}${kind}`;
}

/**
 * Which GPU every backend runs on (electron/gpuSelection.ts). Lists the GPUs
 * when it opens, and says which backends cannot use the chosen one.
 */
export const GpuSettingsSection = memo(() => {
  const [result, setResult] = useState<GpuListResult | null>(null);

  const load = useCallback(async () => {
    setResult(await window.electronAPI.getGpus());
  }, []);

  useEffect(() => {
    load().catch(() => { /* the picker just stays empty */ });
  }, [load]);

  const choose = useCallback(async (value: string) => {
    await window.electronAPI.setGpu(value === '' ? null : Number(value));
    await load();
  }, [load]);

  const gpus = result?.gpus ?? [];
  const selected = result?.selected ?? null;
  const missing = result?.choice && selected === null ? result.choice.name : null;
  const gpu = selected !== null ? gpus[selected] : undefined;
  const unusable = gpu ? BACKENDS.filter(backend => gpu[BACKEND_API[backend.id]] === null) : [];

  let note: string;
  if (result?.error) note = result.error;
  else if (missing) note = `${missing} was not found, so every backend uses its default GPU. Choose another or Automatic.`;
  else if (!gpu) note = 'Each backend uses its own default GPU.';
  else if (unusable.length === 0) note = 'Every backend runs on this GPU.';
  else note = `${unusable.map(backend => backend.label).join(' and ')} cannot run on this GPU and ${unusable.length === 1 ? 'uses its' : 'use their'} default GPU instead.`;

  return (
    <div className="px-4 py-2.5 border-b border-ink-900">
      <p className="mb-1.5 text-[10px] font-display font-semibold uppercase tracking-[0.09em] text-ink-500">GPU</p>
      <select
        value={selected ?? ''}
        onChange={(e) => choose(e.target.value)}
        disabled={!result || gpus.length === 0}
        className="w-full h-7 bg-ink-850 border border-ink-750 rounded px-2 text-[12.5px] text-ink-200 focus:outline-none focus:border-accent-500 transition-colors disabled:text-ink-500"
      >
        <option value="">{missing ? `${missing} (not found)` : 'Automatic'}</option>
        {gpus.map((item, index) => (
          <option key={`${item.luid ?? item.pci ?? item.name}-${index}`} value={index}>{gpuLabel(item)}</option>
        ))}
      </select>
      <div className="flex items-start gap-2 mt-1.5">
        <Info className={`w-3.5 h-3.5 flex-shrink-0 mt-px ${missing || unusable.length ? 'text-warn-400' : 'text-ink-500'}`} />
        <p className="text-[11px] text-ink-500 min-w-0">{note}</p>
      </div>
    </div>
  );
});

GpuSettingsSection.displayName = 'GpuSettingsSection';
