import { ipcMain } from 'electron';
import * as fs from 'fs-extra';
import { logger } from './logger';
import { TemplateManager } from './templateManager';

/**
 * Registers all filter template-related IPC handlers
 */
export function registerTemplateHandlers(templateManager: TemplateManager) {
  ipcMain.handle('get-filter-templates', async () => {
    logger.info('Getting filter templates');
    try {
      const templates = await templateManager.loadTemplates();
      logger.info(`Loaded ${templates.length} template(s)`);
      return templates;
    } catch (error) {
      logger.error('Error getting filter templates:', error);
      throw error;
    }
  });

  ipcMain.handle('save-filter-template', async (event, template: { 
    name: string; 
    code: string; 
    description?: string; 
    metadata?: any 
  }) => {
    logger.info(`Saving filter template: ${template.name}`);
    try {
      await templateManager.saveTemplate(template);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error saving filter template:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('delete-filter-template', async (event, name: string) => {
    logger.info(`Deleting filter template: ${name}`);
    try {
      await templateManager.deleteTemplate(name);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error deleting filter template:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('read-template-file', async (event, filePath: string) => {
    logger.info(`Reading template file: ${filePath}`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error reading template file:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
}
