// electron/templateInstaller.ts
//
// Puts the shipped filter templates into an install and keeps them there:
// the launch reconcile against the install ledger (templateReconcile.ts has
// the rules), the decisions the post-update notice asks about, and the plugin
// install's seeding and complete reset.

import * as path from 'path';
import * as fs from 'fs-extra';
import * as TOML from '@iarna/toml';
import { app } from 'electron';
import { logger } from './logger';
import { PATHS } from './constants';
import { configManager } from './configManager';
import { getBundledBasePath } from './utils';
import { hasPluginFilterTemplates, selectPluginFilterTemplates } from './pluginFilterCatalog';
import { shippedTemplateDigest } from './shippedTemplateDigest';
import { isDecision, planTemplateReconcile, type TemplateDecision, type TemplateState } from './templateReconcile';
import { readLedger, writeLedger, type InstallLedger, type UpdateReportDraft } from './installLedger';

const coreTemplateDirectory = (bundledBasePath: string) => path.join(bundledBasePath, 'include', 'filter_templates');
const pluginTemplateDirectory = (bundledBasePath: string) => path.join(bundledBasePath, 'include', 'plugins', 'plugin_filters');

/**
 * The bundled templates: the ones this platform seeds, by path, and the name
 * of every one shipped on any platform.
 */
async function bundledTemplates(bundledBasePath: string): Promise<{ selected: Map<string, string>; all: Set<string> }> {
  const templateDirectories = [
    coreTemplateDirectory(bundledBasePath),
    ...(hasPluginFilterTemplates() ? [pluginTemplateDirectory(bundledBasePath)] : []),
  ];

  const selected = new Map<string, string>();
  const all = new Set<string>();
  for (const templateDirectory of templateDirectories) {
    if (!await fs.pathExists(templateDirectory)) {
      logger.warn(`Bundled filter templates not found at: ${templateDirectory}`);
      continue;
    }

    const sourceFiles = (await fs.readdir(templateDirectory)).filter(f => f.endsWith('.vkfilter'));
    sourceFiles.forEach(file => all.add(file));
    const isPluginCatalog = templateDirectory === pluginTemplateDirectory(bundledBasePath);
    const supported = isPluginCatalog ? selectPluginFilterTemplates(sourceFiles) : sourceFiles;
    for (const file of supported) selected.set(file, path.join(templateDirectory, file));
    logger.dependency(`Found ${supported.length} supported bundled filter template(s) in ${templateDirectory}`);
  }
  return { selected, all };
}

/** Every template file in a folder, by shippedTemplateDigest. */
async function digestTemplates(files: Iterable<[string, string]>): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  for (const [file, filePath] of files) {
    try {
      digests.set(file, shippedTemplateDigest(await fs.readFile(filePath)));
    } catch (error) {
      logger.warn(`Could not read filter template ${file}:`, error);
    }
  }
  return digests;
}

async function templateState(bundledBasePath: string, ledger: InstallLedger): Promise<{
  state: TemplateState;
  selected: Map<string, string>;
}> {
  const { selected, all } = await bundledTemplates(bundledBasePath);
  const installedFiles = await fs.pathExists(PATHS.FILTER_TEMPLATES)
    ? (await fs.readdir(PATHS.FILTER_TEMPLATES)).filter(f => f.endsWith('.vkfilter'))
    : [];

  return {
    selected,
    state: {
      bundled: await digestTemplates(selected),
      shippedAnywhere: all,
      installed: await digestTemplates(
        installedFiles.map(file => [file, path.join(PATHS.FILTER_TEMPLATES, file)]),
      ),
      ledger: ledger.templates,
      previousVersion: configManager.getAppVersion(),
    },
  };
}

/**
 * Seeds, updates and retires filter templates against the install ledger;
 * see templateReconcile.ts for the rules. What it does silently goes into
 * `report` when given one; what needs the user is left for the post-update
 * notice, which asks for it through getTemplateDecisions.
 */
