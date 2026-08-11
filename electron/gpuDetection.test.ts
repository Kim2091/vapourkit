import { describe, it, expect, vi } from 'vitest';

// gpuDetection transitively imports constants.ts (via utils) and the logger,
// both of which touch electron at module scope.
vi.mock('electron', async () => {
  const p = await import('path');
  const o = await import('os');
  const root = p.join(o.tmpdir(), `vk-gpudetect-test-${process.pid}`);
  return {
    app: {
      isPackaged: false,
      getAppPath: () => root,
      getPath: () => root,
    },
  };
});

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mapPciVendorId, pickPreferredVendor, type GpuVendor } from './gpuDetection';

describe('mapPciVendorId', () => {
  const cases: Array<[string, number, GpuVendor]> = [
    ['NVIDIA', 0x10de, 'nvidia'],
    ['AMD/ATI', 0x1002, 'amd'],
    ['Intel', 0x8086, 'intel'],
    ['Microsoft Basic Render Driver', 0x1414, 'unknown'],
    ['an unlisted vendor', 0x1234, 'unknown'],
    ['zero', 0, 'unknown'],
    ['NaN (missing vendorId)', Number.NaN, 'unknown'],
  ];

  it.each(cases)('maps %s to %s', (_label, id, expected) => {
    expect(mapPciVendorId(id)).toBe(expected);
  });
});

describe('pickPreferredVendor', () => {
  const cases: Array<[GpuVendor[], GpuVendor]> = [
    [['nvidia'], 'nvidia'],
    [['amd'], 'amd'],
    [['intel'], 'intel'],
    // nvidia beats amd beats intel (discrete/richest backend first)
    [['intel', 'amd', 'nvidia'], 'nvidia'],
    [['intel', 'nvidia'], 'nvidia'],
    [['intel', 'amd'], 'amd'],
    [['unknown', 'intel'], 'intel'],
    [['unknown'], 'unknown'],
    [[], 'unknown'],
  ];

  it.each(cases)('picks %j → %s', (candidates, expected) => {
    expect(pickPreferredVendor(candidates)).toBe(expected);
  });
});
