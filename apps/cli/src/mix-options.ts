import { videoMixEditSchema } from '@opencut/core/video';
import type { CommandOptions } from './commands.js';
import { readJsonArgument } from './json-argument.js';
import { UsageError } from './usage.js';

export async function readMixControls(
  values: CommandOptions,
  signal: AbortSignal,
) {
  const comparison = values['mix-comparison'];
  if (
    comparison !== undefined &&
    comparison !== 'before' &&
    comparison !== 'after'
  )
    throw new UsageError('--mix-comparison must be before or after.');
  const audioMixCacheDirectory = values['mix-cache'];
  if (audioMixCacheDirectory !== undefined && !audioMixCacheDirectory.trim())
    throw new UsageError('--mix-cache requires a directory.');
  const path = values['mix-settings'];
  const audioMixEdit =
    path === undefined
      ? undefined
      : videoMixEditSchema.parse(
          await readJsonArgument('mix-settings', path, signal),
        );
  return {
    audioMixEdit,
    audioComparison: comparison as 'before' | 'after' | undefined,
    audioMixCacheDirectory,
  };
}
