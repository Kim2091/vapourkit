// src/hooks/useGpuStats.ts - GPU memory and load for the title strip.

import { useEffect, useState } from 'react';

export type GpuStats = { gpuMemoryUsed: number; gpuMemoryTotal: number; gpuUtilization: number };

/** GPU stats, polled every 3 seconds whether or not anything is processing. Null without nvidia-smi. */
export function useGpuStats(): GpuStats | null {
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const stats = await window.electronAPI.getGpuStats();
        if (active) setGpuStats(stats);
      } catch { /* nvidia-smi unavailable */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  return gpuStats;
}
