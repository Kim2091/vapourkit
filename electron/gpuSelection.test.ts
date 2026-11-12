import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyGpuEnvironment, choiceFor, findChosenGpu, gpuEnvironmentEntries, gpuScriptTarget, type GpuInfo } from './gpuSelection';

function gpu(overrides: Partial<GpuInfo>): GpuInfo {
  return {
    name: 'GPU', vendorId: 0x10de, deviceId: 0x2c59, type: 'discrete', luid: null, pci: null, vramMB: 16000,
    dxgi: null, vulkan: null, cuda: null, cudaUuid: null, hip: null, ...overrides,
  };
}

const nvidia = gpu({ name: 'RTX', luid: '0000000000011a99', pci: '0000:01:00.0', dxgi: 0, vulkan: 0, cuda: 0, cudaUuid: 'GPU-dd37' });
const amd = gpu({ name: 'Radeon', vendorId: 0x1002, deviceId: 0x13c0, type: 'integrated', luid: '000000000000fff1', dxgi: 1, vulkan: 1 });

describe('gpu selection', () => {
  it('stores a GPU with the keys that outlive a reboot', () => {
    expect(choiceFor([nvidia, amd], amd)).toEqual({
      name: 'Radeon', vendorId: 0x1002, deviceId: 0x13c0, ordinal: 0, luid: '000000000000fff1',
    });
    expect(choiceFor([nvidia, amd], nvidia)).toMatchObject({ pci: '0000:01:00.0', cudaUuid: 'GPU-dd37' });
  });

  it('finds the stored GPU by PCI location, then by model and ordinal', () => {
    const twin = gpu({ name: 'RTX', pci: '0000:02:00.0', cuda: 1, cudaUuid: 'GPU-aa' });
    const gpus = [nvidia, twin, amd];
    expect(findChosenGpu(gpus, choiceFor(gpus, twin))).toBe(twin);
    expect(findChosenGpu(gpus, { name: 'RTX', vendorId: 0x10de, deviceId: 0x2c59, ordinal: 1 })).toBe(twin);
    expect(findChosenGpu(gpus, { name: 'Radeon', vendorId: 0x1002, deviceId: 0x13c0, ordinal: 0, luid: 'stale' })).toBe(amd);
    expect(findChosenGpu([nvidia], choiceFor(gpus, amd))).toBeUndefined();
  });

  it('pins CUDA and HIP only to a GPU those APIs see', () => {
    expect(applyGpuEnvironment({ PATH: 'x' }, undefined)).toEqual({ PATH: 'x' });
    expect(applyGpuEnvironment({}, choiceFor([nvidia], nvidia))).toEqual({ CUDA_VISIBLE_DEVICES: 'GPU-dd37' });
    expect(applyGpuEnvironment({}, choiceFor([amd], amd))).toEqual({});
    expect(gpuEnvironmentEntries(choiceFor([gpu({ hip: 0 })], gpu({ hip: 0 })))).toEqual({ HIP_VISIBLE_DEVICES: '0' });
  });

  it('writes the choice as the dict vk_runtime takes', () => {
    expect(gpuScriptTarget(undefined)).toBe('None');
    expect(gpuScriptTarget(choiceFor([amd], amd)))
      .toBe('{"name": "Radeon", "vendorId": 4098, "deviceId": 5056, "ordinal": 0, "luid": "000000000000fff1"}');
  });
});
