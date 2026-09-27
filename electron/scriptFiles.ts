// electron/scriptFiles.ts
//
// How the files of a vs-scripts source are enumerated. Shared by the launch
// sync and by the generator that writes the manifest, which runs outside
// Electron, so nothing here may reach for the app or the logger.

import * as path from 'path';
import * as fs from 'fs-extra';

/** Every file under a directory, as forward-slashed paths relative to it. */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * The .py files of an extracted Hybrid scripts archive, by the flat name they
 * are installed under. The repository nests them in folders that vs-scripts
 * does not keep; where two share a name, the later one in walk order wins, as
 * it always has.
 */
export async function hybridScriptFiles(extracted: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const relative of await listFilesRecursive(extracted)) {
    if (relative.endsWith('.py')) files.set(path.posix.basename(relative), path.join(extracted, ...relative.split('/')));
  }
  return files;
}
