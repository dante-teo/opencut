import { batchRenderVideo } from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage } from './commands.js';
import type { CommandOptions } from './commands.js';
import { readJsonArgument } from './json-argument.js';
import { parseProcessingControls } from './recipe-options.js';
import { parseRenderControls } from './render-options.js';
import { positiveIntegerOption, UsageError } from './usage.js';

export async function runBatch(file: string, values: CommandOptions) {
  const { variants, 'output-dir': outputDirectory, only, json } = values;
  if (!variants?.trim() || !outputDirectory?.trim())
    throw new UsageError(`Usage: ${commandUsage('batch')}`);
  const concurrency = positiveIntegerOption('concurrency', values.concurrency);
  const maxTemporaryBytes = positiveIntegerOption(
    'temp-bytes',
    values['temp-bytes'],
  );
  const maxNativeBytes = positiveIntegerOption(
    'memory-bytes',
    values['memory-bytes'],
  );
  const selected = only?.split(',').map((id) => id.trim());
  if (selected?.some((id) => !id))
    throw new UsageError(
      '--only requires a comma-separated list of variant IDs.',
    );
  const render = parseRenderControls(values);
  const processing = parseProcessingControls(values);
  await withCommandCancellation(async (signal) => {
    const manifest = await readJsonArgument('variants', variants, signal);
    const result = await batchRenderVideo(file, manifest, {
      outputDirectory,
      ...(selected && { only: selected }),
      concurrency,
      failFast: values['fail-fast'],
      maxTemporaryBytes,
      maxNativeBytes,
      render,
      processing,
      signal,
      onProgress(event) {
        if (json) {
          process.stderr.write(
            JSON.stringify({ event: 'batch-progress', ...event }) + '\n',
          );
          return;
        }
        if (event.status === 'finished') {
          const result = event.result;
          const detail =
            result.status === 'completed'
              ? result.output
              : result.status === 'failed'
                ? result.error.message
                : result.reason;
          process.stderr.write(`${event.id}: ${result.status} (${detail})\n`);
        } else if (
          event.status === 'compiling' ||
          event.status === 'rendering'
        ) {
          process.stderr.write(`${event.id}: ${event.status}\n`);
        }
      },
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else
      console.log(
        `Rendered ${result.variants.filter(({ status }) => status === 'completed').length} of ${result.variants.length} variants.`,
      );
    if (!result.ok) process.exitCode = 1;
  });
}
