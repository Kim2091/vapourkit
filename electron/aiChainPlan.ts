interface Step { id: string; filterType: string; modelPath?: string; enabled: boolean; }
/** Only adjacent AI stages can share RGB; custom filters and retained taps are boundaries. */
export function rgbChainBoundaries(chains: Step[][], retained: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const chain of chains) {
    const enabled = chain.filter(s => s.enabled);
    for (let i = 0; i + 1 < enabled.length; i++) {
      const current = enabled[i]; const next = enabled[i + 1];
      if (current.filterType === 'aiModel' && current.modelPath && next.filterType === 'aiModel' && next.modelPath && !retained.has(current.id)) result.add(current.id);
    }
  }
  return result;
}
