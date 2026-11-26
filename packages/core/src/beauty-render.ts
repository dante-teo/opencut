import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MediaMetadata, RecipeProcessLimits } from '@opencut/media';
import {
  beautySource,
  MediaError,
  probeRecipeMedia,
  runBeautyWorker,
  runRecipeProcess,
} from '@opencut/media';
import { z } from 'zod';
import type { BeautyRecipeStep } from './beauty-schema.js';
import { inspectBeautyAnalysis } from './beauty-analysis.js';

import { beautyReportSchema } from './beauty-report.js';
import type { BeautyRenderReport } from './beauty-report.js';
import { fingerprintFile } from './video-integrity.js';
import { readMediaEntry } from './video-media-cache.js';

export class BeautyCoverageError extends MediaError {
  readonly code = 'BEAUTY_COVERAGE_FAILED';
  constructor(
    readonly beauty: BeautyRenderReport,
    cause: unknown,
  ) {
    super(
      'Beauty coverage policy failed. Inspect the intervals before changing strengths or acceptance policy.',
      { cause },
    );
  }
}

export function findBeautyCoverageError(cause: unknown) {
  const seen = new Set<Error>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof BeautyCoverageError) return cause;
    cause = cause.cause;
  }
}

export async function runBeautyRecipe(
  source: MediaMetadata,
  step: BeautyRecipeStep,
  analysis: Awaited<ReturnType<typeof inspectBeautyAnalysis>>,
  output: string,
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onTime: (seconds: number) => void,
) {
  const request = output + '.beauty-request.json';
  const picture = output + '.picture.mov';
  let observed: unknown;
  try {
    const decode = beautySource(source);
    if (JSON.stringify(decode) !== JSON.stringify(analysis.identity.decode))
      throw new MediaError(
        'Beauty decode configuration differs from the analysis. Reanalyze the original source.',
      );
    // While remuxing, both the picture and the combined artifact exist.
    const stageBytes = source.audio
      ? Math.floor(limits.maxTemporaryBytes / 2)
      : limits.maxTemporaryBytes;
    await writeFile(
      request,
      JSON.stringify({
        ...decode,
        source: source.path,
        output: source.audio ? picture : output,
        analysis: analysis.database,
        runtime: analysis.identity.runtime,
        step,
        maxBytes: stageBytes,
        maxMemory: limits.maxNativeBytes,
      }),
      { flag: 'wx', signal },
    );
    let report: BeautyRenderReport;
    try {
      report = beautyReportSchema.parse(
        await runBeautyWorker('render', request, {
          signal,
          timeoutMs: limits.timeoutMs,
          onTime,
          onResult(value) {
            observed = value;
          },
        }),
      );
    } catch (cause) {
      signal.throwIfAborted();
      const parsed = beautyReportSchema.safeParse(observed);
      if (
        parsed.success &&
        ((step.acceptance === 'complete-coverage' &&
          parsed.data.status === 'completed-with-limitations') ||
          (step.acceptance === 'visible-result' &&
            parsed.data.visibleResult?.status === 'failed'))
      )
        throw new BeautyCoverageError(parsed.data, cause);
      throw cause;
    }
    if (
      report.resources.bytes > stageBytes ||
      report.resources.peakWorkerBytes > limits.maxNativeBytes
    )
      throw new MediaError(
        'Beauty exceeded the recipe worker resource limits.',
      );
    if (source.audio) {
      await runRecipeProcess(
        [
          '-copyts',
          '-i',
          picture,
          '-i',
          source.path,
          '-map',
          '0:v:0',
          '-map',
          '1:' + source.audio.index,
          '-c:v',
          'copy',
          '-c:a',
          'pcm_f32le',
          '-threads:a',
          '1',
          '-video_track_timescale',
          String(decode.timeScale),
          // Audio and picture can use different clocks. Keep the edit list
          // fine enough to preserve both stream starts through the remux.
          '-movie_timescale',
          String(Math.max(1_000_000, decode.timeScale)),
          '-movflags',
          '+write_colr',
          '-avoid_negative_ts',
          'disabled',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          '-n',
          output,
        ],
        {
          ...limits,
          maxTemporaryBytes: limits.maxTemporaryBytes - report.resources.bytes,
        },
        signal,
        () => {},
      );
      await rm(picture);
    }
    await writeFile(
      request,
      JSON.stringify({
        source: source.path,
        stream: decode.stream,
        audioStream: source.audio?.index,
        output,
        count: report.frames,
      }),
      { signal },
    );
    await runBeautyWorker('verify', request, {
      signal,
      timeoutMs: limits.timeoutMs,
    });
    return {
      ...report,
      quality: { ...report.quality, sourceTiming: 'passed' as const },
    };
  } finally {
    await Promise.all([
      rm(request, { force: true }),
      rm(picture, { force: true }),
    ]);
  }
}

