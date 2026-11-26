import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  beautyBackend,
  beautyModels,
  beautyRuntimeHint,
  beautySource,
  beautyWorkerFiles,
  MediaError,
  probeRecipeMedia,
  runBeautyWorker,
} from '@opencut/media';
import {
  beautyAnalysisId,
  beautyParameters,
  beautyParameterSchema,
  isActiveBeautyEffect,
} from './beauty-schema.js';
import type { BeautyRecipeStep } from './beauty-schema.js';
import {
  fileLease,
  fingerprintFile,
  hashJson,
  syncPath,
  writeCheckpoint,
} from './video-integrity.js';

const backendVersion = 1;
const artifactVersion = 1;
const MiB = 1024 * 1024;
const beautyLimits = {
  maxBytes: 4096 * MiB,
  maxMemory: 1800 * MiB,
  timeoutMs: 60 * 60_000,
};
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const versions = z.strictObject({
  python: z.string(),
  av: z.literal('16.1.0'),
  opencv: z.literal('4.12.0'),
  numpy: z.literal('2.2.6'),
  mediapipe: z.literal('0.10.35'),
});
const interval = z.strictObject({
  startFrame: z.int().nonnegative(),
  endFrame: z.int().positive(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
});
const summarySchema = z.strictObject({
  analysisSize: z.tuple([z.int().positive(), z.int().positive()]),
  timeBase: z.string().regex(/^\d+\/\d+$/),
  frames: z.int().positive(),
  durationSeconds: z.number().positive(),
  shots: z
    .array(
      z.strictObject({
        id: z.string(),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().positive(),
        startFrame: z.int().nonnegative(),
        endFrame: z.int().positive(),
        ambiguousIntervals: z.array(interval),
      }),
    )
    .min(1),
  tracks: z.array(
    z.strictObject({
      shotId: z.string(),
      trackId: z.string(),
      sampleFrame: z.int().nonnegative(),
      sampleSeconds: z.number().nonnegative(),
      box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      intervals: z.array(interval),
      faceIntervals: z.array(interval),
      poseIntervals: z.array(interval),
      skinIntervals: z.array(interval),
      regions: z.record(
        z.string(),
        z.record(
          z.string(),
          z.strictObject({
            frames: z.int().positive(),
            confidence: z
              .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
              .nullable(),
            intervals: z.array(interval),
          }),
        ),
      ),
    }),
  ),
  correctionsApplied: z
    .array(
      z.strictObject({
        frame: z.int().nonnegative(),
        shotId: z.string(),
        trackId: z.string(),
        anchor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
        reassociated: z.boolean(),
      }),
    )
    .optional(),
  resources: z.strictObject({
    seconds: z.number().nonnegative(),
    peakWorkerBytes: z.int().nonnegative(),
    bytes: z.int().positive(),
  }),
});
const decodeSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  rotation: z.number(),
  matrix: z.number(),
  range: z.string(),
  stream: z.int().nonnegative(),
  timeScale: z.int().positive(),
});
const identitySchema = z.strictObject({
  version: z.literal(artifactVersion),
  backend: z.literal(beautyBackend),
  backendVersion: z.literal(backendVersion),
  platform: z.string(),
  sourceSha256: sha,
  workerSha256: sha,
  runtime: versions,
  modelSha256: z.array(sha).length(beautyModels.length),
  decode: decodeSchema,
  context: z
    .strictObject({
      sourceSha256: sha,
      start: z.number().nonnegative(),
      decode: decodeSchema,
    })
    .optional(),
  correctionsSha256: sha,
});
const receiptSchema = z.strictObject({
  id: beautyAnalysisId,
  identity: identitySchema,
  sha256: sha,
  summary: summarySchema,
  summarySha256: sha,
});
export const beautyCorrectionsSchema = z
  .array(
    z.strictObject({
      frame: z.int().nonnegative(),
      shotId: z.string().regex(/^shot-\d+$/),
      trackId: z.string().regex(/^person-\d+$/),
      anchor: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    }),
  )
  .max(10_000);
type BeautyCorrections = z.output<typeof beautyCorrectionsSchema>;

export async function discoverBeauty(signal?: AbortSignal) {
  try {
    const runtime = await beautyRuntime(signal);
    return { status: 'available' as const, versions: runtime.runtime };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: 'unavailable' as const,
      error: error instanceof Error ? error.message : String(error),
      hint: beautyRuntimeHint,
    };
  }
}

