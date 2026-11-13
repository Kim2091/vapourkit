import { z } from 'zod';
/** Execution preferences; zero requests preserves vspipe's automatic scheduling. */
export const pipelineSettingsSchema = z.object({
  optimizeAiChains: z.boolean().default(false),
  requests: z.number().int().min(0).max(32).default(0),
  previewHeight: z.number().int().min(180).max(1080).default(720),
  previewFps: z.number().min(0.1).max(5).default(1),
});
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>;
export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = pipelineSettingsSchema.parse({});
