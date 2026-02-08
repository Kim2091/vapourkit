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
      const tomlData: any = {
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
          category: Array.isArray(f.category) && f.category.length === 1
            ? f.category[0]
            : (f.category || undefined),
        })),
      };

      // Add encoding settings if provided
      if (workflow.encodingSettings) {
        tomlData.encoding_settings = {
          ffmpeg_args: workflow.encodingSettings.ffmpegArgs,
          processing_format: workflow.encodingSettings.processingFormat,
          output_format: workflow.encodingSettings.outputFormat,
          video_compare_args: workflow.encodingSettings.videoCompareArgs,
          num_streams: workflow.encodingSettings.numStreams,
        };

        // Add segment if provided
        if (workflow.encodingSettings.segment) {
          tomlData.encoding_settings.segment = {
            enabled: workflow.encodingSettings.segment.enabled,
            start_frame: workflow.encodingSettings.segment.startFrame,
            end_frame: workflow.encodingSettings.segment.endFrame,
          };
        }

        // Add colorimetry if provided
        if (workflow.encodingSettings.colorimetry) {
          tomlData.encoding_settings.colorimetry = workflow.encodingSettings.colorimetry;
        }
      }

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

      const workflow: any = {
        name: data.workflow.name,
        version: data.workflow.version,
        createdAt: data.workflow.created_at,
        description: data.workflow.description,
        filters: Array.isArray(data.filters) ? data.filters.map((f: any) => {
          const normalizedCategory = Array.isArray(f.category) && f.category.length === 1
            ? f.category[0]
            : (f.category || undefined);
          return {
            name: f.name,
            code: f.code,
            description: f.description || undefined,
            enabled: f.enabled,
            order: f.order,
            filterType: f.filterType || 'custom',
            modelPath: f.modelPath || undefined,
            modelType: f.modelType || undefined,
            category: normalizedCategory,
          };
        }) : [],
      };

      // Parse encoding settings if present
      if (data.encoding_settings) {
        workflow.encodingSettings = {
          ffmpegArgs: data.encoding_settings.ffmpeg_args,
          processingFormat: data.encoding_settings.processing_format,
          outputFormat: data.encoding_settings.output_format,
          videoCompareArgs: data.encoding_settings.video_compare_args,
          numStreams: data.encoding_settings.num_streams,
        };

        // Parse segment if present
        if (data.encoding_settings.segment) {
          workflow.encodingSettings.segment = {
            enabled: data.encoding_settings.segment.enabled,
            startFrame: data.encoding_settings.segment.start_frame,
            endFrame: data.encoding_settings.segment.end_frame,
          };
        }

        // Parse colorimetry if present
        if (data.encoding_settings.colorimetry) {
          workflow.encodingSettings.colorimetry = data.encoding_settings.colorimetry;
        }
      }

      logger.info(`Workflow imported successfully: ${workflow.name}`);
      return { success: true, workflow };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error importing workflow:', errorMsg);
      return { success: false, error: errorMsg };
    }
  });
}