export async function reconcileTemplates(bundledBasePath: string, report?: UpdateReportDraft): Promise<void> {
  logger.dependency('Reconciling filter templates');
  await fs.ensureDir(PATHS.FILTER_TEMPLATES);

  const ledger = await readLedger();
  const { state, selected } = await templateState(bundledBasePath, ledger);
  // A missing bundle would read every installed template as dropped.
  if (selected.size === 0) {
    logger.warn('No bundled filter templates found; leaving installed templates alone');
    return;
  }

  const appVersion = app.getVersion();
  let decisions = 0;
  for (const action of planTemplateReconcile(state)) {
    const destPath = path.join(PATHS.FILTER_TEMPLATES, action.file);
    try {
      switch (action.kind) {
        case 'seed':
        case 'restore':
        case 'update':
          // A file we could not read reads as absent; it may still hold an
          // edit, so a seed or restore never writes over one that exists.
          if (action.kind !== 'update' && await fs.pathExists(destPath)) {
            logger.warn(`Filter template ${action.file} could not be read; leaving it as it is`);
            break;
          }
          await fs.copy(selected.get(action.file)!, destPath, { overwrite: true });
          ledger.templates[action.file] = { digest: state.bundled.get(action.file)!, appVersion };
          (action.kind === 'update' ? report?.templatesUpdated : report?.templatesAdded)?.push(action.file);
          if (action.kind === 'restore') {
            // Recorded as installed, gone, and not deleted in the app: some
            // other process removed it. Loud, so a log shows when it happens.
            logger.warn(`Filter template ${action.file} was missing without being deleted in the app; restored it`);
          } else {
            logger.dependency(`${action.kind === 'seed' ? 'Copied' : 'Updated unmodified'} filter template: ${action.file}`);
          }
          break;
        case 'remove':
          await fs.remove(destPath);
          delete ledger.templates[action.file];
          report?.templatesRemoved.push(action.file);
          logger.dependency(`Removed filter template no longer shipped for this platform: ${action.file}`);
          break;
        case 'record':
          ledger.templates[action.file] = { digest: action.digest, appVersion };
          break;
        case 'forget':
          delete ledger.templates[action.file];
          break;
        default:
          decisions++;
          logger.dependency(`Filter template needs a decision (${action.kind}): ${action.file}`);
      }
    } catch (error) {
      logger.warn(`Could not ${action.kind} filter template ${action.file}:`, error);
    }
  }

  await writeLedger(ledger);
  logger.dependency(`Filter templates reconciled${decisions > 0 ? `; ${decisions} edited template(s) need a decision` : ''}`);
}

/**
 * Built-in filters the user deleted in the app: shipped for this platform,
 * marked deleted in the ledger, and not on disk. Launch never brings those
 * back, so this is the way to get them back.
 */
export async function getMissingBundledTemplates(): Promise<string[]> {
  const { state } = await templateState(getBundledBasePath(), await readLedger());
  return [...state.bundled.keys()]
    .filter(file => !state.installed.has(file) && state.ledger[file]?.deletedByUser)
    .sort();
}

/** Puts back every built-in filter the install has deleted; answers the files restored. */
export async function restoreMissingBundledTemplates(): Promise<string[]> {
  const missing = await getMissingBundledTemplates();
  if (missing.length === 0) return [];
  const ledger = await readLedger();
  for (const file of missing) delete ledger.templates[file];
  await writeLedger(ledger);
  // With no ledger entry and no file, the reconcile seeds them.
  await reconcileTemplates(getBundledBasePath());
  logger.dependency(`Restored ${missing.length} built-in filter template(s): ${missing.join(', ')}`);
  return missing;
}

