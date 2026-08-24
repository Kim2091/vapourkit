import { DiscordRpcClient, type DiscordRichPresenceActivity } from './discordRpc';

export interface DiscordRichPresenceSettings {
  enabled: boolean;
}

/** Public Discord application registered for Vapourkit Rich Presence. */
export const VAPOURKIT_DISCORD_APPLICATION_ID = '1541563405025021962';

const client = new DiscordRpcClient();
let currentSettings: DiscordRichPresenceSettings = { enabled: false };
let lastActivity: DiscordRichPresenceActivity | null = null;

/** Applies user settings and re-publishes the most recent activity if possible. */
export function configureDiscordRichPresence(settings: DiscordRichPresenceSettings): void {
  currentSettings = { enabled: settings.enabled };

  if (!currentSettings.enabled) {
    client.clearActivity();
    return;
  }

  if (lastActivity) client.setActivity(VAPOURKIT_DISCORD_APPLICATION_ID, lastActivity);
}

export function updateDiscordRichPresence(activity: DiscordRichPresenceActivity): void {
  lastActivity = activity;
  if (currentSettings.enabled) {
    client.setActivity(VAPOURKIT_DISCORD_APPLICATION_ID, activity);
  }
}

/** Removes the activity immediately without changing the user's preference. */
export function clearDiscordRichPresence(): void {
  lastActivity = null;
  client.clearActivity();
}

export function shutdownDiscordRichPresence(): void {
  client.shutdown();
}
