import { describe, expect, it } from 'vitest';
import { describeModel, profileFor, type ContractGraph } from './modelContract';
const graph = (channels = 3): ContractGraph => ({ inputs: [{ name: 'pixels', shape: [1, channels, 'h', 'w'], dataType: 'float32' }], outputs: [{ name: 'result', shape: [1, 3, 'oh', 'ow'], dataType: 'float32' }] });
describe('model contract', () => {
  it('keeps tensor types separate from build precision and derives legal stage profiles', () => {
    const c = describeModel(graph(27), { modelType: 'vsr', temporalFrames: 9 });
    expect(c.inputType).toBe('float32');
    expect(profileFor(c, 3840, 2160)).toBe('pixels:1x27x2160x3840');
  });
  it('rejects layouts the RGB adapter cannot interpret, rather than generating plausible flags', () => {
    expect(() => describeModel(graph(6))).toThrow('odd frame');
    expect(() => describeModel(graph(1))).toThrow('channel');
    const multi = graph(); multi.inputs.push({ ...multi.inputs[0], name: 'state' });
    expect(() => describeModel(multi)).toThrow('multiple');
    const five = graph(); five.inputs[0].shape = [1, 5, 3, 'h', 'w'];
    expect(() => describeModel(five)).toThrow('NCHW');
    expect(() => describeModel(graph(15), { temporalFrames: 9 })).toThrow('requires 5');
  });
  it('preserves static dimensions and enforces adapter constraints', () => {
    const g = graph(); g.inputs[0].shape = [1, 3, 480, 640];
    const c = describeModel(g, { spatialMultiple: 8 });
    expect(() => profileFor(c, 1280, 720)).toThrow('fixed');
    expect(() => profileFor(c, 641, 480)).toThrow('divisible');
    expect(profileFor(c, 640, 480)).toBe('pixels:1x3x480x640');
  });
});
