import { beforeEach, describe, expect, it } from 'vitest';
import type { Filter, QueueItem } from '../electron.d';
import {
  editingItemIdOf,
  viewOf,
  workflowDocumentReducer,
  type WorkflowDocumentAction,
  type WorkflowDocumentState,
} from './workflowDocument';
import {
  adoptLegacySnapshot,
  configChanges,
  loadDocument,
  persistDocumentChange,
  projectConfigAside,
} from './workflowPersistence';
import {
  encodingPatchOf,
  encodingSettingsOf,
  fromQueueWorkflow,
  loadedWorkflowRecord,
  migrateQueueWorkflow,
  renderSettingsOf,
  restorePatchOf,
  toQueueWorkflow,
  type ConfigSettings,
  type LoadedWorkflowRecord,
} from './workflowSettings';
import { readEditingItemId, readProjectConfigAside, writeProjectConfigAside } from './workflowStores';
import { DEFAULT_SIMPLE_ENCODING, migrateLegacyArgs, type EncodingSettings } from '../../electron/encodingSettings';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const storage = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage;

const step = (id: string): Filter => ({ id, enabled: true, filterType: 'custom', preset: id, code: `# ${id}`, order: 0 });

/** Advanced-mode encoding with these arguments. */
const adv = (customArgs: string): EncodingSettings => ({ mode: 'advanced', simple: DEFAULT_SIMPLE_ENCODING, customArgs });

const COLOR = { overwriteMatrix: false, matrix709: false, defaultMatrix: '709', defaultPrimaries: '709', defaultTransfer: '709' } as const;

/**
 * One run of the app: the document as the hook keeps it, app-config.json as
 * the main process sees it, and the queue items edits are saved to.
 */
class Session {
  state: WorkflowDocumentState;
  items = new Map<string, QueueItem['workflow']>();

  constructor(public config: Partial<ConfigSettings>) {
    this.state = loadDocument();
    adoptLegacySnapshot(this.state);
    this.dispatch({ type: 'loaded', values: { ...config } });
  }

  dispatch(action: WorkflowDocumentAction) {
    const previous = this.state;
    const next = workflowDocumentReducer(previous, action);
    if (next === previous) return;
    this.state = next;
    persistDocumentChange(next, previous, (id, workflow) => this.items.set(id, workflow));
    Object.assign(this.config, configChanges(next, this.config));
    writeProjectConfigAside(projectConfigAside(next));
  }

  get view() {
    return viewOf(this.state);
  }
}

const projectConfig = (): Partial<ConfigSettings> => ({
  encoding: adv('-c:v libx264'),
  processingFormat: 'vs.YUV420P8',
  outputFormat: 'mkv',
  videoCompareArgs: '-W',
  colorimetry: COLOR,
});

const itemWorkflow = (): QueueItem['workflow'] => ({
  selectedModel: null,
  filters: [step('item')],
  encoding: adv('-c:v libx265'),
  ffmpegArgs: '-c:v libx265',
  processingFormat: 'vs.YUV444P16',
  outputFormat: 'mp4',
  videoCompareArgs: '-W',
  defaultBackend: 'tensorrt',
  numStreams: 4,
});

beforeEach(() => {
  storage.clear();
  storage.setItem('filters', JSON.stringify([step('project')]));
  storage.setItem('numStreams', '2');
  storage.setItem('defaultBackend', 'tensorrt');
});

describe('editing a queue item', () => {
  it('saves the edits to the item and leaves the project alone', () => {
    const app = new Session(projectConfig());
    app.dispatch({ type: 'openSession', session: { videoPath: 'C:/v/project.mp4', outputPath: null, outputPathOverride: null } });
    app.dispatch({ type: 'openItem', id: 'q1', editable: true, settings: fromQueueWorkflow(itemWorkflow(), app.view) });
    app.dispatch({ type: 'patch', patch: { filters: [step('edited')], encoding: adv('-crf 18'), numStreams: 3 } });

    expect(app.items.get('q1')).toMatchObject({ filters: [step('edited')], encoding: adv('-crf 18'), ffmpegArgs: '-crf 18', numStreams: 3 });
    expect(JSON.parse(storage.getItem('filters')!)).toEqual([step('project')]);
    expect(storage.getItem('numStreams')).toBe('2');
    expect(app.state.project.encoding).toEqual(adv('-c:v libx264'));
    // The config renders what the window shows; the project's are kept aside meanwhile.
    expect(app.config.encoding).toEqual(adv('-crf 18'));
    expect(JSON.parse(storage.getItem('projectConfigSettings')!).encoding).toEqual(adv('-c:v libx264'));
  });

  it('undoes only within the item, and a finished item takes no edits', () => {
    const app = new Session(projectConfig());
    app.dispatch({ type: 'openItem', id: 'q1', editable: true, settings: fromQueueWorkflow(itemWorkflow(), app.view) });
    expect(app.state.history.past).toEqual([]);
    app.dispatch({ type: 'patch', patch: { filters: [step('edited')] } });
    app.dispatch({ type: 'undo' });
    expect(app.view.filters).toEqual([step('item')]);
    app.dispatch({ type: 'undo' });
    expect(app.view.filters).toEqual([step('item')]);

    app.items.clear();
    app.dispatch({ type: 'openItem', id: 'done', editable: false, settings: fromQueueWorkflow(itemWorkflow(), app.view) });
    app.dispatch({ type: 'patch', patch: { filters: [step('looked at')] } });
    expect(app.items.size).toBe(0);
    expect(editingItemIdOf(app.state)).toBeNull();
  });
});

