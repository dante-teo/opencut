import { motionEditSchema, saveMotionDefinition } from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage } from './commands.js';
import type { CommandOptions } from './commands.js';
import { readJsonArgument, readParams } from './json-argument.js';
import { UsageError } from './usage.js';
import { loadVideo } from './video.js';

export async function runMotionEdit(file: string, values: CommandOptions) {
  const { edit, output, component, json } = values;
  if (!edit?.trim() || !output?.trim())
    throw new UsageError(`Usage: ${commandUsage('timeline edit-graphic')}`);

  await withCommandCancellation(async (signal) => {
    const result = motionEditSchema.safeParse(
      await readJsonArgument('edit', edit, signal),
    );
    if (!result.success)
      throw new UsageError(
        result.error.issues
          .map(({ path, message }) => `--edit ${path.join('.')}: ${message}`)
          .join('\n'),
      );
    if ((result.data.operation === 'import') !== Boolean(component))
      throw new UsageError(
        '--component is required for an import edit and only applies to that operation.',
      );
    const video = await loadVideo(file, {
      signal,
      params: await readParams(values.params, signal),
    });
    const path = await saveMotionDefinition(video, output, result.data, {
      component,
      signal,
    });
    console.log(
      json
        ? JSON.stringify({ ok: true, path })
        : `Saved graphic revision: ${path}`,
    );
  });
}
