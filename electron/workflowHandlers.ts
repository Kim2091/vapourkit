import { ipcMain } from 'electron';
import * as fs from 'fs-extra';
import { logger } from './logger';

/**
 * Registers all workflow-related IPC handlers
 */
export function registerWorkflowHandlers() {
  ipcMain.handle('export-workflow', async (event, workflow: any, filePath: string) => {
    logger.info(`Exporting workflow to: ${filePath}`);
    try {
      const toml = require('@iarna/toml');
      
      // Convert workflow to TOML format
      const tomlData = {
        workflow: {
          name: workflow.name,
          version: workflow.version,
          created_at: workflow.createdAt,
          description: workflow.description || '',
        },
        filters: workflow.filters.map((f: any) => ({
          name: f.name,
          code: f.code,
          description: f.description || '',
          enabled: f.enabled,
          order: f.order,
          filterType: f.filterType || 'custom',
          modelPath: f.modelPath || undefined,
          modelType: f.modelType || undefined,
        })),
      };

      const tomlString = toml.stringify(tomlData);
      await fs.writeFile(filePath, tomlString, 'utf-8');
      
      logger.info('Workflow exported successfully');
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error exporting workflow:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('import-workflow', async (event, filePath: string) => {
    logger.info(`Importing workflow from: ${filePath}`);
    try {
      const toml = require('@iarna/toml');
      
      const content = await fs.readFile(filePath, 'utf-8');
      const data = toml.parse(content);
      
      // Validate workflow structure
      if (!data.workflow || !data.filters) {
        throw new Error('Invalid workflow file format');
      }

      const workflow = {
        name: data.workflow.name,
        version: data.workflow.version,
        createdAt: data.workflow.created_at,
        description: data.workflow.description,
        filters: Array.isArray(data.filters) ? data.filters.map((f: any) => ({
          name: f.name,
          code: f.code,
          description: f.description || undefined,
          enabled: f.enabled,
          order: f.order,
          filterType: f.filterType || 'custom',
          modelPath: f.modelPath || undefined,
          modelType: f.modelType || undefined,
        })) : [],
      };

      logger.info(`Workflow imported successfully: ${workflow.name}`);
      return { success: true, workflow };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error importing workflow:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
}
