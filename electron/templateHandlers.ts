import { validateFilterTemplate, variablesWithParameters } from './filterValidation';
import { ipcMain } from 'electron';
import * as fs from 'fs-extra';
import * as TOML from '@iarna/toml';
import { logger } from './logger';
import { TemplateManager, FilterTemplate } from './templateManager';

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

  ipcMain.handle('save-filter-template', async (event, template: FilterTemplate) => {
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

  ipcMain.handle('import-template-file', async (event, filePath: string) => {
    logger.info(`Importing template file: ${filePath}`);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size > 2 * 1024 * 1024) throw new Error('Choose a .vkfilter text file smaller than 2 MiB.');
      const content = await fs.readFile(filePath, 'utf-8');
      
      // Parse TOML in the main process (Node.js context)
      const template = TOML.parse(content) as unknown as FilterTemplate;
      
      validateFilterTemplate(template);
      const parameters = (template as FilterTemplate & { parameters?: Record<string, string | number | boolean> }).parameters;
      template.variables = variablesWithParameters(template.variables, parameters);
      return { success: true, template, warnings: ['Imported Python filters may need external dependencies. Validate the workflow with a video before rendering. Use Plugins → Partial reinstall for bundled dependencies; external plugins must match your operating system and VapourSynth version.'] };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error importing template file:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
}
