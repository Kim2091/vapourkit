// electron/lutHandlers.ts — reading and writing colour lookup tables.
//
// The main process only moves bytes: every parse and every serialise happens
// in src/utils/lut.ts, where it is tested. That is deliberate. A .cube from
// the internet is untrusted input, and a parser that reports "line 4: a table
// row needs three values" is only useful if the renderer can put that in
// front of someone — so the text crosses the boundary, not a parsed table.

import { ipcMain, dialog } from 'electron';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PATHS } from './constants';
import { logger } from './logger';

/** Refuse anything that cannot plausibly be a text LUT before reading it. */
const MAX_LUT_BYTES = 96 * 1024 * 1024;

const FILTERS = [
  { name: 'Colour lookup table', extensions: ['cube', '3dl'] },
  { name: 'Cube LUT', extensions: ['cube'] },
  { name: 'Autodesk 3DL', extensions: ['3dl'] },
  { name: 'All Files', extensions: ['*'] },
];

export function registerLutHandlers() {
  ipcMain.handle('select-lut-file', async (_event, mode: 'open' | 'save', defaultName?: string) => {
    try {
      if (mode === 'open') {
        const result = await dialog.showOpenDialog({
          title: 'Import a LUT',
          properties: ['openFile'],
          filters: FILTERS,
        });
        return result.canceled ? null : result.filePaths[0];
      }
      const result = await dialog.showSaveDialog({
        title: 'Export a LUT',
        filters: FILTERS,
        defaultPath: defaultName || 'Grade.cube',
      });
      return result.canceled ? null : result.filePath;
    } catch (error) {
      logger.error('Error selecting LUT file:', error);
      return null;
    }
  });

  ipcMain.handle('write-lut-file', async (_event, filePath: string, text: string) => {
    logger.info(`Writing LUT to: ${filePath}`);
    try {
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, text, 'utf8');
      return { success: true as const, path: filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Error writing LUT:', error);
      return { success: false as const, error: message };
    }
  });

  // An imported table is normalised to a plain 0..1 3D .cube and kept beside
  // the app's other data, so the filter step points at something stable: the
  // file someone picked may sit on a drive that is not there next time, and
  // .3dl and odd domains are turned into the one shape the render reads.
  ipcMain.handle('install-lut', async (_event, name: string, text: string) => {
    try {
      const safe = name.replace(/[^a-zA-Z0-9_\-\s.]/g, '_').replace(/\.(cube|3dl)$/i, '') || 'Imported LUT';
      const directory = path.join(PATHS.APP_DATA, 'luts');
      await fs.ensureDir(directory);

      // Two LUTs called Sunset.cube from different folders are two different
      // looks. Overwriting by basename would repoint every saved workflow
      // holding that path at whichever was imported last, silently. So an
      // identical file is reused, and a different one gets its own name.
      let target = path.join(directory, `${safe}.cube`);
      let stored = safe;
      for (let attempt = 2; attempt <= 999; attempt++) {
        if (!await fs.pathExists(target)) break;
        const existing = await fs.readFile(target, 'utf8').catch(() => null);
        if (existing === text) break;
        stored = `${safe} (${attempt})`;
        target = path.join(directory, `${stored}.cube`);
      }

      await fs.writeFile(target, text, 'utf8');
      logger.info(`Installed LUT: ${target}`);
      return { success: true as const, path: target, name: stored };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Error installing LUT:', error);
      return { success: false as const, error: message };
    }
  });

  ipcMain.handle('read-lut-file', async (_event, filePath: string) => {
    logger.info(`Reading LUT from: ${filePath}`);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return { success: false as const, error: 'That path is not a file.' };
      }
      // A 65-cube .cube is about 7MB of text, and a 256-cube is enormous but
      // legal. The cap is there so a mistaken pick of a video file does not
      // pull gigabytes into a string before the parser can reject it.
      if (stats.size > MAX_LUT_BYTES) {
        return {
          success: false as const,
          error: `That file is ${(stats.size / 1024 / 1024).toFixed(0)}MB, which is far larger than any LUT.`,
        };
      }
      const text = await fs.readFile(filePath, 'utf8');
      return { success: true as const, text, name: path.basename(filePath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Error reading LUT:', error);
      return { success: false as const, error: message };
    }
  });
}
