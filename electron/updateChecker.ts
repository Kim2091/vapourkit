import axios from 'axios';
import { app } from 'electron';
import { logger } from './logger';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  changelog: string;
  publishedAt: string;
}

const GITHUB_OWNER = 'Kim2091';
const GITHUB_REPO = 'vapourkit';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

export interface ParsedVersion {
  core: number[];
  prerelease: string | null;
}

/**
 * Parses "v0.16.1-nightly.2026-05-13" into { core: [0, 16, 1], prerelease: 'nightly.2026-05-13' }
 */
export function parseVersion(version: string): ParsedVersion {
  const clean = version.replace(/^v/, '');
  const dashIndex = clean.indexOf('-');
  const corePart = dashIndex === -1 ? clean : clean.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? null : clean.slice(dashIndex + 1);

  const core = corePart.split('.').map(part => {
    const num = parseInt(part, 10);
    return Number.isNaN(num) ? 0 : num;
  });

  return { core, prerelease };
}

/**
 * Returns true when the latest (stable) release is an actual upgrade from the
 * current version.
 *
 * Only the numeric version core is compared. Nightly builds carry a prerelease
 * suffix (e.g. 0.16.1-nightly.2026-05-13) that the old comparison mangled to
 * NaN→0, making the same-version stable release look newer — nightly users were
 * endlessly prompted to "update" to the stable build they were cut from. A
 * nightly is only offered an update once a stable release with a strictly newer
 * base version exists.
 */
export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);

  for (let i = 0; i < Math.max(current.core.length, latest.core.length); i++) {
    const currentNum = current.core[i] ?? 0;
    const latestNum = latest.core[i] ?? 0;

    if (latestNum > currentNum) return true;
    if (latestNum < currentNum) return false;
  }

  return false;
}

/**
 * Checks for updates by comparing current version with latest GitHub release
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    logger.info('Checking for updates...');
    
    // Get current version from package.json
    const currentVersion = app.getVersion();
    logger.info(`Current version: ${currentVersion}`);
    
    // Fetch latest release from GitHub
    const response = await axios.get<GitHubRelease>(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'vapourkit-app'
      },
      timeout: 10000 // 10 second timeout
    });
    
    const release = response.data;
    
    // Skip draft and prerelease versions
    if (release.draft || release.prerelease) {
      logger.info('Latest release is draft or prerelease, skipping');
      return {
        available: false,
        currentVersion,
        latestVersion: currentVersion,
        releaseUrl: '',
        changelog: '',
        publishedAt: ''
      };
    }
    
    const latestVersion = release.tag_name;
    logger.info(`Latest version: ${latestVersion}`);
    
    // Compare versions
    const isNewer = isUpdateAvailable(currentVersion, latestVersion);
    
    if (isNewer) {
      logger.info('Update available!');
      return {
        available: true,
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url,
        changelog: release.body || 'No changelog available.',
        publishedAt: release.published_at
      };
    } else {
      logger.info('No updates available');
      return {
        available: false,
        currentVersion,
        latestVersion: currentVersion,
        releaseUrl: '',
        changelog: '',
        publishedAt: ''
      };
    }
  } catch (error) {
    logger.error('Error checking for updates:', error);
    
    // Return no update available on error
    return {
      available: false,
      currentVersion: app.getVersion(),
      latestVersion: app.getVersion(),
      releaseUrl: '',
      changelog: '',
      publishedAt: ''
    };
  }
}

/**
 * Gets the GitHub releases page URL
 */
export function getReleasesPageUrl(): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
}
