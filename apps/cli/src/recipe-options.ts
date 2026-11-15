import type { VideoProcessingOptions } from '@opencut/core/video';
import { positiveIntegerOption, UsageError } from './usage.js';

export const processingOptionTypes = {
  'recipe-cache': { type: 'string' },
  'recipe-workers': { type: 'string' },
  'recipe-temp-bytes': { type: 'string' },
  'recipe-memory-bytes': { type: 'string' },
  'recipe-buffered-frames': { type: 'string' },
  'recipe-max-pixels': { type: 'string' },
  'recipe-timeout-ms': { type: 'string' },
} as const;

export const processingOptionHelp = `  --recipe-cache <directory> --recipe-workers <count> --recipe-temp-bytes <bytes>
  --recipe-memory-bytes <bytes> --recipe-buffered-frames <count> --recipe-max-pixels <count>
  --recipe-timeout-ms <milliseconds>`;

export function parseProcessingControls(
  values: Partial<
    Record<keyof typeof processingOptionTypes, string | undefined>
  >,
): VideoProcessingOptions {
  const integer = (key: keyof typeof processingOptionTypes) =>
    positiveIntegerOption(key, values[key]);
  const cacheDirectory = values['recipe-cache'];
  if (cacheDirectory !== undefined && !cacheDirectory.trim())
    throw new UsageError('--recipe-cache requires a directory.');
  return {
    cacheDirectory,
    concurrency: integer('recipe-workers'),
    maxTemporaryBytes: integer('recipe-temp-bytes'),
    maxNativeBytes: integer('recipe-memory-bytes'),
    maxBufferedFrames: integer('recipe-buffered-frames'),
    maxPixels: integer('recipe-max-pixels'),
    timeoutMs: integer('recipe-timeout-ms'),
  };
}
