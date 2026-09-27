// electron/templateManager.ts
import * as fs from 'fs-extra';
import * as path from 'path';
import * as TOML from '@iarna/toml';
import { PATHS } from './constants';
import { logger } from './logger';

export interface FilterTemplate {
  name: string;
  code: string;
  category?: string | string[]; // Can be a single category or multiple categories
  description?: string;
  variables?: Record<string, {
    type?: 'number' | 'string' | 'boolean';
    default?: string | number | boolean;
    description?: string;
    /** App-written: substituted into the code, never offered as a control. */
    hidden?: boolean;
  }>;
  editor?: {
    type: 'crop';
    label?: string;
    variables: {
      left: string;
      right: string;
      top: string;
      bottom: string;
    };
  } | {
    type: 'colorGrade';
    label?: string;
    variables: {
      /** Each ball names four variables, in R, G, B, master order. */
      lift: [string, string, string, string];
      gamma: [string, string, string, string];
      gain: [string, string, string, string];
      offset: [string, string, string, string];
      temperature: string;
      tint: string;
      contrast: string;
      pivot: string;
      saturation: string;
      hue: string;
      brightness: string;
    };
  };
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
   * The file that holds the template called `name`. A bundled file is not
   * always named after its template ("DeHalo Alpha (Old).vkfilter",
   * "Undistort _Pytorch_.vkfilter"), so deleting or saving by the derived name
   * alone missed those, or wrote a second copy beside them. Falls back to the
   * derived path for a template that has no file yet.
   */
  private async resolveTemplatePath(name: string): Promise<string> {
    const nameIn = async (filePath: string): Promise<unknown> => {
      try {
        return (TOML.parse(await fs.readFile(filePath, 'utf-8')) as { name?: unknown }).name;
      } catch {
        return undefined;
      }
    };

    const derived = this.getTemplatePath(name);
    if (await fs.pathExists(derived) && await nameIn(derived) === name) return derived;
    try {
      for (const file of (await fs.readdir(this.templatesDir)).filter(f => f.endsWith('.vkfilter'))) {
        const filePath = path.join(this.templatesDir, file);
        if (await nameIn(filePath) === name) return filePath;
      }
    } catch (error) {
      logger.warn(`Could not search filter templates for ${name}:`, error);
    }

    // No file holds it yet. Two names can sanitize alike ("A (x)", "A [x]"),
    // so never hand out a path another template already lives at.
    let candidate = derived;
    for (let n = 2; await fs.pathExists(candidate); n++) {
      candidate = derived.replace(/\.vkfilter$/, ` ${n}.vkfilter`);
    }
    return candidate;
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
      
      const filePath = await this.resolveTemplatePath(template.name);
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
      const filePath = await this.resolveTemplatePath(name);
      
      // A free path means no file holds this template.
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