describe('opening and closing the queue', () => {
  it('shows the project as it was, with its segment and the config back', () => {
    const app = new Session(projectConfig());
    const segment = { enabled: true, startFrame: 10, endFrame: 20 };
    app.dispatch({ type: 'patch', patch: { segment } });
    const before = app.state.project;

    app.dispatch({ type: 'openSession', session: { videoPath: 'C:/v/project.mp4', outputPath: 'E:/out.mkv', outputPathOverride: 'E:/out.mkv' } });
    app.dispatch({ type: 'openItem', id: 'q1', editable: true, settings: fromQueueWorkflow(itemWorkflow(), app.view) });
    app.dispatch({ type: 'patch', patch: { filters: [step('edited')], segment: { enabled: true, startFrame: 0, endFrame: 5 } } });
    const session = app.state.session;
    app.dispatch({ type: 'showProject' });
    app.dispatch({ type: 'closeSession' });

    expect(app.state.project).toBe(before);
    expect(app.view.segment).toEqual(segment);
    expect(session).toEqual({ videoPath: 'C:/v/project.mp4', outputPath: 'E:/out.mkv', outputPathOverride: 'E:/out.mkv' });
    expect(app.config).toEqual(projectConfig());
    expect(storage.getItem('preQueueWorkflow')).toBeNull();
    expect(storage.getItem('projectConfigSettings')).toBeNull();
    expect(readEditingItemId()).toBeNull();
  });

  it('keeps project edits made while the queue is open and nothing is edited', () => {
    const app = new Session(projectConfig());
    app.dispatch({ type: 'openSession', session: { videoPath: null, outputPath: null } });
    app.dispatch({ type: 'patch', patch: { filters: [step('kept')] } });
    app.dispatch({ type: 'closeSession' });
    expect(JSON.parse(storage.getItem('filters')!)).toEqual([step('kept')]);
  });
});

