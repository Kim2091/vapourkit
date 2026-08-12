// src/utils/backends.ts
//
// Renderer-side access to the inference backend registry. The descriptor
// table is shared with the electron main process (single source of truth) —
// see electron/providers/descriptors.ts for how to add a backend.

import {
  BACKENDS as ALL_BACKENDS,
  getBackendDescriptor,
  getBackendsForPlatform,
  isBackendId,
  isBackendSupportedOnPlatform,
  normalizeBackendForPlatform,
  resolveBackendId,
  resolveFilterBackend,
} from '../../electron/providers/descriptors';

export {
  getBackendDescriptor,
  getBackendsForPlatform,
  isBackendId,
  isBackendSupportedOnPlatform,
  normalizeBackendForPlatform,
  resolveBackendId,
  resolveFilterBackend,
};

// The shared descriptor registry intentionally contains every implementation
// so the main process can generate compatible scripts. The renderer only offers
// the backends supported by the current build. In browser-only test contexts
// without Electron's platform bridge, retain the complete list.
const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
export const BACKENDS = platform ? getBackendsForPlatform(platform) : ALL_BACKENDS;

export type {
  BackendId,
  BackendPlatform,
  BackendDescriptor,
  FilterBackend,
} from '../../electron/providers/descriptors';
