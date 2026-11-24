import { patchVideoTimeline, timelinePatchSchema } from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { readJsonArgument, readParams } from './json-argument.js';
import { UsageError } from './usage.js';
import { loadVideo } from './video.js';

export async function runTimelinePatch(file: string, values: CommandOptions) {
  const { edit, output, 'dry-run': dryRun } = values;
  if (!edit || Boolean(output) === Boolean(dryRun))
    throw new UsageError(commandUsage('timeline patch'));
  await withCommandCancellation(async (signal) => {
    const parsed = timelinePatchSchema.safeParse(
      await readJsonArgument('edit', edit, signal),
    );
    if (!parsed.success)
      throw new UsageError(
        parsed.error.issues
          .map(
            ({ path, message }) => '--edit ' + path.join('.') + ': ' + message,
          )
          .join('\n'),
      );
    const video = await loadVideo(file, {
      params: await readParams(values.params, signal),
      signal,
    });
    const result = await patchVideoTimeline(video, parsed.data, {
      output,
      signal,
    });
    console.log(JSON.stringify({ ...result, dryRun: !!dryRun }, null, 2));
  });
}