describe('restarting with the queue open', () => {
  it('comes back with the project intact and the edited item to resume', () => {
    const first = new Session(projectConfig());
    first.dispatch({ type: 'patch', patch: { segment: { enabled: true, startFrame: 1, endFrame: 2 } } });
    first.dispatch({ type: 'openSession', session: { videoPath: 'C:/v/project.mp4', outputPath: null, outputPathOverride: null } });
    first.dispatch({ type: 'openItem', id: 'q1', editable: true, settings: fromQueueWorkflow(itemWorkflow(), first.view) });
    first.dispatch({ type: 'patch', patch: { processingFormat: 'vs.RGBS' } });

    // The config still holds the item's settings, as it did when the app closed.
    const second = new Session({ ...first.config });
    expect(second.state.project.filters).toEqual([step('project')]);
    expect(second.state.project.encoding).toEqual(adv('-c:v libx264'));
    expect(second.state.project.processingFormat).toBe('vs.YUV420P8');
    expect(second.state.project.segment).toEqual({ enabled: true, startFrame: 1, endFrame: 2 });
    expect(second.state.session?.videoPath).toBe('C:/v/project.mp4');
    expect(readEditingItemId()).toBe('q1');
    // Showing the project puts its settings back in the config.
    expect(second.config.processingFormat).toBe('vs.YUV420P8');
  });

  it('takes an older pre-queue record as the project over what localStorage holds', () => {
    // As versions before the document wrote it: localStorage and the config
    // hold the edited item's settings, the record holds the project's.
    storage.setItem('filters', JSON.stringify([step('item')]));
    storage.setItem('numStreams', '4');
    storage.setItem('preQueueWorkflow', JSON.stringify({
      videoPath: 'C:/v/project.mp4',
      outputPath: 'C:/v/project-processed.mkv',
      selectedModel: null,
      filters: [step('project')],
      outputFormat: 'mkv',
      defaultBackend: 'tensorrt',
      numStreams: 2,
      segment: { enabled: false, startFrame: 0, endFrame: -1 },
      ffmpegArgs: '-c:v libx264',
      processingFormat: 'vs.YUV420P8',
      videoCompareArgs: '-W',
      colorimetry: COLOR,
    }));

    const app = new Session({ ...projectConfig(), encoding: adv('-c:v libx265'), outputFormat: 'mp4' });
    expect(app.state.project.filters).toEqual([step('project')]);
    expect(app.state.project.numStreams).toBe(2);
    // Its encoding, kept only as arguments, is migrated: these ones the simple controls can show.
    expect(app.state.project.encoding).toEqual(migrateLegacyArgs('-c:v libx264'));
    expect(app.state.project.encoding.mode).toBe('simple');
    expect(app.state.project.outputFormat).toBe('mkv');
    expect(JSON.parse(storage.getItem('filters')!)).toEqual([step('project')]);
    expect(JSON.parse(storage.getItem('preQueueWorkflow')!).version).toBe(2);
    expect(app.state.session?.outputPathOverride).toBeUndefined();
  });

  it('puts the project back after a crash during a queue run with the queue closed', () => {
    const first = new Session(projectConfig());
    first.dispatch({ type: 'lockRender', settings: { encoding: adv('-c:v libx265') } });
    expect(first.config.encoding).toEqual(adv('-c:v libx265'));

    const second = new Session({ ...first.config });
    expect(second.state.project.encoding).toEqual(adv('-c:v libx264'));
    expect(second.config.encoding).toEqual(adv('-c:v libx264'));
    expect(storage.getItem('projectConfigSettings')).toBeNull();
  });
});

describe('loading a workflow, then restarting', () => {
  it('keeps the workflow\'s settings, and Clear still puts back what it replaced', () => {
    const first = new Session(projectConfig());
    const record = loadedWorkflowRecord('Anime', 'project', first.view);
    storage.setItem('loadedWorkflow', JSON.stringify(record));
    first.dispatch({
      type: 'patch',
      patch: { ...encodingPatchOf({ ffmpegArgs: '-c:v libx264 -tune film', numStreams: 3 }), filters: [step('workflow')] },
    });

    const second = new Session({ ...first.config });
    expect(second.view.filters).toEqual([step('workflow')]);
    expect(second.view.encoding).toEqual(adv('-c:v libx264 -tune film'));
    expect(second.view.numStreams).toBe(3);

    const saved = JSON.parse(storage.getItem('loadedWorkflow')!) as LoadedWorkflowRecord;
    second.dispatch({ type: 'patch', patch: restorePatchOf(saved) });
    expect(second.view.filters).toEqual([step('project')]);
    expect(second.view.encoding).toEqual(adv('-c:v libx264'));
    expect(second.view.numStreams).toBe(2);
    expect(second.config.encoding).toEqual(adv('-c:v libx264'));
  });
});

describe('the config read at launch', () => {
  it('does not replace a setting changed before it arrived', () => {
    let state = loadDocument();
    state = workflowDocumentReducer(state, { type: 'patch', patch: { encoding: adv('-crf 10') } });
    state = workflowDocumentReducer(state, { type: 'loaded', values: projectConfig() });
    expect(state.project.encoding).toEqual(adv('-crf 10'));
    expect(state.project.processingFormat).toBe('vs.YUV420P8');
    expect(state.loaded).toBe(true);
  });
});

describe('a queue item rendering', () => {
  it('holds its own render settings in the config, then gives the config back', () => {
    const app = new Session(projectConfig());
    app.dispatch({ type: 'lockRender', settings: { encoding: adv('-c:v libx265'), processingFormat: 'vs.RGBS' } });
    app.dispatch({ type: 'patch', patch: { encoding: adv('-crf 20'), outputFormat: 'mp4' } });
    expect(app.config.encoding).toEqual(adv('-c:v libx265'));
    expect(app.config.outputFormat).toBe('mp4');
    app.dispatch({ type: 'unlockRender' });
    expect(app.config.encoding).toEqual(adv('-crf 20'));
    expect(app.config.processingFormat).toBe('vs.YUV420P8');
  });
});

