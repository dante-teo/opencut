import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MediaError,
  enhancementBackendVersion,
  interpolationBackendVersion,
  probeRecipeMedia,
  recipeBackendVersion,
  runEnhancement,
  runInterpolation,
  runRecipeProcess,
} from '@opencut/media';
import type { RecipeProcessLimits } from '@opencut/media';
import { fingerprintFile, hashJson } from './video-integrity.js';
import { videoInputIdentity } from './video-input.js';
import type { IdentifiedMedia } from './video-input.js';
import {
  isEnhancementStep,
  isInterpolationStep,
} from './video-recipe-schema.js';
import type { RecipeFormat } from './video-recipe-schema.js';
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
  format: RecipeFormat;
  status: 'started' | 'processing' | 'completed' | 'cache-hit';
  seconds?: number;
}

export interface RecipeRecovery {
  sources: ReadonlyMap<string, Awaited<ReturnType<typeof fingerprintFile>>>;
  record(
    stage: Pick<VideoProcessingProgress, 'assetId' | 'step' | 'key' | 'format'>,
  ): Promise<void>;
}

const MiB = 1024 * 1024;
type ProcessingLimits = RecipeProcessLimits & {
  highQualityNativeBytes: number;
};

export async function processVideoRecipes(
  recipes: readonly RecipeInput[],
  options: VideoProcessingOptions = {},
  signal?: AbortSignal,
  recovery?: RecipeRecovery,
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
  let enhancementVersion:
    ReturnType<typeof enhancementBackendVersion> | undefined;
  const backends = {
    ffmpeg,
    enhancement: () =>
      (enhancementVersion ??= enhancementBackendVersion(processingSignal)),
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
            recovery,
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
    enhancement: () => ReturnType<typeof enhancementBackendVersion>;
    interpolation: () => ReturnType<typeof interpolationBackendVersion>;
  },
  limits: ProcessingLimits,
  signal: AbortSignal,
  onProgress?: VideoProcessingOptions['onProgress'],
  recovery?: RecipeRecovery,
) {
  let current = input;
  // A partial final packet affects ffprobe's average, but not the cadence of
  // an interpolation result or subsequent steps that preserve its frame rate.
  let declaredCadence: number | null = null;
  const saved = recovery?.sources.get(input.metadata.path);
  let dependency = (
    saved?.identity === input.identity
      ? saved
      : await fingerprintFile(input.metadata.path, signal)
  ).sha256;
  assertCurrent(input);
  for (const [index, { parameters }] of steps.entries()) {
    try {
      signal.throwIfAborted();
      assertCurrent(current);
      // Old derived-media manifests predate the color and timing fields
      // needed by VideoToolbox. Refresh those inputs before planning the step.
      const enhancement = isEnhancementStep(parameters) ? parameters : null;
      const source =
        (enhancement && current.metadata.video?.hasHdrMetadata === undefined) ||
        (isInterpolationStep(parameters) &&
          current.metadata.video?.colorRange === undefined)
          ? await probeRecipeMedia(current.metadata.path, signal)
          : current.metadata;
      const inputMedia = recipeMedia(source);
      inputMedia.frameRate = declaredCadence ?? inputMedia.frameRate;
      const step = resolveRecipeStep(inputMedia, parameters);
      const key = hashJson([
        3,
        backends.ffmpeg,
        dependency,
        inputMedia,
        step.parameters,
        step.format,
        ...(step.interpolation ? await backends.interpolation() : []),
        ...(enhancement ? await backends.enhancement() : []),
      ]);
      const report = (
        status: VideoProcessingProgress['status'],
        seconds?: number,
      ) => {
        onProgress?.({
          assetId,
          step: index,
          key,
          format: step.format,
          status,
          ...(seconds !== undefined && { seconds }),
        });
      };
      await recovery?.record({
        assetId,
        step: index,
        key,
        format: step.format,
      });
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
          else if (enhancement) {
            const enhancementLimits =
              enhancement.type === 'superResolution' &&
              enhancement.quality === 'high'
                ? { ...limits, maxNativeBytes: limits.highQualityNativeBytes }
                : limits;
            await runEnhancement(
              source,
              enhancement,
              output,
              enhancementLimits,
              signal,
              progress,
            );
          } else
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
      dependency = `${key}:${entry.sha256}`;
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

export function processingSettings(options: VideoProcessingOptions) {
  const concurrency = positive('concurrency', options.concurrency ?? 1, 16);
  const directory = resolve(
    options.cacheDirectory ??
      join(
        process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
        'opencut',
        'recipes-v3',
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
  const limits: ProcessingLimits = {
    highQualityNativeBytes: options.maxNativeBytes ?? 2048 * MiB,
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
