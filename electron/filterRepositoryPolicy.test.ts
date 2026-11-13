
import { describe, expect, it } from 'vitest';
import { pkg, safePath, chooseArtifact } from './filterRepositoryPolicy';
const binary = (api?: number) => ({ url: 'https://github.com/test/repo/releases/download/1/plugin.zip', ...(api === undefined ? {} : { api }), files: { 'plugin.dll': ['x64/plugin.dll', 'a'.repeat(64)] } });
const model = (asset: unknown) => pkg.parse({ name: 'Plugin', identifier: 'test.plugin', type: 'VSPlugin', description: 'test', releases: [{ version: '1', win64: asset }] });
describe('VSRepo compatibility', () => {
  it('supports API3 and API4 on R79, including the VSRepo API3 default', () => {
    expect(chooseArtifact(model(binary(3)), 'win32', 'x64')?.api).toBe(3);
    expect(chooseArtifact(model(binary()), 'win32', 'x64')?.api).toBe(3);
    expect(chooseArtifact(model(binary(4)), 'win32', 'x64')?.api).toBe(4);
    expect(chooseArtifact(model(binary(5)), 'win32', 'x64')).toBeNull();
    expect(chooseArtifact(model(binary(3)), 'win32', 'x64', 80)).toBeNull();
  });
  it('does not offer Windows binaries to Linux or other architectures', () => {
    expect(chooseArtifact(model(binary(4)), 'linux', 'x64')).toBeNull();
    expect(chooseArtifact(model(binary(4)), 'win32', 'arm64')).toBeNull();
  });
  it('rejects unsafe destinations and unsupported hash metadata', () => {
    for (const bad of ['../outside.dll', '/absolute.dll', 'D:/absolute.dll', 'x/../../out.dll', '*.dll', '-oelsewhere']) expect(safePath.safeParse(bad).success).toBe(false);
    const asset = binary(4); asset.files['plugin.dll'][1] = 'not-a-hash';
    expect(chooseArtifact(model(asset), 'win32', 'x64')).toBeNull();
  });
});
