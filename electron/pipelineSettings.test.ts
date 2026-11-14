import { describe, expect, it } from 'vitest';
import { DEFAULT_PIPELINE_SETTINGS, pipelineSettingsSchema } from './pipelineSettings';

describe('pipeline preferences', () => {
  it('preserves existing processing behavior for an old config', () => {
    expect(pipelineSettingsSchema.parse({})).toEqual({ optimizeAiChains: false, requests: 0, previewHeight: 720, previewFps: 1 });
    expect(DEFAULT_PIPELINE_SETTINGS).toEqual(pipelineSettingsSchema.parse({}));
  });
  it('rejects unsafe or malformed resource settings', () => {
    for (const value of [{ requests: -1 }, { requests: 33 }, { requests: 1.5 }, { previewHeight: 0 }, { previewFps: 0 }, { previewFps: 6 }, { optimizeAiChains: 'true' }]) {
      expect(pipelineSettingsSchema.safeParse(value).success).toBe(false);
    }
  });
});
