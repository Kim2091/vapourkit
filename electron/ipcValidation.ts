// electron/ipcValidation.ts
import { ipcMain } from 'electron';
import { z, ZodSchema } from 'zod';
import { logger } from './logger';

/**
 * Registers an IPC handler with Zod schema validation on the arguments.
 * For handlers that take no arguments, pass z.undefined() as the schema.
 * For handlers that take a single argument, pass the schema for that argument.
 * For handlers that take multiple arguments, pass z.tuple([...]) with the schemas.
 */
export function handleValidated<TSchema extends ZodSchema, TResult>(
  channel: string,
  schema: TSchema,
  handler: (args: z.infer<TSchema>) => Promise<TResult>
): void {
  ipcMain.handle(channel, async (_event, ...rawArgs) => {
    const input = rawArgs.length <= 1 ? rawArgs[0] : rawArgs;
    const parsed = schema.safeParse(input);

    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      logger.error(`IPC validation failed for '${channel}': ${issues}`);
      throw new Error(`Invalid arguments for '${channel}': ${issues}`);
    }

    return handler(parsed.data);
  });
}
