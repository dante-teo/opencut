import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MediaError,
  interpolationBackendVersion,
  probeRecipeMedia,
  recipeBackendVersion,
  runInterpolation,
  runRecipeProcess,
} from '@opencut/media';
import type { RecipeProcessLimits } from '@opencut/media';
import { videoInputIdentity } from './video-input.js';
import type { IdentifiedMedia } from './video-input.js';
import { isInterpolationStep } from './video-recipe-schema.js';
import { materializeRecipeEntry } from './video-recipe-cache.js';
import {
  recipeArguments,
  recipeMedia,
  recipeStepError,
  resolveRecipeStep,
  validateRecipeOutput,
} from './video-recipe.js';
import type { RecipeInput, RecipeMedia } from './video-recipe.js';

export interface VideoProcessingOptions {
  cacheDirectory?: string | undefined;
  concurrency?: number | undefined;
  maxTemporaryBytes?: number | undefined;
  maxNativeBytes?: number | undefined;
  maxBufferedFrames?: number | undefined;
  maxPixels?: number | undefined;
  timeoutMs?: number | undefined;
  onProgress?: (event: VideoProcessingProgress) => void;
}

export interface VideoProcessingProgress {
  assetId: string;
  step: number;
  key: string;
  status: 'started' | 'processing' | 'completed' | 'cache-hit';
  seconds?: number;
}

const MiB = 1024 * 1024;

export async function processVideoRecipes(
  recipes: readonly RecipeInput[],
  options: VideoProcessingOptions = {},
  signal?: AbortSignal,
) {
  const results = new Map<string, IdentifiedMedia>();
  signal?.throwIfAborted();
  if (!recipes.length) return results;

  const controller = new AbortController();
  const processingSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const { concurrency, limits, directory } = processingSettings(options);
  const ffmpeg = await recipeBackendVersion(processingSignal);
  let interpolationVersion:
    ReturnType<typeof interpolationBackendVersion> | undefined;
  const backends = {
    ffmpeg,
    interpolation: () =>
      (interpolationVersion ??= interpolationBackendVersion(processingSignal)),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cacheDirectory = await realpath(directory);
  const jobs = recipes.values();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, recipes.length) }, async () => {
      try {
        for (const recipe of jobs) {
          processingSignal.throwIfAborted();
          const result = await processRecipe(
            recipe,
            cacheDirectory,
            backends,
            limits,
            processingSignal,
            options.onProgress,
          );
          results.set(recipe.inspection.assetId, result);
        }
      } catch (error) {
        controller.abort(error);
      }
    }),
  );
  processingSignal.throwIfAborted();
  return results;
}

