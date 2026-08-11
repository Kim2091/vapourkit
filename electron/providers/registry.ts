// electron/providers/registry.ts
//
// Single lookup point for inference backends in the main process. See
// descriptors.ts for the steps to add a new backend.

import type { BackendId } from './descriptors';
import { BACKENDS, resolveBackendId } from './descriptors';
import type { InferenceProvider } from './types';
import { tensorrtProvider } from './tensorrt';
import { directmlProvider } from './directml';

const providers: Record<BackendId, InferenceProvider> = {
  tensorrt: tensorrtProvider,
  directml: directmlProvider,
};

export function getProvider(id: BackendId): InferenceProvider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`No inference provider registered for backend: ${id}`);
  }
  return provider;
}

/** Normalizes any stored/transported value (including legacy useDirectML booleans) and returns its provider. */
export function resolveProvider(value: unknown): InferenceProvider {
  return getProvider(resolveBackendId(value));
}

export function listProviders(): InferenceProvider[] {
  return BACKENDS.map(d => getProvider(d.id));
}

export { BACKENDS, resolveBackendId } from './descriptors';
export type { BackendId } from './descriptors';