async function beautyRuntime(signal?: AbortSignal) {
  const directory = process.env.OPENCUT_BEAUTY_MODELS;
  if (!directory?.trim())
    throw new MediaError(
      'Beauty model directory is unconfigured. ' + beautyRuntimeHint,
    );
  const models = await realpath(directory).catch(() => {
    throw new MediaError(
      'Beauty model directory was not found. ' + beautyRuntimeHint,
    );
  });
  const [state, workerSha256, ...checksums] = await Promise.all([
    runBeautyWorker('preflight', undefined, { signal }),
    beautyWorkerVersion(signal),
    ...beautyModels.map(async ({ file, sha256 }) => {
      const located = join(models, file);
      const actual = await fingerprintFile(located, signal).catch(
        (error: unknown) => {
          signal?.throwIfAborted();
          throw new MediaError(
            'Missing or unreadable beauty model ' +
              file +
              '. ' +
              beautyRuntimeHint,
            { cause: error },
          );
        },
      );
      if (actual.sha256 !== sha256)
        throw new MediaError(
          'Beauty model checksum mismatch for ' +
            file +
            '. ' +
            beautyRuntimeHint,
        );
      return actual.sha256;
    }),
  ]);
  const parsed = versions.safeParse(state);
  if (!parsed.success)
    throw new MediaError(
      'Beauty runtime package versions differ from the tested pins. ' +
        beautyRuntimeHint,
    );
  return { models, workerSha256, checksums, runtime: parsed.data };
}

export async function beautyWorkerVersion(signal?: AbortSignal) {
  return hashJson(
    await Promise.all(
      beautyWorkerFiles.map(
        async (file) => (await fingerprintFile(file, signal)).sha256,
      ),
    ),
  );
}

const analysisFolder = (directory: string) =>
  join(directory, 'beauty-analysis-v1');

export async function inspectBeautyAnalysis(
  directory: string,
  id: string,
  signal?: AbortSignal,
) {
  id = beautyAnalysisId.parse(id);
  const root = join(analysisFolder(directory), id);
  const database = join(root, 'frames.sqlite');
  try {
    if (
      !(await lstat(root)).isDirectory() ||
      !(await lstat(join(root, 'result.json'))).isFile()
    )
      throw new Error('Missing analysis receipt.');
    const receipt = receiptSchema.parse(
      JSON.parse(
        await readFile(join(root, 'result.json'), { encoding: 'utf8', signal }),
      ),
    );
    const observed = await fingerprintFile(database, signal);
    if (
      id !== receipt.id ||
      id !== hashJson(receipt.identity) ||
      receipt.summarySha256 !== hashJson(receipt.summary) ||
      receipt.sha256 !== observed.sha256 ||
      receipt.summary.resources.bytes !== observed.bytes
    )
      throw new Error('Analysis content differs from its receipt.');
    return { ...receipt, database };
  } catch (cause) {
    signal?.throwIfAborted();
    throw new MediaError(
      'Beauty analysis ' +
        id +
        ' is missing, incomplete, or corrupt. Run opencut beauty analyze again with the original inputs.',
      { cause },
    );
  }
}

async function resolveBeautyContext(
  source: string,
  clip: ReturnType<typeof beautySource>,
  options: { source: string; start: number },
  signal: AbortSignal,
) {
  const start = z.number().nonnegative().parse(options.start);
  const path = await realpath(options.source);
  if (path === source)
    throw new MediaError(
      'Beauty context must be the separate original recording.',
    );
  const [media, fingerprint] = await Promise.all([
    probeRecipeMedia(path, signal),
    fingerprintFile(path, signal),
  ]);
  const decode = beautySource(media);
  if (decode.width !== clip.width || decode.height !== clip.height)
    throw new MediaError(
      'Beauty context must have the same decoded dimensions as the excerpt.',
    );
  if (clip.width * clip.height > 1_000_000)
    throw new MediaError(
      'Beauty context currently supports excerpts of up to one million pixels per frame.',
    );
  return {
    source: path,
    fileIdentity: fingerprint.identity,
    identity: { sourceSha256: fingerprint.sha256, start, decode },
  };
}

