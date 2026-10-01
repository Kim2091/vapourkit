import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRocmEnvironment,
  describeRocm,
  migraphxVersionFromFileName,
  prependLibraryPath,
  resolveRocmRoot,
} from './rocmEnvironment';

const onlyRocm = (dir: string) => dir === path.join('/opt/rocm', 'lib');

describe('resolveRocmRoot', () => {
  it('defaults to /opt/rocm, and follows ROCM_PATH', () => {
    expect(resolveRocmRoot({ mode: 'auto' }, {}, 'linux', onlyRocm)).toBe('/opt/rocm');
    expect(resolveRocmRoot({ mode: 'auto' }, { ROCM_PATH: '/usr/lib/rocm' }, 'linux', () => true)).toBe('/usr/lib/rocm');
  });

  it('uses the chosen folder in custom mode', () => {
    expect(resolveRocmRoot({ mode: 'custom', customRoot: '/home/u/therock' }, {}, 'linux', () => true)).toBe('/home/u/therock');
    expect(resolveRocmRoot({ mode: 'custom' }, {}, 'linux', () => true)).toBeNull();
  });

  it('is null in environment mode, without a lib folder, and off Linux', () => {
    expect(resolveRocmRoot({ mode: 'environment' }, {}, 'linux', () => true)).toBeNull();
    expect(resolveRocmRoot({ mode: 'auto' }, {}, 'linux', () => false)).toBeNull();
    expect(resolveRocmRoot({ mode: 'auto' }, {}, 'win32', () => true)).toBeNull();
  });
});

describe('prependLibraryPath', () => {
  it('puts the folder ahead of what is already there', () => {
    // A second ROCm on the user's path must not win over MIGraphX's own
    expect(prependLibraryPath('/home/u/therock-tarball/install/lib:/tmp/.mount_x/usr/lib', '/opt/rocm/lib'))
      .toBe('/opt/rocm/lib:/home/u/therock-tarball/install/lib:/tmp/.mount_x/usr/lib');
    expect(prependLibraryPath(undefined, '/opt/rocm/lib')).toBe('/opt/rocm/lib');
  });

  it('moves an existing entry to the front instead of listing it twice', () => {
    expect(prependLibraryPath('/a:/opt/rocm/lib', '/opt/rocm/lib')).toBe('/opt/rocm/lib:/a');
  });

  it('leaves the path alone without a folder', () => {
    expect(prependLibraryPath('/a', null)).toBe('/a');
    expect(prependLibraryPath(undefined, null)).toBeUndefined();
  });
});

describe('applyRocmEnvironment', () => {
  it('points the loader, ROCM_PATH and the driver at the chosen root', () => {
    const env = applyRocmEnvironment(
      { LD_LIBRARY_PATH: '/home/u/therock/lib', ROCM_PATH: '/home/u/therock' },
      { mode: 'custom', customRoot: '/opt/rocm' }, 'linux', () => true);
    expect(env['LD_LIBRARY_PATH']).toBe(`${path.join('/opt/rocm', 'lib')}:/home/u/therock/lib`);
    expect(env['ROCM_PATH']).toBe('/opt/rocm');
    expect(env['VK_MIGRAPHX_DRIVER']).toBe(path.join('/opt/rocm', 'bin', 'migraphx-driver'));
  });

  it('touches nothing in environment mode', () => {
    const before = { LD_LIBRARY_PATH: '/home/u/therock/lib', ROCM_PATH: '/home/u/therock' };
    expect(applyRocmEnvironment({ ...before }, { mode: 'environment' }, 'linux', () => true)).toEqual(before);
  });
});

describe('migraphxVersionFromFileName', () => {
  it('reads major, minor and patch from the library suffix', () => {
    expect(migraphxVersionFromFileName('libmigraphx.so.2015000')).toBe('2.15.0');
    expect(migraphxVersionFromFileName('libmigraphx.so.2012003')).toBe('2.12.3');
  });

  it('ignores other files', () => {
    expect(migraphxVersionFromFileName('libmigraphx_c.so.3')).toBeNull();
    expect(migraphxVersionFromFileName('libmigraphx.so')).toBeNull();
  });
});

describe('describeRocm', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-rocm-'));
    await fs.mkdir(path.join(root, 'lib'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports the MIGraphX it finds', async () => {
    await fs.writeFile(path.join(root, 'lib', 'libmigraphx_c.so.3'), '');
    await fs.writeFile(path.join(root, 'lib', 'libmigraphx.so.2015000'), '');
    await fs.mkdir(path.join(root, 'bin'));
    await fs.writeFile(path.join(root, 'bin', 'migraphx-driver'), '');
    const status = describeRocm({ mode: 'custom', customRoot: root }, {}, 'linux');
    expect(status).toMatchObject({ root, migraphxVersion: '2.15.0', hasMigraphxLibrary: true, hasMigraphxDriver: true });
    expect(status.summary).toContain('MIGraphX 2.15.0 found');
  });

  it('says when the root has no MIGraphX', () => {
    const status = describeRocm({ mode: 'custom', customRoot: root }, {}, 'linux');
    expect(status.hasMigraphxLibrary).toBe(false);
    expect(status.summary).toContain('no libmigraphx_c.so.3');
  });

  it('says when the chosen folder is not a ROCm root', () => {
    const status = describeRocm({ mode: 'custom', customRoot: path.join(root, 'nope') }, {}, 'linux');
    expect(status.root).toBeNull();
    expect(status.summary).toContain('no ROCm lib folder');
  });

  it('asks for a folder when custom has none', () => {
    expect(describeRocm({ mode: 'custom' }, {}, 'linux').summary).toBe('Choose your ROCm folder (the one containing lib and bin).');
  });

  it('is unsupported off Linux', () => {
    expect(describeRocm({ mode: 'auto' }, {}, 'win32').supported).toBe(false);
  });
});
