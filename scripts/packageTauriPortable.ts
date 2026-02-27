/**
 * Post-build script that zips the Tauri portable output into a distributable archive.
 *
 * Packed contents (beside the EXE):
 *   vapourkit.exe
 *   include/   (bundled read-only assets — models, plugins, filter templates, etc.)
 *
 * Output:  release/Vapourkit-{version}-TAURI-PORTABLE.7z
 */

import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { version } from '../package.json';

const root        = resolve(__dirname, '..');
const releaseDir  = join(root, 'release');
const tauriOut    = join(root, 'src-tauri', 'target', 'release');
const exePath     = join(tauriOut, 'vapourkit.exe');
const includeDir  = join(tauriOut, 'include');
const outFile     = join(releaseDir, `Vapourkit-${version}-TAURI-PORTABLE.7z`);

// ── Validate ──────────────────────────────────────────────────────────────────

if (!existsSync(exePath)) {
  console.error(`✗ vapourkit.exe not found at ${exePath}`);
  console.error('  Run "npm run build:tauri:portable" first.');
  process.exit(1);
}

if (!existsSync(includeDir)) {
  console.error(`✗ include/ not found at ${includeDir}`);
  console.error('  The Tauri build did not copy bundled resources.');
  process.exit(1);
}

// ── Prepare output dir ────────────────────────────────────────────────────────

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

if (existsSync(outFile)) {
  // Remove old archive so 7z doesn't append to it
  execSync(`del /f /q "${outFile}"`, { shell: 'cmd.exe' });
}

// ── Pack with 7-Zip ───────────────────────────────────────────────────────────
// Use 7z.exe from the VapourSynth portable dir if available, otherwise fall
// back to whatever 7z is on PATH.

const vsSevenZip = join(root, 'data', 'vapoursynth-portable', '7z.exe');
const sevenZip   = existsSync(vsSevenZip) ? vsSevenZip : '7z';

// Run 7z from the release dir so archive paths are relative (vapourkit.exe, include\...)
// Exclude the extracted (non-7z) plugin and script folders — only the .7z bundles are needed.
const excludes = [
  '-xr!include\\plugins\\plugins',       // extracted plugin binaries
  '-xr!include\\scripts\\extra_scripts', // extracted script files
].join(' ');

const cmd = `"${sevenZip}" a -t7z -mx=5 -mmt=on "${outFile}" vapourkit.exe include ${excludes}`;

console.log(`Packing Vapourkit ${version} portable archive…`);
console.log(`  Source  : ${tauriOut}`);
console.log(`  Output  : ${outFile}`);
console.log(`  Excludes: plugins\\plugins, scripts\\extra_scripts`);
console.log();

try {
  execSync(cmd, { stdio: 'inherit', cwd: tauriOut, shell: 'cmd.exe' });
  console.log(`\n✓ Created ${outFile}`);
} catch (err) {
  console.error('\n✗ 7z failed:', err);
  process.exit(1);
}