export async function analyzeBeauty(
  source: string,
  directory: string,
  options: {
    signal: AbortSignal;
    corrections?: BeautyCorrections;
    context?: { source: string; start: number };
    limits?: { [Name in keyof typeof beautyLimits]?: number | undefined };
    onTime?: (seconds: number) => void;
  },
) {
  const { signal, onTime, corrections = [] } = options;
  const {
    maxBytes = beautyLimits.maxBytes,
    maxMemory = beautyLimits.maxMemory,
    timeoutMs = beautyLimits.timeoutMs,
  } = options.limits ?? {};
  const limits = { maxBytes, maxMemory, timeoutMs };
  source = await realpath(source);
  const fingerprint = await fingerprintFile(source, signal);
  const [media, runtime] = await Promise.all([
    probeRecipeMedia(source, signal),
    beautyRuntime(signal),
  ]);
  const decode = beautySource(media);
  const context = options.context
    ? await resolveBeautyContext(source, decode, options.context, signal)
    : undefined;
  const identity = {
    version: artifactVersion,
    backend: beautyBackend,
    backendVersion,
    platform: process.platform + '-' + process.arch,
    sourceSha256: fingerprint.sha256,
    workerSha256: runtime.workerSha256,
    runtime: runtime.runtime,
    modelSha256: runtime.checksums,
    decode,
    ...(context && { context: context.identity }),
    correctionsSha256: hashJson(corrections),
  };
  const id = hashJson(identity);
  const root = analysisFolder(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await fileLease(
    join(root, '.lock-' + id.slice(0, 2) + '.sqlite'),
    signal,
  );
  let stage: string | undefined;
  try {
    const cached = await inspectBeautyAnalysis(directory, id, signal).catch(
      () => {
        signal.throwIfAborted();
      },
    );
    if (cached) return { ...cached, cache: 'hit' as const };
    const stagePrefix = '.attempt-' + id + '-';
    for (const file of await readdir(root))
      if (
        file.startsWith(stagePrefix) &&
        /^[a-zA-Z0-9]{6}$/.test(file.slice(stagePrefix.length))
      )
        await rm(join(root, file), { recursive: true, force: true });
    stage = await mkdtemp(join(root, stagePrefix));
    const database = join(stage, 'frames.sqlite');
    const request = join(stage, 'request.json');
    await writeFile(
      request,
      JSON.stringify({
        ...identity.decode,
        source,
        models: runtime.models,
        runtime: identity.runtime,
        corrections,
        ...(context && {
          context: {
            ...context.identity.decode,
            source: context.source,
            start: context.identity.start,
          },
        }),
        output: database,
        ...limits,
      }),
      { flag: 'wx', signal },
    );
    const summary = summarySchema.parse(
      await runBeautyWorker('analyze', request, {
        signal,
        timeoutMs: limits.timeoutMs,
        onTime,
      }),
    );
    await rm(request);
    const after = await fingerprintFile(source, signal);
    if (
      after.identity !== fingerprint.identity ||
      after.sha256 !== fingerprint.sha256
    )
      throw new MediaError(
        'Beauty source changed during analysis. Run analysis on the stable source.',
      );
    if (context) {
      const current = await fingerprintFile(context.source, signal);
      if (
        current.identity !== context.fileIdentity ||
        current.sha256 !== context.identity.sourceSha256
      )
        throw new MediaError(
          'The original context recording changed during beauty analysis.',
        );
    }
    const { sha256, bytes } = await fingerprintFile(database, signal);
    if (
      bytes > limits.maxBytes ||
      summary.resources.peakWorkerBytes > limits.maxMemory
    )
      throw new MediaError('Beauty exceeded the analysis resource budget.');
    await syncPath(database);
    const receipt = {
      id,
      identity,
      sha256,
      summary,
      summarySha256: hashJson(summary),
    };
    await writeCheckpoint(join(stage, 'result.json'), receipt);
    signal.throwIfAborted();
    const target = join(root, id);
    // This path is derived from the receipt identity under the analysis cache.
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
    stage = undefined;
    await syncPath(root);
    return {
      ...receipt,
      database: join(target, 'frames.sqlite'),
      cache: 'built' as const,
    };
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true });
    } finally {
      release?.();
    }
  }
}

export async function sampleBeautyAnalysis(
  analysis: Awaited<ReturnType<typeof inspectBeautyAnalysis>>,
  output: string,
  signal: AbortSignal,
) {
  const destination = resolve(output);
  await mkdir(destination);
  const request = join(destination, '.request.json');
  try {
    await writeFile(
      request,
      JSON.stringify({ analysis: analysis.database, output: destination }),
      { flag: 'wx', signal },
    );
    return await runBeautyWorker('samples', request, { signal });
  } finally {
    await rm(request, { force: true });
  }
}

