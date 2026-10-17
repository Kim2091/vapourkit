// src/hooks/useDiscordActivity.ts - What Discord Rich Presence says the app is doing.

import { useEffect, useRef, useState } from 'react';
import type { DiscordRichPresenceActivity, UpscaleProgress, VideoInfo } from '../electron';

interface UseDiscordActivityOptions {
  isSetupComplete: boolean;
  privacyMode: boolean;
  isProcessing: boolean;
  upscaleProgress: UpscaleProgress | null;
  videoInfo: VideoInfo | null;
  publishDiscordRichPresence: (activity: DiscordRichPresenceActivity) => Promise<void>;
  clearDiscordRichPresence: () => Promise<void>;
}

/** Publish the app's activity to Discord as it changes; nothing at all in privacy mode. */
export function useDiscordActivity({
  isSetupComplete,
  privacyMode,
  isProcessing,
  upscaleProgress,
  videoInfo,
  publishDiscordRichPresence,
  clearDiscordRichPresence,
}: UseDiscordActivityOptions): void {
  const [discordPresenceStartTimestamp, setDiscordPresenceStartTimestamp] = useState<number | undefined>();
  const discordPresenceHiddenForPrivacyRef = useRef(false);
  useEffect(() => {
    setDiscordPresenceStartTimestamp(isProcessing ? Math.floor(Date.now() / 1000) : undefined);
  }, [isProcessing]);

  useEffect(() => {
    if (!isSetupComplete) return;

    if (privacyMode) {
      if (!discordPresenceHiddenForPrivacyRef.current) {
        discordPresenceHiddenForPrivacyRef.current = true;
        void clearDiscordRichPresence();
      }
      return;
    }

    discordPresenceHiddenForPrivacyRef.current = false;

    if (isProcessing) {
      const percentage = upscaleProgress?.percentage;
      const state = typeof percentage === 'number'
        ? `${Math.max(0, Math.min(100, Math.round(percentage)))}% complete`
        : 'Processing';
      void publishDiscordRichPresence({
        details: 'Upscaling a video',
        state,
        startTimestamp: discordPresenceStartTimestamp,
      });
      return;
    }

    void publishDiscordRichPresence(videoInfo
      ? {
          details: 'Video loaded',
          state: 'Ready to upscale',
        }
      : {
          details: 'Ready to upscale',
          state: 'Waiting for a video',
        });
  }, [
    discordPresenceStartTimestamp,
    clearDiscordRichPresence,
    isProcessing,
    isSetupComplete,
    privacyMode,
    publishDiscordRichPresence,
    upscaleProgress?.percentage,
    videoInfo,
  ]);
}
