// electron/templateManager.ts
import * as fs from 'fs-extra';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import { PATHS } from './constants';
import { logger } from './logger';

export interface FilterTemplate {
  name: string;
  code: string;
  description?: string;
  metadata?: {
    author?: string;
    createdAt?: string;
    tags?: string[];
    [key: string]: any;
  };
}

export class TemplateManager {
  private templatesDir: string;

  constructor() {
    this.templatesDir = PATHS.FILTER_TEMPLATES;
  }

  /**
   * Ensures the templates directory exists
   */
  private async ensureTemplatesDir(): Promise<void> {
    await fs.ensureDir(this.templatesDir);
  }

  /**
   * Gets the file path for a template
   */
  private getTemplatePath(name: string): string {
    // Sanitize the name to prevent directory traversal
    const sanitizedName = name.replace(/[^a-zA-Z0-9_\-\s]/g, '_');
    return path.join(this.templatesDir, `${sanitizedName}.vkfilter`);
  }

  /**
   * Loads all filter templates from the templates directory
   */
  async loadTemplates(): Promise<FilterTemplate[]> {
    try {
      await this.ensureTemplatesDir();
      
      const files = await fs.readdir(this.templatesDir);
      const templateFiles = files.filter(f => f.endsWith('.vkfilter'));
      
      const templates: FilterTemplate[] = [];
      
      for (const file of templateFiles) {
        try {
          const filePath = path.join(this.templatesDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Parse TOML template
          const template = TOML.parse(content) as unknown as FilterTemplate;
          
          // Validate template structure
          if (template.name && template.code !== undefined) {
            templates.push(template);
          } else {
            logger.warn(`Invalid template file: ${file}`);
          }
        } catch (error) {
          logger.error(`Error loading template ${file}:`, error);
        }
      }
      
      logger.info(`Loaded ${templates.length} filter template(s)`);
      return templates;
    } catch (error) {
      logger.error('Error loading templates:', error);
      return [];
    }
  }

  /**
   * Saves a filter template to a .vkfilter file in TOML format
   */
  async saveTemplate(template: FilterTemplate): Promise<void> {
    try {
      await this.ensureTemplatesDir();
      
      // Add metadata if not present
      if (!template.metadata) {
        template.metadata = {};
      }
      if (!template.metadata.createdAt) {
        template.metadata.createdAt = new Date().toISOString();
      }
      
      const filePath = this.getTemplatePath(template.name);
      const content = TOML.stringify(template as any);
      
      await fs.writeFile(filePath, content, 'utf-8');
      logger.info(`Saved template: ${template.name}`);
    } catch (error) {
      logger.error(`Error saving template ${template.name}:`, error);
      throw error;
    }
  }

  /**
   * Deletes a filter template
   */
  async deleteTemplate(name: string): Promise<void> {
    try {
      const filePath = this.getTemplatePath(name);
      
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        logger.info(`Deleted template: ${name}`);
      } else {
        throw new Error(`Template not found: ${name}`);
      }
    } catch (error) {
      logger.error(`Error deleting template ${name}:`, error);
      throw error;
    }
  }

  /**
   * Creates default templates by copying from bundled .vkfilter files if they don't exist
   * This is now handled by dependencyManager during setup
   */
  async createDefaultTemplates(): Promise<void> {
    try {
      await this.ensureTemplatesDir();
      logger.info('Default templates directory ensured');
    } catch (error) {
      logger.error('Error ensuring templates directory:', error);
    }
  }
}