export async function validateBeautyBinding(
  step: BeautyRecipeStep,
  assetId: string,
  sourceSha256: string,
  directory: string,
  signal?: AbortSignal,
) {
  const analysis = await inspectBeautyAnalysis(
    directory,
    step.analysisRef,
    signal,
  );
  if (analysis.identity.sourceSha256 !== sourceSha256)
    throw new MediaError(
      'Beauty analysis belongs to different source bytes. Analyze this source and resolve new track IDs.',
    );
  if (
    beautyModels.some(
      ({ sha256 }, i) => analysis.identity.modelSha256[i] !== sha256,
    ) ||
    analysis.identity.workerSha256 !== (await beautyWorkerVersion(signal))
  )
    throw new MediaError(
      'Beauty analysis was created with a different backend revision. Reanalyze before binding tracks.',
    );
  for (const effect of step.effects.filter(isActiveBeautyEffect)) {
    const { target, timeRange } = effect;
    const shot = analysis.summary.shots.find(({ id }) => id === target.shotId);
    const track = analysis.summary.tracks.find(
      ({ shotId, trackId }) =>
        shotId === target.shotId && trackId === target.trackId,
    );
    if (target.assetId !== assetId || !shot || !track)
      throw new MediaError(
        'Unresolved beauty target for ' +
          effect.id +
          '. Inspect the analysis and use the asset, shot and track IDs it resolves.',
      );
    if (
      timeRange.start < shot.startSeconds - 1e-8 ||
      timeRange.end > shot.endSeconds + 1e-8 ||
      !track.intervals.some(
        ({ startSeconds, endSeconds }) =>
          startSeconds < timeRange.end && timeRange.start < endSeconds,
      )
    )
      throw new MediaError(
        'Beauty effect ' +
          effect.id +
          ' must overlap its target within its assigned shot.',
      );
  }
  return analysis;
}

export function beautyCapabilities() {
  return {
    backend: beautyBackend,
    analysisVersion: artifactVersion,
    models: beautyModels,
    parameters: z.toJSONSchema(beautyParameterSchema),
    defaults: Object.fromEntries(beautyParameters.map((name) => [name, 0])),
    media: {
      type: 'timed-video',
      maxPixels: 8_294_400,
      minDimension: 32,
      color: ['SDR BT.709', 'SDR BT.601', 'sRGB'],
      bitDepth: 8,
      pixelAspectRatio: 1,
      maxPeoplePerFrame: 4,
    },
    originalContext: {
      maxPixels: 1_000_000,
      maxStartSeconds: 180,
      singleShot: true,
      offsetDomain: 'original-presentation-seconds',
    },
    testedPlatform: 'Apple Silicon macOS with Python 3.12',
    modelLicense: 'Apache-2.0',
    timeDomain: 'source-presentation-seconds',
    coordinateDomain: 'oriented-square-pixel-source',
    temporal: {
      neighborFrames: 2,
      maxWindowSeconds: 0.12,
      maxTrackGapSeconds: 0.22,
    },
    quality: {
      objectiveProfile: 'cpu-beauty-v1',
      coveragePolicies: [
        'complete-coverage',
        'visible-result',
        'allow-limitations',
      ],
      defaultCoveragePolicy: 'complete-coverage',
      visibleResultProfile: 'cpu-beauty-visible-v2',
      visualAcceptance: 'not-evaluated',
    },
    setup: beautyRuntimeHint,
  };
}

export async function removeBeautyAnalysis(
  directory: string,
  id: string,
  signal: AbortSignal,
) {
  id = beautyAnalysisId.parse(id);
  const root = analysisFolder(directory);
  const at = join(root, id);
  if (!(await lstat(root)).isDirectory())
    throw new MediaError('Beauty analysis cache is unavailable.');
  const release = await fileLease(
    join(root, '.lock-' + id.slice(0, 2) + '.sqlite'),
    signal,
  );
  try {
    await inspectBeautyAnalysis(directory, id, signal);
    if (dirname(at) !== root)
      throw new MediaError('Unsafe beauty analysis path.');
    signal.throwIfAborted();
    await rm(at, { recursive: true });
    await syncPath(root);
    return { id, status: 'removed' as const };
  } finally {
    release?.();
  }
}

export async function validateBeautyRecipes(
  recipes: readonly import('./video-recipe.js').VideoRecipeInspection[],
  directory: string,
  signal?: AbortSignal,
) {
  const bindings = [];
  for (const { assetId, source, steps } of recipes) {
    for (const { parameters } of steps) {
      if (parameters.type !== 'beauty') continue;
      if (!parameters.effects.some(isActiveBeautyEffect)) {
        bindings.push({ assetId, status: 'neutral' as const });
        continue;
      }
      const fingerprint = await fingerprintFile(await realpath(source), signal);
      const analysis = await validateBeautyBinding(
        parameters,
        assetId,
        fingerprint.sha256,
        directory,
        signal,
      );
      bindings.push({
        assetId,
        status: 'bound' as const,
        analysisRef: analysis.id,
        coverage: parameters.effects
          .filter(isActiveBeautyEffect)
          .map(({ id, target, timeRange }) => ({
            id,
            target,
            timeRange,
            intervals: analysis.summary.tracks.find(
              ({ shotId, trackId }) =>
                shotId === target.shotId && trackId === target.trackId,
            )!.intervals,
          })),
      });
    }
  }
  return bindings;
}
