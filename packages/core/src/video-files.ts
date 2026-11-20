import type { VideoMixEdit } from '@opencut/shared';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  checkpointCompilation,
  inspectBuildCheckpoint,
  prepareVideoBuild,
} from './video-build.js';
import {
  checkPackagedBackends,
  packageEntryName,
  verifyPackageContents,
} from './video-package-format.js';
import { inspectAssetRecipes } from './video-assets.js';
import { compileDefinition } from './video-compiler.js';
import { compileVideoGraphics, graphicBundleKeys } from './video-graphics.js';
import {
  parseVideoDefinition,
  validateVideoParameters,
  VideoDefinitionError,
} from './video-definition.js';
import type { VideoParameters } from './video-definition.js';
import type { CompilationOptions, CompiledVideo } from './video-compiler.js';
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { VideoInput } from './video-input.js';
import { fingerprintFile, hashJson } from './video-integrity.js';
import { processingSettings } from './video-processing.js';
import type { VideoProcessingProgress } from './video-processing.js';
import {
  readDefinitionScript,
  readIsolatedDefinitionScript,
} from './video-script.js';

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts');
}

export type VideoCompileOptions = Pick<
  CompilationOptions,
  'signal' | 'preview' | 'processing' | 'quality'
> & {
  /** A JSON object validated by the TypeScript definition. */
  params?: unknown;
  audioMixEdit?: VideoMixEdit | undefined;
};

type InputOptions = CompilationOptions &
  VideoCompileOptions & {
    checkpoint?: boolean;
    scriptWorker?: { maxOldGenerationSizeMb?: number };
    batch?: NonNullable<VideoBuild['batch']>;
  };

export interface VideoBuild {
  readonly graphics?: Readonly<Record<string, string>>;
  readonly batch?: {
    readonly variant: string;
    readonly maxTemporaryBytes: number;
    readonly maxNativeBytes: number;
  };
  readonly definition: {
    readonly path: string;
    readonly sha256: string;
    readonly compositionSha256: string;
  };
  readonly params?: VideoParameters;
  readonly processing: {
    readonly directory: string;
    readonly concurrency: number;
    readonly limits: Readonly<ReturnType<typeof processingSettings>['limits']>;
    readonly steps: readonly Readonly<
      Pick<VideoProcessingProgress, 'assetId' | 'step' | 'key'>
    >[];
  };
}

/** Compile a fresh definition using shared project rules and materialize referenced recipes. */
export function compileVideo(
  file: string,
  options: VideoCompileOptions = {},
): Promise<CompiledVideo> {
  return compileVideoInput(file, { ...options, checkpoint: true });
}

export async function compileVideoInput(
  file: string,
  options: InputOptions,
): Promise<CompiledVideo> {
  const input = await readBuildInput(file, options);
  const compile = (controls: InputOptions) =>
    compileResolvedVideo(input, controls);
  if (!options.checkpoint && !options.batch) return compile(options);
  const build = await prepareVideoBuild(input, options);
  return checkpointCompilation(build, options.signal, (record) =>
    compile({ ...options, recovery: { record, sources: build.files } }),
  );
}

async function readBuildInput(file: string, options: InputOptions) {
  const sources = new Map<string, VideoInput>();
  const record = (source: VideoInput) => {
    if (!sources.has(source.path)) sources.set(source.path, source);
    options.inputs?.record(source);
  };
  const { path, value, params, verified, packagedGraphics } =
    await readVideoInput(file, options, record);
  const definition = parseVideoDefinition(value);
  const graphics = await compileVideoGraphics(
    path,
    definition,
    record,
    options.signal,
    packagedGraphics,
  );
  return { path, definition, params, verified, sources, graphics };
}

async function compileResolvedVideo(
  input: Awaited<ReturnType<typeof readBuildInput>>,
  options: InputOptions,
) {
  const { path, definition, params, sources, graphics } = input;
  if (!options.batch && params === undefined && !graphics.size)
    return compileDefinition(input, options);
  const sha256 = await hashDefinition(
    path,
    sources,
    options.signal,
    options.recovery?.sources,
  );
  const { directory, concurrency, limits } = processingSettings(
    options.processing ?? {},
  );
  return compileDefinition(input, options, (steps) => ({
    ...(graphics.size && {
      graphics: Object.fromEntries(graphicBundleKeys(graphics)),
    }),
    definition: {
      path,
      sha256,
      compositionSha256: hashJson(definition),
    },
    ...(params !== undefined && { params }),
    ...(options.batch && { batch: options.batch }),
    processing: {
      directory,
      concurrency,
      limits,
      steps,
    },
  }));
}

