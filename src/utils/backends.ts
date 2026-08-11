// src/utils/backends.ts
//
// Renderer-side access to the inference backend registry. The descriptor
// table is shared with the electron main process (single source of truth) —
// see electron/providers/descriptors.ts for how to add a backend.

export {
  BACKENDS,
  getBackendDescriptor,
  isBackendId,
  resolveBackendId,
  resolveFilterBackend,
} from '../../electron/providers/descriptors';

export type {
  BackendId,
  BackendDescriptor,
  FilterBackend,
} from '../../electron/providers/descriptors';
