import { z } from 'zod';

const safePath = z.string().min(1).max(240).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && p.split('/').every(s => s && s !== '.' && s !== '..'), 'Unsafe component path');
const asset = z.object({ path: safePath, url: z.string().url().refine(value => {
  const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && ['github.com', 'raw.githubusercontent.com', 'www.python.org', 'www.gyan.dev'].includes(u.hostname);
}), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(16 * 1024 ** 3) });
export const componentEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), version: z.string().regex(/^[a-zA-Z0-9._-]{1,60}$/),
  name: z.string().min(1).max(160), kind: z.enum(['model', 'ffmpeg', 'runtime', 'filters']),
  platforms: z.array(z.enum(['win32', 'linux'])).min(1), vendors: z.array(z.enum(['nvidia', 'amd', 'intel', 'unknown'])).min(1),
  channel: z.enum(['stable', 'experimental']), notes: z.string().max(2000), license: z.string().max(300),
  files: z.array(asset).min(1).max(4096),
  model: z.object({ file: safePath, adapter: z.enum(['rgb-image-v1', 'rgb-window-v1']), type: z.enum(['image', 'vsr']), scale: z.number().int().min(1).max(8), frames: z.number().int().positive().max(63).refine(n => n % 2 === 1), spatialMultiple: z.number().int().min(1).max(256) }).strict().optional(),
  runtime: z.object({ python: safePath, smokeModel: safePath, packages: z.record(z.string(), z.string().regex(/^[a-zA-Z0-9.+_-]+$/)), vapoursynthCore: z.number().int().positive() }).optional(),
  replaces: z.record(z.string(), z.array(z.string().regex(/^[a-f0-9]{64}$/))).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.model && (entry.model.adapter === 'rgb-window-v1') !== (entry.model.frames > 1)) ctx.addIssue({ code: 'custom', message: 'Model adapter and temporal window disagree' });
  const paths = entry.files.map(f => f.path.toLowerCase());
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: 'Duplicate component paths' });
  if (entry.kind === 'model' && (!entry.model || !entry.files.some(f => f.path === entry.model?.file))) ctx.addIssue({ code: 'custom', message: 'Missing model descriptor/file' });
  if (entry.kind === 'runtime' && (!entry.runtime || entry.runtime.python !== 'python.exe' || !entry.files.some(f => f.path === entry.runtime?.smokeModel) || !entry.platforms.every(p => p === 'win32'))) ctx.addIssue({ code: 'custom', message: 'Runtime bundles must be tested portable Windows environments' });
  if (entry.kind === 'ffmpeg' && (!paths.includes('bin/ffmpeg.exe') || !paths.includes('bin/ffprobe.exe') || !entry.platforms.every(p => p === 'win32'))) ctx.addIssue({ code: 'custom', message: 'FFmpeg bundles require both Windows executables' });
});
export const catalogSchema = z.object({ schema: z.literal(1), client: z.literal(1), revision: z.number().int().nonnegative(), components: z.array(componentEntrySchema).max(200) }).superRefine((data, ctx) => {
  const keys = data.components.map(c => c.id + '@' + c.version);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate component versions' });
});
export type ComponentEntry = z.infer<typeof componentEntrySchema>;
export type ComponentCatalog = z.infer<typeof catalogSchema>;
export interface ComponentSnapshot { catalog: ComponentCatalog; installed: Record<string, string>; pendingRestart: boolean; }
