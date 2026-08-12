import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  LINUX_PLUGIN_FILTERS,
  hasPluginFilterTemplates,
  LINUX_PLUGIN_FILTER_CATALOG_REVISION,
  needsLinuxPluginFilterCatalogSync,
  selectPluginFilterTemplates,
  selectUnsupportedLinuxPluginFilterTemplates,
} from './pluginFilterCatalog';

describe('plugin filter catalog policy', () => {
  const sourceFiles = [
    'Crop.vkfilter',
    'QTGMC _New_.vkfilter',
    'Undistort _Pytorch_.vkfilter',
    'Undistort _TensorRT_.vkfilter',
    'Deep Deinterlace.vkfilter',
    'CQTGMC.vkfilter',
    'Custom.vkfilter',
  ];

  it('keeps the complete catalog on Windows', () => {
    expect(selectPluginFilterTemplates(sourceFiles, 'win32')).toEqual(sourceFiles);
  });

  it('only admits verified PyPI-backed templates on Linux', () => {
    expect(selectPluginFilterTemplates(sourceFiles, 'linux')).toEqual([
      'Crop.vkfilter',
      'QTGMC _New_.vkfilter',
      'Undistort _Pytorch_.vkfilter',
      'Undistort _TensorRT_.vkfilter',
      'Deep Deinterlace.vkfilter',
    ]);
  });

  it('does not expose a plugin-filter catalog on unsupported platforms', () => {
    expect(selectPluginFilterTemplates(sourceFiles, 'darwin')).toEqual([]);
    expect(hasPluginFilterTemplates('darwin')).toBe(false);
    expect(hasPluginFilterTemplates('linux')).toBe(true);
  });

  it('identifies stale Linux catalog entries for safe migration', () => {
    expect(selectUnsupportedLinuxPluginFilterTemplates(sourceFiles)).toEqual([
      'CQTGMC.vkfilter',
      'Custom.vkfilter',
    ]);
  });

  it('keeps the allowlist free of duplicate filenames', () => {
    const names = Object.values(LINUX_PLUGIN_FILTERS).flat();
    expect(new Set(names).size).toBe(names.length);
  });

  it('synchronizes a changed Linux catalog even when the app version is unchanged', () => {
    expect(needsLinuxPluginFilterCatalogSync(undefined, 'linux')).toBe(true);
    expect(needsLinuxPluginFilterCatalogSync(LINUX_PLUGIN_FILTER_CATALOG_REVISION - 1, 'linux')).toBe(true);
    expect(needsLinuxPluginFilterCatalogSync(LINUX_PLUGIN_FILTER_CATALOG_REVISION, 'linux')).toBe(false);
    expect(needsLinuxPluginFilterCatalogSync(undefined, 'win32')).toBe(false);
  });

  it('uses CPU fallbacks for Linux-capable AI templates outside TensorRT', () => {
    const filtersDir = path.join(process.cwd(), 'include', 'plugins', 'plugin_filters');
    const undistort = fs.readFileSync(path.join(filtersDir, 'Undistort _Pytorch_.vkfilter'), 'utf8');
    const deepDeinterlace = fs.readFileSync(path.join(filtersDir, 'Deep Deinterlace.vkfilter'), 'utf8');

    expect(undistort).toContain('backend       = "cuda" if VK_BACKEND == "tensorrt" else "cpu"');
    expect(deepDeinterlace).toContain('device="cuda" if use_cuda else "cpu", fp16=use_cuda');
  });
});
