import { BrowserWindow } from 'electron';
import { registerDialogHandlers } from './dialogHandlers';
import { registerModelHandlers } from './modelHandlers';
import { registerVideoHandlers } from './videoHandlers';
import { registerConfigHandlers } from './configHandlers';
import { registerWorkflowHandlers } from './workflowHandlers';
import { registerTemplateHandlers } from './templateHandlers';
import { registerDependencyHandlers } from './dependencyHandlers';
import { DependencyManager } from './dependencyManager';
import { VapourSynthScriptGenerator } from './scriptGenerator';
import { TemplateManager } from './templateManager';
import { PluginInstaller } from './pluginInstaller';

/**
 * Central registry for all IPC handlers
 * Organizes handlers into logical groups
 */
export function registerAllIpcHandlers(
  mainWindow: BrowserWindow | null,
  dependencyManager: DependencyManager,
  scriptGenerator: VapourSynthScriptGenerator,
  templateManager: TemplateManager,
  pluginInstaller: PluginInstaller
) {
  // Register all handler groups
  registerDialogHandlers();
  registerModelHandlers(mainWindow);
  registerVideoHandlers(mainWindow, scriptGenerator, dependencyManager);
  registerConfigHandlers(mainWindow);
  registerWorkflowHandlers();
  registerTemplateHandlers(templateManager);
  registerDependencyHandlers(dependencyManager, pluginInstaller);
}
