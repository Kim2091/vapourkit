import * as path from 'path';
import { ipcMain, shell } from 'electron';
import { z } from 'zod';

import { PATHS } from './constants';
import { createIpcHandler } from './ipcUtilities';
import { handleValidated } from './ipcValidation';
import { clearUpdateReport, markUpdateReportSeen, readUpdateReport } from './installLedger';
import type { DependencyManager } from './dependencyManager';

/**
 * IPC for the post-update notice: what the last update did on its own, and the
 * edited filter templates it left for the user to decide about.
 */
export function registerUpdateReportHandlers(dependencyManager: DependencyManager) {
  const snapshot = async () => ({
    report: await readUpdateReport(),
    decisions: await dependencyManager.getTemplateDecisions(),
  });

  ipcMain.handle('update-report-get', createIpcHandler('update-report-get', snapshot, { throwOnError: true }));

  ipcMain.handle(
    'update-report-mark-seen',
    createIpcHandler('update-report-mark-seen', () => markUpdateReportSeen(), { throwOnError: true }),
  );

  ipcMain.handle(
    'update-report-clear',
    createIpcHandler('update-report-clear', () => clearUpdateReport(), { throwOnError: true }),
  );

  handleValidated(
    'update-report-resolve',
    z.tuple([z.string().min(1), z.enum(['replace', 'keep', 'remove'])]),
    async ([file, choice]) => {
      const { backupPath } = await dependencyManager.resolveTemplateDecision(file, choice);
      return { backupPath, ...await snapshot() };
    },
  );

  ipcMain.handle(
    'templates-missing-bundled',
    createIpcHandler('templates-missing-bundled', () => dependencyManager.getMissingBundledTemplates(), { throwOnError: true }),
  );

  ipcMain.handle(
    'templates-restore-bundled',
    createIpcHandler('templates-restore-bundled', () => dependencyManager.restoreMissingBundledTemplates(), { throwOnError: true }),
  );

  ipcMain.handle(
    'update-report-open-backups',
    createIpcHandler('update-report-open-backups', async () => {
      const error = await shell.openPath(path.join(PATHS.CONFIG, 'template-backups'));
      if (error) throw new Error(error);
    }, { throwOnError: true }),
  );
}