async function templateName(filePath: string): Promise<string | undefined> {
  try {
    const parsed = TOML.parse(await fs.readFile(filePath, 'utf-8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** The edited templates the post-update notice asks about, with display names. */
export async function getTemplateDecisions(): Promise<TemplateDecision[]> {
  const { state } = await templateState(getBundledBasePath(), await readLedger());
  if (state.bundled.size === 0) return [];

  const decisions: TemplateDecision[] = [];
  for (const action of planTemplateReconcile(state).filter(isDecision)) {
    decisions.push({
      file: action.file,
      name: await templateName(path.join(PATHS.FILTER_TEMPLATES, action.file)) ?? action.file.replace(/\.vkfilter$/, ''),
      kind: action.kind,
      replacement: action.kind === 'edited-dropped' && action.replacement
        ? await templateName(path.join(PATHS.FILTER_TEMPLATES, action.replacement)) ?? action.replacement.replace(/\.vkfilter$/, '')
        : undefined,
    });
  }
  return decisions;
}

/**
 * Carries out the user's answer about one edited template. Anything that
 * would lose their copy backs it up first, to config/template-backups.
 */
export async function resolveTemplateDecision(file: string, choice: 'replace' | 'keep' | 'remove'): Promise<{ backupPath?: string }> {
  if (path.basename(file) !== file || !file.endsWith('.vkfilter')) {
    throw new Error(`Not a filter template: ${file}`);
  }

  const ledger = await readLedger();
  const { state, selected } = await templateState(getBundledBasePath(), ledger);
  const action = planTemplateReconcile(state).find(candidate => candidate.file === file);
  if (!action || !isDecision(action)) {
    // Already settled, by an earlier click or an edit since the notice opened.
    return {};
  }

  const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
  const appVersion = app.getVersion();
  const backup = async (): Promise<string> => {
    const backupDir = path.join(PATHS.CONFIG, 'template-backups', `before-${appVersion}`);
    await fs.ensureDir(backupDir);
    const backupPath = path.join(backupDir, file);
    await fs.copy(destPath, backupPath, { overwrite: true });
    return backupPath;
  };

  let backupPath: string | undefined;
  if (action.kind === 'edited-outdated' && choice === 'replace') {
    backupPath = await backup();
    await fs.copy(selected.get(file)!, destPath, { overwrite: true });
    ledger.templates[file] = { digest: state.bundled.get(file)!, appVersion };
  } else if (action.kind === 'edited-outdated' && choice === 'keep') {
    // Their edit now counts as based on this release's body, so it is asked
    // about again only when a later release changes it.
    ledger.templates[file] = { digest: state.bundled.get(file)!, appVersion };
  } else if (action.kind === 'edited-dropped' && choice === 'remove') {
    backupPath = await backup();
    await fs.remove(destPath);
    delete ledger.templates[file];
  } else if (action.kind === 'edited-dropped' && choice === 'keep') {
    ledger.templates[file] = { digest: state.installed.get(file)!, appVersion, keptDropped: true };
  } else {
    throw new Error(`Cannot ${choice} ${file}: ${action.kind}`);
  }

  await writeLedger(ledger);
  logger.dependency(`Filter template ${file}: ${choice}${backupPath ? ` (backup at ${backupPath})` : ''}`);
  return { backupPath };
}

/**
 * The plugin install's template step. A partial install copies only the
 * plugin templates that are missing, leaving one the user deleted deleted;
 * bringing an untouched template up to date, and asking about an edited
 * one, is the launch reconcile's job. A complete install resets every
 * shipped template, core ones too (resetShippedTemplates).
 */
export async function installPluginTemplates(mode: 'partial' | 'complete', onStart?: () => void): Promise<void> {
  if (!hasPluginFilterTemplates()) {
    logger.info('Bundled plugin filter templates are unavailable on this platform; skipping copy');
    return;
  }

  const bundledBasePath = getBundledBasePath();
  const pluginFiltersFolder = pluginTemplateDirectory(bundledBasePath);
  if (!await fs.pathExists(pluginFiltersFolder)) {
    logger.info('No plugin_filters folder found, skipping filter template copy');
    return;
  }

  onStart?.();
  await fs.ensureDir(PATHS.FILTER_TEMPLATES);

  const files = selectPluginFilterTemplates(
    (await fs.readdir(pluginFiltersFolder)).filter(file => file.endsWith('.vkfilter')),
  );
  if (files.length === 0) {
    logger.info('No filter templates found in plugin_filters folder');
    return;
  }
  logger.info(`Found ${files.length} supported filter template(s) to copy`);

  if (mode === 'complete') {
    const coreFolder = coreTemplateDirectory(bundledBasePath);
    const coreFiles = await fs.pathExists(coreFolder)
      ? (await fs.readdir(coreFolder)).filter(file => file.endsWith('.vkfilter'))
      : [];
    await resetShippedTemplates([
      ...coreFiles.map(file => path.join(coreFolder, file)),
      ...files.map(file => path.join(pluginFiltersFolder, file)),
    ]);
    logger.info('Filter template copy completed');
    return;
  }

  const ledger = await readLedger().catch(() => undefined);
  for (const file of files) {
    const sourcePath = path.join(pluginFiltersFolder, file);
    const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
    if (ledger?.templates[file]?.deletedByUser) continue;

    const stats = await fs.stat(sourcePath);
    if (stats.isFile() && !await fs.pathExists(destPath)) {
      try {
        await fs.copy(sourcePath, destPath, { overwrite: false });
        logger.info(`Copied filter template: ${file}`);
      } catch (error) {
        logger.error(`Failed to copy filter template ${file}:`, error);
      }
    }
  }
  logger.info('Filter template copy completed');
}

/**
 * A complete reinstall: every shipped template back to stock. An edited copy
 * goes to template-backups first, a deleted one comes back, and the ledger
 * records each as ours and untouched. Templates of the user's own are other
 * files and never touched.
 */
async function resetShippedTemplates(sourcePaths: string[]): Promise<void> {
  const ledger = await readLedger();
  const backupDir = path.join(PATHS.CONFIG, 'template-backups', `reinstall-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const sourcePath of sourcePaths) {
    const file = path.basename(sourcePath);
    const destPath = path.join(PATHS.FILTER_TEMPLATES, file);
    try {
      const source = await fs.readFile(sourcePath);
      if (await fs.pathExists(destPath)) {
        const current = await fs.readFile(destPath);
        if (shippedTemplateDigest(current) !== shippedTemplateDigest(source)) {
          await fs.ensureDir(backupDir);
          await fs.writeFile(path.join(backupDir, file), current);
          logger.info(`Backed up edited filter template before resetting it: ${file}`);
        }
      }
      await fs.writeFile(destPath, source);
      ledger.templates[file] = { digest: shippedTemplateDigest(source), appVersion: app.getVersion() };
    } catch (error) {
      logger.error(`Failed to reset filter template ${file}:`, error);
    }
  }
  await writeLedger(ledger);
}
