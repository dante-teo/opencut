import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  MediaError,
  hostRenderResources,
  sampleMemoryPressure,
  withRenderBudget,
} from '@opencut/media';
import type { RenderProgress } from '@opencut/media';
import { z } from 'zod';
import type { VideoSourceProbes } from './video-assets.js';
import {
  isVideoDefinitionPath,
  VideoDefinitionError,
} from './video-definition.js';
import type { VideoParameters } from './video-definition.js';
import { compileVideoInput } from './video-files.js';
import type {
  VideoProcessingOptions,
  VideoProcessingProgress,
} from './video-processing.js';
import { renderCompiledVideo } from './video-render.js';
import type { CompiledVideoRenderOptions } from './video-render.js';

const variantId = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/,
    'Use 1–80 letters, digits, hyphens or underscores, starting with a letter or digit.',
  );
const outputName = z
  .string()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}\.mp4$/i,
    'Use an MP4 basename with 1–120 letters, digits, hyphens or underscores, starting with a letter or digit.',
  );
const variantSchema = z.strictObject({
  id: variantId,
  output: outputName.optional(),
  params: z.unknown().optional(),
});

export interface VideoVariant {
  readonly id: string;
  readonly output?: string;
  readonly params?: VideoParameters;
}

type Phase = 'compiling' | 'rendering';
type BatchError = { code: string; message: string };
type VariantResultBase = { id: string; output: string; elapsedSeconds: number };
export type VideoVariantResult = VariantResultBase &
  (
    | {
        status: 'completed';
        render: Awaited<ReturnType<typeof renderCompiledVideo>>;
      }
    | { status: 'failed'; phase: Phase; error: BatchError }
    | { status: 'cancelled'; reason: 'aborted' | 'fail-fast' }
  );

export type VideoBatchProgress = { id: string; output: string } & (
  | { status: Phase }
  | { status: 'recipe'; progress: VideoProcessingProgress }
  | { status: 'render'; progress: RenderProgress }
  | { status: 'finished'; result: VideoVariantResult }
);

export interface VideoBatchOptions {
  outputDirectory: string;
  /** Select IDs from the manifest to run again or render on their own. */
  only?: readonly string[];
  concurrency?: number | undefined;
  failFast?: boolean | undefined;
  signal?: AbortSignal | undefined;
  maxTemporaryBytes?: number | undefined;
  maxNativeBytes?: number | undefined;
  processing?: Omit<VideoProcessingOptions, 'concurrency' | 'onProgress'>;
  render?: Omit<
    CompiledVideoRenderOptions,
    'signal' | 'onProgress' | 'overwrite'
  >;
  onProgress?: (event: VideoBatchProgress) => void;
}

export interface VideoBatchResult {
  ok: boolean;
  variants: VideoVariantResult[];
}

const MiB = 1024 * 1024;

function boundedInteger(
  label: string,
  value: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new VideoDefinitionError(
      `Batch ${label} must be an integer between ${min} and ${max}.`,
    );
  return value;
}

function planVariants(variants: unknown, only: readonly string[] | undefined) {
  const parsed = z.array(variantSchema).min(1).safeParse(variants);
  if (!parsed.success)
    throw new VideoDefinitionError(
      parsed.error.issues
        .map(
          ({ path, message }) =>
            ['variants', ...path].join('.') + ': ' + message,
        )
        .join('\n'),
    );
  const ids = new Set<string>();
  const outputs = new Map<string, string>();
  const plan = parsed.data.map(({ id, params, output = `${id}.mp4` }) => {
    if (ids.has(id))
      throw new VideoDefinitionError(`Duplicate batch variant ID '${id}'.`);
    ids.add(id);
    const key = output.toLowerCase();
    const other = outputs.get(key);
    if (other !== undefined)
      throw new VideoDefinitionError(
        `Variants '${other}' and '${id}' both target '${output}'. Choose distinct output filenames.`,
      );
    outputs.set(key, id);
    // Snapshot SDK inputs before any async work; an invalid value fails only its variant.
    try {
      return { id, output, params: structuredClone(params) };
    } catch {
      return { id, output, invalidParams: true };
    }
  });
  if (only === undefined) return plan;
  if (!only.length)
    throw new VideoDefinitionError('Choose at least one variant ID to render.');
  for (const id of only)
    if (!ids.has(id))
      throw new VideoDefinitionError(`Unknown batch variant '${id}'.`);
  const selected = new Set(only);
  return plan.filter(({ id }) => selected.has(id));
}

