// src/hooks/useLutImport.ts - Bringing a LUT file in, as a Load LUT step.

import { useCallback } from 'react';
import type { Filter, FilterTemplate } from '../electron';
import { getErrorMessage } from '../types/errors';
import { writeCube, parseLut, to3d } from '../utils/lut';
import { notify } from '../utils/notifications';

interface UseLutImportOptions {
  filterTemplates: FilterTemplate[];
  filters: Filter[];
  /** The grade the import is made from: the new step goes straight after it. */
  activeFilterEditorId: string | null;
  handleSetFilters: (filters: Filter[]) => void;
}

export function useLutImport({ filterTemplates, filters, activeFilterEditorId, handleSetFilters }: UseLutImportOptions) {
  // Making a table is a step in the chain, not a gesture over it: a Create LUT
  // remembers the colour where it sits, and a Load LUT below it makes the
  // table that puts that colour back. Import is the other direction and
  // cannot be a step's own doing, because a LUT is an arbitrary transform and
  // the trackballs are not — so an imported table arrives as a Load LUT step,
  // which is also what lets it sit anywhere in the chain like everything else.
  /**
   * Pick a table off disk and keep a normalised copy beside the app's data.
   *
   * The parse happens here rather than in the main process so this tested
   * parser is the only one, and so its "line 4: ..." reaches the person who
   * has to fix the file. A 1D table is lifted onto a lattice; .3dl and
   * declared domains are folded away, leaving one plain shape for the render.
   */
  const handlePickLutFile = useCallback(async (): Promise<{ path: string; title: string } | null> => {
    const source = await window.electronAPI.selectLutFile('open');
    if (!source) return null;

    const read = await window.electronAPI.readLutFile(source);
    if (!read.success) {
      notify.error('LUT not read', read.error);
      return null;
    }

    let normalised: string;
    let title: string;
    try {
      const parsed = to3d(parseLut(read.text, read.name));
      title = parsed.title || read.name.replace(/\.[^.]+$/, '');
      normalised = writeCube(parsed, title);
    } catch (error) {
      notify.error('That LUT could not be read', getErrorMessage(error));
      return null;
    }

    const installed = await window.electronAPI.installLut(read.name, normalised);
    if (!installed.success) {
      notify.error('LUT not read', installed.error);
      return null;
    }
    return { path: installed.path, title };
  }, []);

  const handleImportLut = useCallback(async () => {
    const template = filterTemplates.find(t => t.name === 'Load LUT');
    if (!template) {
      notify.error('Load LUT is missing', 'The Load LUT filter template is not installed.');
      return;
    }
    const installed = await handlePickLutFile();
    if (!installed) return;
    const title = installed.title;

    const defaults = Object.entries(template.variables ?? {}).reduce<Record<string, string | number | boolean>>(
      (values, [name, variable]) => {
        if (variable.default !== undefined) values[name] = variable.default;
        return values;
      }, {});

    const step: Filter = {
      id: `filter-${Date.now()}`,
      enabled: true,
      filterType: 'custom',
      preset: 'Load LUT',
      code: template.code,
      category: template.category,
      parameters: { ...defaults, lut_path: installed.path },
      variables: template.variables,
      editor: template.editor,
      order: filters.length,
    };

    // Straight after the grade it was imported from, so the chain reads in
    // the order the look was built.
    const at = filters.findIndex(filter => filter.id === activeFilterEditorId);
    const next = at === -1 ? [...filters, step] : [
      ...filters.slice(0, at + 1), step, ...filters.slice(at + 1),
    ];
    handleSetFilters(next.map((filter, index) => ({ ...filter, order: index })));
    notify.success('LUT imported', `"${title}" added to the chain as a Load LUT step.`);
  }, [activeFilterEditorId, filterTemplates, filters, handleSetFilters]);

  return { handlePickLutFile, handleImportLut };
}
