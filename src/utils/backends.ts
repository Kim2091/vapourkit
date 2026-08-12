// src/utils/backends.ts
//
// Renderer-side access to the inference backend registry. The descriptor
// table is shared with the electron main process (single source of truth) —
// see electron/providers/descriptors.ts for how to add a backend.

import {
  BACKENDS as ALL_BACKENDS,
  getBackendDescriptor,
  isBackendId,
  resolveBackendId,
  resolveFilterBackend,
} from '../../electron/providers/descriptors';

export {
  getBackendDescriptor,
  isBackendId,
  resolveBackendId,
  resolveFilterBackend,
};

// The shared descriptor registry intentionally contains every implementation
// so the main process can generate compatible scripts. The renderer only offers
// the backends that this build installs: DirectML on Windows, NCNN on Linux.
const isLinux = typeof window !== 'undefined' && window.electronAPI?.platform === 'linux';
export const BACKENDS = isLinux
  ? ALL_BACKENDS.filter(backend => backend.id !== 'directml')
  : ALL_BACKENDS.filter(backend => backend.id !== 'ncnn');

export type {
  BackendId,
  BackendDescriptor,
  FilterBackend,
} from '../../electron/providers/descriptors';