export type VideoBuildInspection = Awaited<
  ReturnType<typeof inspectVideoBuild>
>;

/** Read the durable receipts for the exact currently resolved build without processing. */
export async function inspectVideoBuild(
  file: string,
  options: VideoCompileOptions = {},
) {
  const input = await readBuildInput(file, options);
  const build = await prepareVideoBuild(input, options);
  return inspectBuildCheckpoint(build, options.signal);
}

async function hashDefinition(
  path: string,
  sources: ReadonlyMap<string, VideoInput>,
  signal?: AbortSignal,
  saved?: ReadonlyMap<string, Awaited<ReturnType<typeof fingerprintFile>>>,
) {
  const dependencies = new Map<string, string>();
  for (const input of sources.values()) {
    if (!input.identity) continue;
    const physical = await realpath(input.path);
    const cached = saved?.get(physical);
    const digest =
      cached?.identity === input.identity
        ? cached
        : await fingerprintFile(physical, signal);
    if (
      digest.identity !== input.identity ||
      videoInputIdentity(input.path) !== input.identity
    )
      throw new VideoDefinitionError(
        `Definition source '${input.path}' changed during compilation.`,
      );
    dependencies.set(physical, digest.sha256);
  }
  const root = dependencies.get(path);
  dependencies.delete(path);
  const imports = [...dependencies]
    .map(([file, digest]) => [relative(dirname(path), file), digest] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hashJson([root, imports]);
}

/** Validate recipe order and input streams without transcoding or writing a cache. */
export async function inspectVideoRecipes(
  file: string,
  {
    signal,
    params,
    quality,
  }: Pick<VideoCompileOptions, 'signal' | 'params' | 'quality'> = {},
) {
  const { path, value } = await readVideoInput(file, { signal, params });
  const { assets = {} } = parseVideoDefinition(value);
  const recipes = await inspectAssetRecipes(
    dirname(path),
    Object.fromEntries(
      Object.entries(assets).flatMap(([id, asset]) =>
        asset.kind === 'graphic' ? [] : ([[id, asset]] as const),
      ),
    ),
    signal,
    quality,
  );
  return { path, recipes };
}

export async function readVideoInput(
  file: string,
  options: InputOptions,
  record = options.inputs?.record,
  trace?: Parameters<typeof readDefinitionScript>[3],
) {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts file.');
  options.signal?.throwIfAborted();
  const resolved = resolve(file);
  record?.(identifyVideoInput(resolved, 'source'));
  // Let package verification check the reserved entry itself for symlinks.
  const isPackageEntry = basename(resolved) === packageEntryName;
  const physical = await realpath(
    isPackageEntry ? dirname(resolved) : resolved,
  ).catch((cause: unknown) => {
    throw new VideoDefinitionError(
      `Cannot open video definition '${resolved}'.`,
      { cause },
    );
  });
  const path = isPackageEntry ? join(physical, packageEntryName) : physical;
  if (path !== resolved) record?.(identifyVideoInput(path, 'source'));
  const params =
    options.params === undefined
      ? undefined
      : validateVideoParameters(options.params);
  if (basename(path) === packageEntryName) {
    if (params !== undefined)
      throw new VideoDefinitionError(
        'A packaged build uses its recorded parameters. Package the authored definition again for a different variant.',
      );
    const packaged = await verifyPackageContents(dirname(path), options.signal);
    await checkPackagedBackends(packaged.manifest);
    record?.(identifyVideoInput(packaged.manifestPath, 'source'));
    for (const [path, { identity }] of packaged.fingerprints)
      record?.({ path, kind: 'source', identity });
    return {
      path,
      value: packaged.definition,
      params: undefined,
      verified: packaged.fingerprints,
      packagedGraphics: packaged.graphics,
    };
  }
  const result =
    trace || options.scriptWorker || params !== undefined
      ? await readIsolatedDefinitionScript(
          path,
          options.signal,
          record,
          params,
          options.scriptWorker?.maxOldGenerationSizeMb,
          trace,
        )
      : await readDefinitionScript(path, record, params);
  return { path, ...result, verified: undefined, packagedGraphics: undefined };
}
