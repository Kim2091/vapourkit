/**
 * Post-build script to rename 7z artifacts to PORTABLE naming
 * This runs after electron-builder completes the build
 */

import { renameSync, existsSync } from 'fs';
import { join } from 'path';
import { version } from '../package.json';

const releaseDir = join(__dirname, '..', 'release');
const oldName = `Vapourkit-${version}-vapourkit-gui.7z`;
const newName = `Vapourkit-${version}-PORTABLE.7z`;

const oldPath = join(releaseDir, oldName);
const newPath = join(releaseDir, newName);

if (existsSync(oldPath)) {
  renameSync(oldPath, newPath);
  console.log(`✓ Renamed ${oldName} to ${newName}`);
} else {
  console.log(`⚠ File ${oldName} not found, skipping rename`);
}