/** Compile and render independent variants with bounded foreground work. */
export async function batchRenderVideo(
  file: string,
  variants: unknown,
  options: VideoBatchOptions,
): Promise<VideoBatchResult> {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts file.');
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new MediaError('Bounded batch rendering requires macOS or Linux.');
  const plan = planVariants(variants, options.only);
  const host = hostRenderResources();
  const pressure = options.signal?.aborted
    ? 'unavailable'
    : await sampleMemoryPressure();
  if (pressure === 'critical')
    throw new MediaError(
      'System memory pressure is critical. Free memory and retry the batch.',
    );
  const concurrency = Math.min(
    plan.length,
    boundedInteger('concurrency', options.concurrency ?? 1, 1, 8),
    pressure === 'warning' ? 1 : host.recipeWorkers,
  );
  const limits = {
    maxTemporaryBytes: Math.floor(
      boundedInteger(
        'temporary bytes',
        options.maxTemporaryBytes ?? 8192 * MiB,
        concurrency * 1024,
      ) / concurrency,
    ),
    maxNativeBytes: Math.floor(
      Math.min(
        boundedInteger(
          'native bytes',
          options.maxNativeBytes ?? host.nativeBudgetBytes,
          concurrency * 32 * MiB,
        ),
        host.nativeBudgetBytes,
      ) / concurrency,
    ),
  };
  const processing = {
    ...options.processing,
    concurrency: 1,
    maxTemporaryBytes: Math.min(
      options.processing?.maxTemporaryBytes ?? 4096 * MiB,
      limits.maxTemporaryBytes,
    ),
    maxNativeBytes: Math.min(
      options.processing?.maxNativeBytes ?? limits.maxNativeBytes,
      limits.maxNativeBytes,
    ),
  };
  const authoringHeapMb = Math.min(
    256,
    Math.floor(limits.maxNativeBytes / MiB),
  );
  const render = { ...options.render, overwrite: false };
  const probes: VideoSourceProbes = new Map();
  const controller = new AbortController();
  const { onProgress, failFast, signal: callerSignal } = options;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let progressError: { cause: unknown } | undefined;
  function emit(event: VideoBatchProgress) {
    if (progressError) return;
    try {
      onProgress?.(event);
    } catch (cause) {
      progressError = { cause };
      controller.abort(cause);
    }
  }
  const outputDirectory = options.outputDirectory;
  if (!outputDirectory?.trim())
    throw new VideoDefinitionError('Choose a batch output directory.');
  if (!signal.aborted) await mkdir(outputDirectory, { recursive: true });
  const directory = signal.aborted
    ? await realpath(outputDirectory).catch(() => resolve(outputDirectory))
    : await realpath(outputDirectory);
  const results: VideoVariantResult[] = [];
  const jobs = plan.entries();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const [index, variant] of jobs) {
        const result = await withRenderBudget(limits, () =>
          runVariant(variant),
        );
        results[index] = result;
        emit({
          id: result.id,
          output: result.output,
          status: 'finished',
          result,
        });
      }
    }),
  );
  if (progressError) throw progressError.cause;
  return {
    ok: results.every(({ status }) => status === 'completed'),
    variants: results,
  };

  async function runVariant(
    variant: (typeof plan)[number],
  ): Promise<VideoVariantResult> {
    const { id } = variant;
    const start = performance.now();
    const output = join(directory, variant.output);
    const event = { id, output };
    const timed = () => ({
      ...event,
      elapsedSeconds: (performance.now() - start) / 1000,
    });
    const cancelled = (): VideoVariantResult => ({
      ...timed(),
      status: 'cancelled',
      reason: callerSignal?.aborted ? 'aborted' : 'fail-fast',
    });
    if (signal.aborted) return cancelled();
    let phase: Phase = 'compiling';
    try {
      if ('invalidParams' in variant)
        throw new VideoDefinitionError('params: Expected a JSON object.');
      await checkOutput(output);
      emit({ ...event, status: phase });
      const video = await compileVideoInput(file, {
        params: variant.params,
        signal,
        preview: render.burnSubtitles === false,
        quality: render.quality ?? 'quality',
        processing: {
          ...processing,
          onProgress(progress) {
            emit({ ...event, status: 'recipe', progress });
          },
        },
        probes,
        batch: { variant: id, ...limits },
        scriptWorker: { maxOldGenerationSizeMb: authoringHeapMb },
      });
      signal.throwIfAborted();
      phase = 'rendering';
      emit({ ...event, status: phase });
      const rendered = await renderCompiledVideo(video, output, {
        ...render,
        signal,
        onProgress(progress) {
          emit({ ...event, status: 'render', progress });
        },
      });
      return { ...timed(), status: 'completed', render: rendered };
    } catch (error) {
      if (signal.aborted) return cancelled();
      const code =
        error instanceof Error && 'code' in error
          ? String(error.code)
          : phase === 'compiling'
            ? 'COMPILE_FAILED'
            : 'RENDER_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      if (failFast) controller.abort();
      return { ...timed(), status: 'failed', phase, error: { code, message } };
    }
  }
}

async function checkOutput(output: string) {
  try {
    await lstat(output);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  throw new MediaError(
    `Refusing to overwrite existing batch output '${output}'.`,
  );
}