export async function evaluateBeautyRecipe(
  sourcePath: string,
  directory: string,
  key: string,
  output: string,
  range: { startFrame: number; endFrame: number },
  signal: AbortSignal,
) {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new MediaError(
      'Use the 64-character recipe processing key from the render result.',
    );
  const entry = await readMediaEntry(join(directory, key), key, 'mov', signal);
  if (!entry?.beauty)
    throw new MediaError(
      'The requested key does not identify a verified beauty render in this recipe cache.',
    );
  const analysis = await inspectBeautyAnalysis(
    directory,
    entry.beauty.analysisRef,
    signal,
  );
  const source = await realpath(sourcePath);
  const fingerprint = await fingerprintFile(source, signal);
  if (fingerprint.sha256 !== analysis.identity.sourceSha256)
    throw new MediaError(
      'Beauty evaluation requires the original analyzed source.',
    );
  const { startFrame, endFrame } = range;
  if (
    endFrame <= startFrame ||
    endFrame > entry.beauty.frames ||
    endFrame - startFrame > 240 ||
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrame) ||
    startFrame < 0
  )
    throw new MediaError(
      'Choose an increasing source-frame interval of at most 240 frames inside the rendered input.',
    );
  const media = await probeRecipeMedia(source, signal);
  const destination = resolve(output);
  await mkdir(destination);
  const request = join(destination, '.request.json');
  try {
    await writeFile(
      request,
      JSON.stringify({
        ...beautySource(media),
        source,
        processed: entry.metadata.path,
        analysis: analysis.database,
        report: entry.beauty,
        destination,
        ...range,
      }),
      { flag: 'wx', signal },
    );
    const result = z
      .object({ ok: z.boolean(), checks: z.record(z.string(), z.string()) })
      .loose();
    return result.parse(
      await runBeautyWorker('evaluate', request, {
        signal,
        timeoutMs: 180_000,
      }),
    );
  } finally {
    await rm(request, { force: true });
  }
}

const visualCheck = z.enum([
  'passed',
  'failed',
  'not-evaluated',
  'unsupported',
]);
const requiredReviewChecks = [
  'geometryDirectionAndResponse',
  'targetIdentity',
  'motionCompensatedStability',
  'occlusionOrdering',
  'skinTexture',
  'colorQuality',
  'reconstructionContinuity',
] as const;
export const beautyReviewSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal('cpu-beauty-evidence-v1'),
  recipeKey: z.string().regex(/^[a-f0-9]{64}$/),
  startFrame: z.int().nonnegative(),
  endFrame: z.int().positive(),
  reviewer: z.string().trim().min(1),
  normalSpeed: z.literal(true),
  checks: z.record(z.enum(requiredReviewChecks), visualCheck),
  findings: z
    .array(
      z.strictObject({
        check: z.enum(requiredReviewChecks),
        frame: z.int().nonnegative(),
        shotId: z.string().min(1).optional(),
        trackId: z.string().min(1).optional(),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string().trim().min(1),
      }),
    )
    .max(1000),
});

export function resolveBeautyReview(
  evidence: { ok: boolean; checks: Record<string, string> },
  key: string,
  startFrame: number,
  endFrame: number,
  requireVisual: boolean,
  review?: z.output<typeof beautyReviewSchema>,
) {
  if (
    review &&
    (review.recipeKey !== key ||
      review.startFrame !== startFrame ||
      review.endFrame !== endFrame ||
      review.findings.some(
        ({ frame }) => frame < startFrame || frame >= endFrame,
      ))
  )
    throw new MediaError(
      'Beauty review must refer to the same recipe key and evidence interval.',
    );
  const statuses = Object.values(review?.checks ?? {});
  const visualAcceptance =
    statuses.includes('failed') ||
    review?.findings.some(({ severity }) => severity === 'error')
      ? 'failed'
      : review &&
          statuses.length === requiredReviewChecks.length &&
          statuses.every((status) => status === 'passed')
        ? 'passed'
        : 'not-evaluated';
  return {
    ...evidence,
    ok:
      evidence.ok &&
      visualAcceptance !== 'failed' &&
      (!requireVisual ||
        (visualAcceptance === 'passed' &&
          evidence.checks.outsideInfluenceUnchanged === 'passed')),
    checks: { ...evidence.checks, ...review?.checks, visualAcceptance },
    ...(review && { review }),
  };
}
