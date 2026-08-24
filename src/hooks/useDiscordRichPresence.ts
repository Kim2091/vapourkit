import { useCallback, useEffect, useState } from 'react';
import type { DiscordRichPresenceActivity, DiscordRichPresenceSettings } from '../electron';

const DEFAULT_SETTINGS: DiscordRichPresenceSettings = { enabled: false };

export function useDiscordRichPresence(isSetupComplete: boolean) {
  const [discordRichPresenceSettings, setDiscordRichPresenceSettings] = useState<DiscordRichPresenceSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    if (!isSetupComplete) return;

    void window.electronAPI.getDiscordRichPresenceSettings()
      .then(setDiscordRichPresenceSettings)
      .catch(error => console.error('Failed to load Discord Rich Presence settings:', error));
  }, [isSetupComplete]);

  const updateDiscordRichPresenceSettings = useCallback(async (settings: DiscordRichPresenceSettings) => {
    const result = await window.electronAPI.setDiscordRichPresenceSettings(settings);
    if (result.success) setDiscordRichPresenceSettings(settings);
    return result;
  }, []);

  const publishDiscordRichPresence = useCallback(async (activity: DiscordRichPresenceActivity): Promise<void> => {
    try {
      await window.electronAPI.setDiscordRichPresenceActivity(activity);
    } catch (error) {
      // Discord is optional, so it should never interfere with processing.
      console.debug('Unable to update Discord Rich Presence:', error);
    }
  }, []);

  const clearDiscordRichPresence = useCallback(async (): Promise<void> => {
    try {
      await window.electronAPI.clearDiscordRichPresence();
    } catch (error) {
      console.debug('Unable to clear Discord Rich Presence:', error);
    }
  }, []);

  return {
    discordRichPresenceSettings,
    updateDiscordRichPresenceSettings,
    publishDiscordRichPresence,
    clearDiscordRichPresence,
  };
}
