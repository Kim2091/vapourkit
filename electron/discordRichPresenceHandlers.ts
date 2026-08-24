import { ipcMain } from 'electron';
import { configManager } from './configManager';
import {
  clearDiscordRichPresence,
  configureDiscordRichPresence,
  updateDiscordRichPresence,
  type DiscordRichPresenceSettings,
} from './discordRichPresence';
import type { DiscordRichPresenceActivity } from './discordRpc';

function sanitizeSettings(value: unknown): DiscordRichPresenceSettings {
  const settings = value as Partial<DiscordRichPresenceSettings> | null;
  return { enabled: settings?.enabled === true };
}

function sanitizeActivity(value: unknown): DiscordRichPresenceActivity {
  const activity = value as Partial<DiscordRichPresenceActivity> | null;
  return {
    ...(typeof activity?.details === 'string' ? { details: activity.details } : {}),
    ...(typeof activity?.state === 'string' ? { state: activity.state } : {}),
    ...(typeof activity?.startTimestamp === 'number' ? { startTimestamp: activity.startTimestamp } : {}),
  };
}

export function registerDiscordRichPresenceHandlers(): void {
  ipcMain.handle('get-discord-rich-presence-settings', async () => {
    const settings = configManager.getDiscordRichPresenceSettings();
    configureDiscordRichPresence(settings);
    return settings;
  });

  ipcMain.handle('set-discord-rich-presence-settings', async (_event, value: unknown) => {
    const settings = sanitizeSettings(value);
    await configManager.setDiscordRichPresenceSettings(settings);
    configureDiscordRichPresence(settings);
    return { success: true };
  });

  ipcMain.handle('set-discord-rich-presence-activity', async (_event, value: unknown) => {
    updateDiscordRichPresence(sanitizeActivity(value));
    return { success: true };
  });

  ipcMain.handle('clear-discord-rich-presence', async () => {
    clearDiscordRichPresence();
    return { success: true };
  });
}