describe('queue workflows', () => {
  it('round-trip, and older items keep the current settings for fields they lack', () => {
    const app = new Session(projectConfig());
    const workflow = itemWorkflow();
    expect(toQueueWorkflow(fromQueueWorkflow(workflow, app.view))).toEqual({ ...workflow, segment: undefined, colorimetry: COLOR });

    const older = { ...workflow, encoding: undefined, ffmpegArgs: undefined, colorimetry: undefined } as unknown as QueueItem['workflow'];
    const settings = fromQueueWorkflow(older, app.view);
    expect(settings.encoding).toEqual(adv('-c:v libx264'));
    expect(settings.colorimetry).toEqual(COLOR);
  });
});

describe('encoding kept only as ffmpegArgs', () => {
  const OLD_STOCK = '-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1 -movflags +faststart';
  const legacyItem = (ffmpegArgs: string): QueueItem['workflow'] => ({ ...itemWorkflow(), encoding: undefined, ffmpegArgs });

  it('is migrated in queue items as they load, render and open', () => {
    const simple = migrateQueueWorkflow(legacyItem(OLD_STOCK));
    expect(simple.encoding).toMatchObject({ mode: 'simple', simple: { codec: 'h264', preset: 'medium', quality: 18 }, customArgs: OLD_STOCK });
    // The arguments stored beside it are what it now encodes, so it is not migrated again.
    expect(simple.ffmpegArgs).toBe(OLD_STOCK.replace(' -movflags +faststart', ''));
    expect(migrateQueueWorkflow(simple)).toBe(simple);

    const typed = '-c:v hevc_nvenc -preset p4 -cq 19 -b:v 0 -spatial-aq 1';
    expect(renderSettingsOf(legacyItem(typed)).encoding).toMatchObject({ mode: 'advanced', customArgs: typed, simple: { codec: 'h265', encoder: 'nvidia' } });
    expect(fromQueueWorkflow(legacyItem(typed), new Session(projectConfig()).view).encoding.mode).toBe('advanced');
  });

  it('keeps the mode of each queue item', () => {
    const app = new Session(projectConfig());
    const simpleItem = migrateQueueWorkflow(legacyItem(OLD_STOCK));
    app.dispatch({ type: 'openItem', id: 'a', editable: true, settings: fromQueueWorkflow(itemWorkflow(), app.view) });
    expect(app.view.encoding.mode).toBe('advanced');
    app.dispatch({ type: 'openItem', id: 'b', editable: true, settings: fromQueueWorkflow(simpleItem, app.view) });
    expect(app.view.encoding.mode).toBe('simple');
    expect(app.config.encoding?.mode).toBe('simple');
    app.dispatch({ type: 'showProject' });
    expect(app.view.encoding).toEqual(adv('-c:v libx264'));
  });

  it('is migrated in the set-aside project settings', () => {
    storage.setItem('projectConfigSettings', JSON.stringify({ ffmpegArgs: OLD_STOCK, processingFormat: 'vs.YUV420P10' }));
    const aside = readProjectConfigAside()!;
    expect(aside.encoding?.mode).toBe('simple');
    expect('ffmpegArgs' in aside).toBe(false);
    expect(loadDocument().project.encoding.mode).toBe('simple');
  });

  it('is migrated in a loaded-workflow record from before the mode was stored', () => {
    const record = { currentWorkflow: 'w', previousFilters: [], previousModel: null, previousEncodingSettings: {
      ffmpegArgs: '-c:v libx264 -tune grain', processingFormat: 'vs.YUV420P8', outputFormat: 'mkv', videoCompareArgs: '-W',
      numStreams: 2, segment: { enabled: false, startFrame: 0, endFrame: -1 }, colorimetry: COLOR,
    } } as LoadedWorkflowRecord;
    expect(restorePatchOf(record).encoding).toEqual(adv('-c:v libx264 -tune grain'));
  });

  it('is written beside the encoding settings for older versions', () => {
    const app = new Session(projectConfig());
    const settings = { ...app.view, encoding: { ...adv('-c:v libx264 -tune film'), mode: 'simple' as const } };
    const resolved = '-c:v libx264 -preset medium -crf 18 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709 -map_metadata 1';
    expect(toQueueWorkflow(settings).ffmpegArgs).toBe(resolved);
    expect(encodingSettingsOf(settings).ffmpegArgs).toBe(resolved);
    expect(loadedWorkflowRecord('w', 'project', settings).previousEncodingSettings?.ffmpegArgs).toBe(resolved);
    expect(encodingPatchOf(encodingSettingsOf(settings)).encoding).toEqual(settings.encoding);
  });
});
