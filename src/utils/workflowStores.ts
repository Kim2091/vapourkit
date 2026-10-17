// src/utils/workflowStores.ts - Where the project's settings are saved: localStorage and app-config.json.

import type { BackendId, ColorimetrySettings, Filter } from '../electron.d';
import { isBackendId, normalizeBackendForCurrentPlatform } from './backends';
import type { PreQueueWorkflow } from './projectSnapshot';
import { type ConfigField, type ConfigSettings, type LocalField, type WorkflowSettings } from './workflowSettings';

const PRE_QUEUE_KEY = 'preQueueWorkflow';
const EDITING_ITEM_KEY = 'editingQueueItemId';
/**
 * The project's config-held settings while the config holds a queue item's,
 * so a crash in the meantime cannot leave the item's settings as the project's.
 */
const PROJECT_CONFIG_KEY = 'projectConfigSettings';

function readJson<T>(key: string): T | null {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: what is in memory still covers this session.
  }
}

/**
 * The saved default backend, migrating the legacy `useDirectML` boolean key
 * in place the first time it is seen. Null before backend detection has run.
 */
export function readStoredBackend(): BackendId | null {
  try {
    const saved = localStorage.getItem('defaultBackend');
    if (saved !== null && isBackendId(saved)) {
      const normalized = normalizeBackendForCurrentPlatform(saved);
      if (normalized !== saved) localStorage.setItem('defaultBackend', normalized);
      return normalized;
    }

    const legacy = localStorage.getItem('useDirectML');
    if (legacy !== null) {
      try {
        const migrated = normalizeBackendForCurrentPlatform(JSON.parse(legacy));
        localStorage.setItem('defaultBackend', migrated);
        localStorage.removeItem('useDirectML');
        return migrated;
      } catch {
        // Corrupt legacy value: fall through to first-run detection.
      }
    }
  } catch {
    // Storage blocked: detection decides.
  }
  return null;
}

/** The project's localStorage-held settings, over base. */
export function readLocalProject(base: WorkflowSettings): WorkflowSettings {
  const filters = readJson<Filter[]>('filters');
  let numStreams = base.numStreams;
  try {
    const saved = localStorage.getItem('numStreams');
    if (saved !== null && Number.isFinite(parseInt(saved, 10))) numStreams = parseInt(saved, 10);
  } catch {
    // Storage blocked: the default stands.
  }
  return {
    ...base,
    filters: Array.isArray(filters) ? filters : base.filters,
    numStreams,
    // No saved preference yet: assume TensorRT until backend detection
    // resolves, without saving the guess, which would stop detection from
    // ever deciding.
    defaultBackend: readStoredBackend() ?? base.defaultBackend,
  };
}

/** Save the project's localStorage-held settings named in keys. */
export function writeLocalProject(project: WorkflowSettings, keys: LocalField[]): void {
  try {
    for (const key of keys) {
      if (key === 'filters') localStorage.setItem('filters', JSON.stringify(project.filters));
      else if (key === 'numStreams') localStorage.setItem('numStreams', String(project.numStreams));
      else localStorage.setItem('defaultBackend', project.defaultBackend);
    }
  } catch {
    // Storage full or blocked: the settings still work for this session.
  }
}

export function readPreQueueSnapshot(): PreQueueWorkflow | null {
  return readJson<PreQueueWorkflow>(PRE_QUEUE_KEY);
}

export function writePreQueueSnapshot(snapshot: PreQueueWorkflow | null): void {
  writeJson(PRE_QUEUE_KEY, snapshot);
}

export function readEditingItemId(): string | null {
  try {
    return localStorage.getItem(EDITING_ITEM_KEY);
  } catch {
    return null;
  }
}

export function writeEditingItemId(id: string | null): void {
  try {
    if (id) localStorage.setItem(EDITING_ITEM_KEY, id);
    else localStorage.removeItem(EDITING_ITEM_KEY);
  } catch {
    // Storage blocked: editing still works for this session.
  }
}

export function readProjectConfigAside(): Partial<ConfigSettings> | null {
  return readJson<Partial<ConfigSettings>>(PROJECT_CONFIG_KEY);
}

export function writeProjectConfigAside(settings: Partial<ConfigSettings> | null): void {
  writeJson(PROJECT_CONFIG_KEY, settings);
}

/** The config-held settings as app-config.json has them. A value that cannot be read is left out. */
export async function loadConfigSettings(): Promise<Partial<ConfigSettings>> {
  const api = window.electronAPI;
  const values: Partial<ConfigSettings> = {};
  const read = async <K extends ConfigField>(key: K, get: () => Promise<ConfigSettings[K]>) => {
    try {
      values[key] = await get();
    } catch (error) {
      console.error(`Failed to load ${key}:`, error);
    }
  };
  await read('ffmpegArgs', async () => (await api.getFfmpegArgs()).args);
  await read('processingFormat', async () => (await api.getProcessingFormat()).format);
  await read('outputFormat', async () => (await api.getOutputFormat()).format);
  await read('videoCompareArgs', async () => (await api.getVideoCompareArgs()).args);
  await read('colorimetry', async () => await api.getColorimetrySettings() as ColorimetrySettings);
  return values;
}

/** Write one config-held setting to app-config.json. */
export async function saveConfigSetting<K extends ConfigField>(key: K, value: ConfigSettings[K]): Promise<void> {
  const api = window.electronAPI;
  switch (key) {
    case 'ffmpegArgs': await api.setFfmpegArgs(value as string); break;
    case 'processingFormat': await api.setProcessingFormat(value as string); break;
    case 'outputFormat': await api.setOutputFormat(value as string); break;
    case 'videoCompareArgs': await api.setVideoCompareArgs(value as string); break;
    case 'colorimetry': await api.setColorimetrySettings(value as ColorimetrySettings); break;
  }
}

