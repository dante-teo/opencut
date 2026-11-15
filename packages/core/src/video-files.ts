import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { inspectAssetRecipes } from './video-assets.js';
import { compileDefinition } from './video-compiler.js';
import {
  definitionLoadError,
  parseVideoDefinition,
  resolveVideoDefinition,
  validateVideoParameters,
  VideoDefinitionError,
} from './video-definition.js';
import type { VideoParameters } from './video-definition.js';
import type { CompilationOptions, CompiledVideo } from './video-compiler.js';
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { VideoInput } from './video-input.js';
import { processingSettings } from './video-processing.js';
import type { VideoProcessingProgress } from './video-processing.js';
import {
  readDefinitionScript,
  readIsolatedDefinitionScript,
} from './video-script.js';

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts') || file.endsWith('.video.json');
}

async function readDefinitionJson(path: string) {
  try {
    const json = await readFile(path, 'utf8');
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw definitionLoadError(path, cause);
  }
}

export type VideoCompileOptions = Pick<
  CompilationOptions,
  'signal' | 'preview' | 'processing'
> & {
  /** A JSON object validated by the TypeScript definition. */
  params?: unknown;
};

type InputOptions = CompilationOptions &
  VideoCompileOptions & {
    scriptWorker?: { maxOldGenerationSizeMb?: number };
    batch?: NonNullable<VideoBuild['batch']>;
  };

export interface VideoBuild {
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

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

/** Compile a fresh definition using shared project rules and materialize referenced recipes. */
export function compileVideo(
  file: string,
  options: VideoCompileOptions = {},
): Promise<CompiledVideo> {
  return compileVideoInput(file, options);
}

export async function compileVideoInput(
  file: string,
  options: InputOptions,
): Promise<CompiledVideo> {
  const sources = new Map<string, VideoInput>();
  const { path, value, params } = await readVideoInput(
    file,
    options,
    (input) => {
      if (!sources.has(input.path)) sources.set(input.path, input);
      options.inputs?.record(input);
    },
  );
  if (!options.batch && params === undefined)
    return compileDefinition(path, value, options);

  const steps: VideoBuild['processing']['steps'][number][] = [];
  const sha256 = await hashDefinition(path, sources, options.signal);
  const { directory, concurrency, limits } = processingSettings(
    options.processing ?? {},
  );
  return compileDefinition(
    path,
    value,
    {
      ...options,
      processing: {
        ...options.processing,
        onProgress(event) {
          if (event.status === 'completed' || event.status === 'cache-hit') {
            const { assetId, step, key } = event;
            steps.push({ assetId, step, key });
          }
          options.processing?.onProgress?.(event);
        },
      },
    },
    (composition) => ({
      definition: {
        path,
        sha256,
        compositionSha256: hash(JSON.stringify(composition)),
      },
      ...(params !== undefined && { params }),
      ...(options.batch && { batch: options.batch }),
      processing: {
        directory,
        concurrency,
        limits,
        steps: steps.sort(
          (a, b) => a.assetId.localeCompare(b.assetId) || a.step - b.step,
        ),
      },
    }),
  );
}

async function hashDefinition(
  path: string,
  sources: ReadonlyMap<string, VideoInput>,
  signal?: AbortSignal,
) {
  const dependencies = new Map<string, string>();
  for (const input of sources.values()) {
    if (!input.identity) continue;
    const physical = await realpath(input.path);
    const bytes = await readFile(physical, { signal });
    if (videoInputIdentity(input.path) !== input.identity)
      throw new VideoDefinitionError(
        `Definition source '${input.path}' changed during compilation.`,
      );
    dependencies.set(physical, hash(bytes));
  }
  const root = dependencies.get(path);
  dependencies.delete(path);
  const imports = [...dependencies]
    .map(([file, digest]) => [relative(dirname(path), file), digest] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return hash(JSON.stringify([root, imports]));
}

/** Validate recipe order and input streams without transcoding or writing a cache. */
export async function inspectVideoRecipes(
  file: string,
  { signal, params }: Pick<VideoCompileOptions, 'signal' | 'params'> = {},
) {
  const { path, value } = await readVideoInput(file, { signal, params });
  const { assets = {} } = parseVideoDefinition(value);
  const recipes = await inspectAssetRecipes(dirname(path), assets, signal);
  return { path, recipes };
}

async function readVideoInput(
  file: string,
  options: InputOptions,
  record = options.inputs?.record,
) {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts or .video.json file.');
  options.signal?.throwIfAborted();
  const resolved = resolve(file);
  record?.(identifyVideoInput(resolved, 'source'));
  const path = await realpath(resolved).catch((cause: unknown) => {
    throw new VideoDefinitionError(
      `Cannot open video definition '${resolved}'.`,
      { cause },
    );
  });
  if (path !== resolved) record?.(identifyVideoInput(path, 'source'));
  // The selected filename determines how to load a symlink alias. Both loading
  // and media resolution use the same physical definition path.
  const params =
    options.params === undefined
      ? undefined
      : validateVideoParameters(options.params);
  if (file.endsWith('.video.json'))
    return {
      path,
      ...(await resolveVideoDefinition(await readDefinitionJson(path), params)),
    };
  const result =
    options.scriptWorker || params !== undefined
      ? await readIsolatedDefinitionScript(
          path,
          options.signal,
          record,
          params,
          options.scriptWorker?.maxOldGenerationSizeMb,
        )
      : await readDefinitionScript(path, record);
  return { path, ...result };
}