async function processRecipe(
  { input, inspection: { assetId, steps } }: RecipeInput,
  directory: string,
  backends: {
    ffmpeg: string;
    interpolation: () => ReturnType<typeof interpolationBackendVersion>;
  },
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onProgress?: VideoProcessingOptions['onProgress'],
) {
  let current = input;
  // A partial final packet affects ffprobe's average, but not the cadence of
  // an interpolation result or subsequent steps that preserve its frame rate.
  let declaredCadence: number | null = null;
  let dependency = JSON.stringify([
    input.metadata.path,
    input.identity,
    recipeMedia(input.metadata),
  ]);
  for (const [index, { parameters }] of steps.entries()) {
    try {
      signal.throwIfAborted();
      assertCurrent(current);
      // Old derived-media manifests predate the color and timing fields
      // needed by VideoToolbox. Refresh those inputs before planning the step.
      const source =
        isInterpolationStep(parameters) &&
        current.metadata.video?.colorRange === undefined
          ? await probeRecipeMedia(current.metadata.path, signal)
          : current.metadata;
      const inputMedia = recipeMedia(source);
      inputMedia.frameRate = declaredCadence ?? inputMedia.frameRate;
      const step = resolveRecipeStep(inputMedia, parameters);
      const key = createHash('sha256')
        .update(
          JSON.stringify([
            2,
            backends.ffmpeg,
            dependency,
            step.parameters,
            step.format,
            ...(step.interpolation ? await backends.interpolation() : []),
          ]),
        )
        .digest('hex');
      const report = (
        status: VideoProcessingProgress['status'],
        seconds?: number,
      ) => {
        onProgress?.({
          assetId,
          step: index,
          key,
          status,
          ...(seconds !== undefined && { seconds }),
        });
      };
      const { entry, reused } = await materializeRecipeEntry(
        directory,
        key,
        step.format,
        signal,
        async (output) => {
          assertCurrent(current);
          if (
            step.media.kind !== 'audio' &&
            [inputMedia, step.media].some(
              (media) => pixels(media) > limits.maxPixels,
            )
          )
            throw new MediaError(
              'Recipe step exceeds its decoded pixel limit.',
            );
          report('started');
          const progress = (seconds: number) => report('processing', seconds);
          if (step.interpolation)
            await runInterpolation(
              source,
              step.interpolation,
              output,
              limits,
              signal,
              progress,
            );
          else
            await runRecipeProcess(
              recipeArguments(source, step, output),
              limits,
              signal,
              progress,
            );
          const info = await lstat(output);
          if (
            !info.isFile() ||
            !info.size ||
            info.size > limits.maxTemporaryBytes
          )
            throw new MediaError(
              'Recipe output is empty or exceeds its temporary file limit.',
            );
          const metadata = await probeRecipeMedia(output, signal);
          validateRecipeOutput(source, metadata, step);
          assertCurrent(current);
          return metadata;
        },
      );
      assertCurrent(current);
      report(reused ? 'cache-hit' : 'completed');
      dependency = key;
      current = entry;
      if (step.interpolation || declaredCadence !== null)
        declaredCadence = step.media.frameRate;
    } catch (cause) {
      signal.throwIfAborted();
      throw recipeStepError(assetId, index, cause);
    }
  }
  assertCurrent(input);
  return current;
}

function pixels({ width, height }: RecipeMedia) {
  return (width ?? 0) * (height ?? 0);
}

function processingSettings(options: VideoProcessingOptions) {
  const concurrency = positive('concurrency', options.concurrency ?? 1, 16);
  const directory = resolve(
    options.cacheDirectory ??
      join(
        process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
        'opencut',
        'recipes-v1',
      ),
  );
  const temporaryBytes = positive(
    'maxTemporaryBytes',
    options.maxTemporaryBytes ?? 4 * 1024 * MiB,
  );
  const perWorkerBytes = Math.floor(temporaryBytes / concurrency);
  if (perWorkerBytes < 1024)
    throw new MediaError(
      'Recipe temporary budget must allow at least 1024 bytes per worker.',
    );
  const limits: RecipeProcessLimits = {
    maxTemporaryBytes: perWorkerBytes,
    maxNativeBytes: positive(
      'maxNativeBytes',
      options.maxNativeBytes ?? 1024 * MiB,
    ),
    maxBufferedFrames: positive(
      'maxBufferedFrames',
      options.maxBufferedFrames ?? 32,
      256,
    ),
    maxPixels: positive(
      'maxPixels',
      options.maxPixels ?? 4096 * 2160,
      16384 * 16384,
    ),
    timeoutMs: positive(
      'timeoutMs',
      options.timeoutMs ?? 30 * 60_000,
      2_147_483_647,
    ),
  };
  return { directory, concurrency, limits };
}

function positive(name: string, value: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new MediaError(
      `Recipe ${name} must be an integer between 1 and ${max}.`,
    );
  return value;
}

function assertCurrent({ metadata: { path }, identity }: IdentifiedMedia) {
  if (videoInputIdentity(path) !== identity)
    throw new MediaError(`Media '${path}' changed during recipe processing.`);
}
