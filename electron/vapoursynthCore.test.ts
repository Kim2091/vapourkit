import { describe, expect, it } from 'vitest';
import { API3_UNSUPPORTED, describeCoreTooNew, VAPOURSYNTH_VERSION } from './vapoursynthCore';

describe('core past the pin', () => {
  it('recognises the R80 API 3 refusal', () => {
    expect(API3_UNSUPPORTED.test(
      'Critical: Plugin c:\vk\plugins\ort\vsort.dll uses API 3, which is no longer supported.')).toBe(true);
    expect(API3_UNSUPPORTED.test(
      'Warning: Plugin c:\vk\autocrop.dll is using API3 which is deprecated and will be removed shortly.')).toBe(false);
  });

  it('names the pin and the fix', () => {
    expect(describeCoreTooNew()).toContain(`newer than R${VAPOURSYNTH_VERSION}`);
    expect(describeCoreTooNew()).toContain('Restart Vapourkit');
  });
});
