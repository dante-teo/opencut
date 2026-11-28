import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { findSourceChange, SourceChangedError } from '@opencut/media';
import type { RenderQuality } from '@opencut/shared';
import { VideoDefinitionError } from './video-definition.js';
import { graphicBundleKeys } from './video-graphics.js';
import type {
  ParsedVideoDefinition,
  VideoParameters,
} from './video-definition.js';
import {
  fileLease,
  fileFingerprintSchema,
  fingerprintFile,
  matchesFingerprint,
  hashJson,
  ifPresent,
  inspectOutputFingerprint,
  missing,
  readOutputFingerprint,
  syncPath,
  writeCheckpoint,
} from './video-integrity.js';
import { videoInputIdentity } from './video-input.js';
import type { VideoInput } from './video-input.js';
import type {
  CompilationOptions,
  CompiledVideo,
  DefinitionSources,
} from './video-compiler.js';
import { processingSettings } from './video-processing.js';
import type { FileFingerprint } from './video-integrity.js';
import type { RecipeRecovery } from './video-processing.js';
import { findMediaEntry, readMediaEntry } from './video-media-cache.js';
import type { MediaFingerprint } from './video-media-cache.js';
import {
  inheritsRenderQuality,
  recipeFormatSchema,
} from './video-recipe-schema.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const stageSchema = z.object({
  assetId: z.string(),
  step: z.int().nonnegative(),
  key: sha256,
  format: recipeFormatSchema,
});
const compileSchema = z.object({
  version: z.literal(1),
  id: sha256,
  definition: z.string(),
  compositionSha256: sha256,
  params: z.record(z.string(), z.unknown()).optional(),
  preview: z.boolean(),
  state: z.enum(['compiling', 'compiled', 'failed']),
  inputs: z.array(z.object({ path: z.string(), sha256 })),
  steps: z.array(stageSchema),
  frameCount: z.int().positive().optional(),
  error: z.string().optional(),
});
const renderSchema = z.object({
  version: z.literal(1),
  output: z.string(),
  state: z.enum(['rendering', 'rendered', 'failed']),
  settings: z.unknown(),
  scratch: z.string().optional(),
  verified: fileFingerprintSchema.optional(),
  published: z
    .object({ settings: z.unknown(), verified: fileFingerprintSchema })
    .optional(),
  error: z.string().optional(),
});

type CompileReceipt = z.infer<typeof compileSchema>;
type RenderReceipt = z.infer<typeof renderSchema>;
type Stage = z.infer<typeof stageSchema>;
type Fingerprint = Awaited<ReturnType<typeof fingerprintFile>>;
type BuildInputs = Pick<
  CompileReceipt,
  'compositionSha256' | 'params' | 'preview' | 'inputs'
> & {
  cache: string;
  path: string;
  files: ReadonlyMap<string, Fingerprint>;
  identities: ReadonlyMap<string, string>;
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const scratchPrefix = '.opencut-build-render-';

export function buildReceiptsDirectory(cache: string) {
  return join(cache, '.builds-v1');
}

export async function prepareVideoBuild(
  {
    path,
    definition,
    sources,
    params,
    verified,
    graphics,
  }: DefinitionSources & {
    sources: ReadonlyMap<string, VideoInput>;
    params?: VideoParameters | undefined;
    verified: ReadonlyMap<string, Fingerprint> | undefined;
  },
  { processing, preview: previewOption, quality, signal }: CompilationOptions,
) {
  const { directory: cache } = processingSettings(processing ?? {});
  const preview = previewOption ?? false;
  const inputs = new Map<string, CompileReceipt['inputs'][number]>();
  const files = new Map<string, Fingerprint>();
  const identities = new Map<string, string>();
  const add = async (
    path: string,
    expected?: string | null,
    label?: string,
    baseline?: Fingerprint,
  ) => {
    signal?.throwIfAborted();
    const actual = await realpath(path).catch((cause: unknown) => {
      throw new VideoDefinitionError(
        `${label ?? 'Cannot read build input'} '${path}'.`,
        {
          cause,
        },
      );
    });
    const identity = expected ?? videoInputIdentity(path);
    let digest = files.get(actual);
    if (!digest) {
      const saved = verified?.get(actual);
      digest =
        saved?.identity === identity && saved
          ? saved
          : await fingerprintFile(actual, signal);
      files.set(actual, digest);
    }
    const observed = videoInputIdentity(path);
    if (digest.identity !== identity || observed !== identity) {
      const error = new SourceChangedError(
        path,
        'build input collection',
        identity,
        observed,
      );
      await error.compareContent(baseline ?? digest, signal);
      throw error;
    }
    inputs.set(path, { path, sha256: digest.sha256 });
    // The definition and its modules have already been evaluated. Media and
    // font files are read later by the compiler, so keep checking those.
    if (expected === undefined) identities.set(path, identity);
  };
  for (const input of sources.values())
    if (input.identity)
      await add(input.path, input.identity, undefined, input.fingerprint);
  for (const [id, asset] of Object.entries(definition.assets ?? {}))
    if (asset.kind !== 'graphic')
      await add(
        resolve(dirname(path), asset.path),
        undefined,
        `assets.${id}.path: Cannot probe`,
      );
  for (const [id, font] of Object.entries(definition.fonts ?? {}))
    if ('path' in font)
      await add(
        resolve(dirname(path), font.path),
        undefined,
        `Cannot load fonts.${id}.path:`,
      );
  const orderedInputs = [...inputs.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return locateBuild(
    {
      cache,
      path,
      compositionSha256: hashJson(
        graphics.size ? [definition, graphicBundleKeys(graphics)] : definition,
      ),
      params,
      preview,
      inputs: orderedInputs,
      files,
      identities,
    },
    definition,
    quality,
  );
}

function locateBuild(
  build: BuildInputs,
  definition: ParsedVideoDefinition,
  quality: RenderQuality = build.preview ? 'fast' : 'quality',
) {
  const id = hashJson([
    1,
    build.path,
    build.compositionSha256,
    build.params,
    build.preview,
    build.inputs,
    ...(Object.values(definition.assets ?? {}).some(
      (asset) =>
        asset.kind !== 'graphic' && asset.recipe?.some(inheritsRenderQuality),
    )
      ? [quality === 'fast' ? 'fast' : 'quality']
      : []),
  ]);
  return {
    ...build,
    id,
    directory: join(buildReceiptsDirectory(build.cache), id),
  };
}

type BuildIdentity = Awaited<ReturnType<typeof prepareVideoBuild>>;
const checkpoints = new WeakMap<CompiledVideo, BuildIdentity>();

async function diagnoseBuildSourceChange(
  error: unknown,
  files: BuildIdentity['files'],
  signal?: AbortSignal,
) {
  const change = findSourceChange(error);
  if (change && change.change.content === 'unknown') {
    const file = change.change.path;
    const canonical = await realpath(file).catch(() => file);
    await change.compareContent(
      files.get(file) ?? files.get(canonical),
      signal,
    );
  }
}

export function checkpointQualityCompilation(
  video: CompiledVideo,
  definition: ParsedVideoDefinition,
  quality: RenderQuality,
  preview: boolean,
  signal: AbortSignal | undefined,
  compile: (recovery?: RecipeRecovery) => Promise<CompiledVideo>,
) {
  const previous = checkpoints.get(video);
  if (!previous) return compile();
  // Use the original recorded composition and input fingerprints.
  const build = locateBuild({ ...previous, preview }, definition, quality);
  return checkpointCompilation(build, signal, (record) =>
    compile({ record, sources: build.files }),
  );
}

export function authoredInputs(video: CompiledVideo) {
  return checkpoints.get(video)?.inputs.map(({ path }) => path) ?? [];
}

export async function diagnoseCompiledSourceChange(
  video: CompiledVideo,
  error: unknown,
  signal?: AbortSignal,
) {
  const build = checkpoints.get(video);
  if (build) await diagnoseBuildSourceChange(error, build.files, signal);
}

export async function checkpointCompilation(
  build: BuildIdentity,
  signal: AbortSignal | undefined,
  compile: (record: (stage: Stage) => Promise<void>) => Promise<CompiledVideo>,
) {
  const {
    directory,
    inputs,
    identities,
    id,
    compositionSha256,
    params,
    preview,
  } = build;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await fileLease(join(directory, 'compile.sqlite'), signal);
  const path = join(directory, 'compile.json');
  const steps = new Map<string, Stage>();
  let writes = Promise.resolve();
  const checkpoint = (
    state: CompileReceipt['state'],
    extra: Partial<CompileReceipt> = {},
  ) => {
    const receipt: CompileReceipt = {
      version: 1,
      state,
      id,
      definition: build.path,
      compositionSha256,
      ...(params !== undefined && { params }),
      preview,
      inputs,
      steps: [...steps.values()],
      ...extra,
    };
    writes = writes.then(() => writeCheckpoint(path, receipt));
    return writes;
  };
  try {
    await clearPartialCheckpoints(directory, 'compile.json');
    const previous = compileSchema.safeParse(await readCheckpoint(path));
    if (previous.success && previous.data.id === id)
      for (const step of previous.data.steps)
        steps.set(JSON.stringify([step.assetId, step.step]), step);
    await checkpoint('compiling');
    try {
      const video = await compile((stage) => {
        steps.set(JSON.stringify([stage.assetId, stage.step]), stage);
        return checkpoint('compiling');
      });
      for (const [input, identity] of identities) {
        const observed = videoInputIdentity(input);
        if (observed !== identity)
          throw new SourceChangedError(
            input,
            'compilation',
            identity,
            observed,
          );
      }
      await checkpoint('compiled', { frameCount: video.frameCount });
      checkpoints.set(video, build);
      return video;
    } catch (error) {
      // Preserve the original error if persistence itself is the failure.
      await checkpoint('failed', { error: errorMessage(error) }).catch(
        () => {},
      );
      await diagnoseBuildSourceChange(error, build.files, signal);
      throw error;
    }
  } finally {
    release?.();
  }
}

export async function checkpointRender<T extends object>(
  video: CompiledVideo,
  output: string,
  settings: unknown,
  signal: AbortSignal | undefined,
  render: (
    scratch?: string,
    onVerified?: (path: string) => Promise<void>,
  ) => Promise<T>,
): Promise<T & { outputFingerprint?: FileFingerprint }> {
  const build = checkpoints.get(video);
  if (!build) return render();
  const parent = await realpath(dirname(resolve(output)));
  const destination = join(parent, basename(output));
  const base = join(build.directory, `render-${hashJson(destination)}`);
  const release = await fileLease(base + '.sqlite', signal);
  const path = base + '.json';
  const receipt: RenderReceipt = {
    version: 1,
    output: destination,
    state: 'rendering',
    settings,
  };
  try {
    await clearPartialCheckpoints(build.directory, basename(path));
    const previous = renderSchema.safeParse(await readCheckpoint(path));
    if (previous.success && previous.data.output === destination) {
      receipt.published = previous.data.verified
        ? reconcilePublication(
            previous.data,
            await readOutputFingerprint(destination, signal),
          )
        : previous.data.published;
      const previousScratch = previous.data.scratch;
      if (
        previousScratch &&
        dirname(previousScratch) === parent &&
        new RegExp(`^${scratchPrefix}[a-zA-Z0-9]{6}$`).test(
          basename(previousScratch),
        )
      )
        await rm(previousScratch, { recursive: true, force: true });
    }
    const scratch = await mkdtemp(join(parent, scratchPrefix));
    receipt.scratch = scratch;
    try {
      await writeCheckpoint(path, receipt);
      const result = await render(scratch, async (staged) => {
        const { bytes, sha256 } = await fingerprintFile(staged, signal);
        await syncPath(staged);
        receipt.verified = { bytes, sha256 };
        await writeCheckpoint(path, receipt);
      });
      await syncPath(parent);
      receipt.state = 'rendered';
      const outputFingerprint = receipt.verified;
      if (outputFingerprint)
        receipt.published = { settings, verified: outputFingerprint };
      delete receipt.verified;
      delete receipt.scratch;
      await writeCheckpoint(path, receipt);
      return {
        ...result,
        ...(outputFingerprint && { outputFingerprint }),
      };
    } catch (error) {
      receipt.state = 'failed';
      receipt.error = errorMessage(error);
      await writeCheckpoint(path, receipt).catch(() => {});
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    release?.();
  }
}

// A crash can happen after the rename but before the publication receipt is saved.
function reconcilePublication(
  { published, settings, verified }: RenderReceipt,
  actual: Fingerprint | undefined,
  includePending = true,
) {
  if (
    includePending &&
    verified &&
    matchesFingerprint(actual, verified) &&
    !(published && matchesFingerprint(actual, published.verified))
  )
    return { settings, verified };
  return published;
}

export async function readCheckpoint(path: string): Promise<unknown> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function clearPartialCheckpoints(directory: string, basename: string) {
  for (const entry of await readdir(directory))
    if (entry.startsWith(basename + '.') && entry.endsWith('.tmp'))
      await rm(join(directory, entry), { force: true });
}

async function interrupted(lease: string, signal?: AbortSignal) {
  const release = await fileLease(lease, signal, false);
  release?.();
  return release !== null;
}

export async function inspectBuildCheckpoint(
  build: BuildIdentity,
  signal?: AbortSignal,
) {
  const {
    id,
    path,
    cache,
    directory,
    inputs,
    params,
    compositionSha256,
    preview,
  } = build;
  const parsed = compileSchema.safeParse(
    await readCheckpoint(join(directory, 'compile.json')),
  );
  const result = {
    version: 1 as const,
    id,
    definition: path,
    compositionSha256,
    cache,
    inputs,
    ...(params !== undefined && { params }),
    preview,
  };
  if (
    !parsed.success ||
    parsed.data.id !== id ||
    (parsed.data.state === 'compiled' && parsed.data.frameCount === undefined)
  )
    return {
      ...result,
      state: (await lstat(directory).catch((error: unknown) => {
        if (!missing(error)) throw error;
      }))
        ? ('missing-or-invalid' as const)
        : ('unbuilt' as const),
      steps: [],
      renders: [],
    };

  const compile = parsed.data;
  const state =
    compile.state === 'compiling' &&
    (await interrupted(join(directory, 'compile.sqlite'), signal))
      ? 'interrupted'
      : compile.state;
  const steps = [];
  for (const step of compile.steps) {
    const result = await findMediaEntry(cache, step.key, step.format, signal);
    const entry = result?.entry;
    steps.push({
      ...step,
      reusable: entry !== undefined,
      ...(entry && { sha256: entry.sha256 }),
    });
  }
  const renders = [];
  for (const file of (await readdir(directory)).sort()) {
    if (!/^render-[a-f0-9]{64}\.json$/.test(file)) continue;
    const parsed = renderSchema.safeParse(
      await readCheckpoint(join(directory, file)),
    );
    if (!parsed.success) continue;
    const { output, verified, published, settings, error } = parsed.data;
    if (
      file !== `render-${hashJson(output)}.json` ||
      output !== resolve(output)
    )
      continue;
    let status: RenderReceipt['state'] | 'interrupted' | 'missing-or-corrupt' =
      parsed.data.state;
    if (
      status === 'rendering' &&
      (await interrupted(
        join(directory, file.slice(0, -5) + '.sqlite'),
        signal,
      ))
    )
      status = 'interrupted';
    const actual =
      published || (verified && status !== 'rendering')
        ? await inspectOutputFingerprint(output, signal)
        : undefined;
    const publication = reconcilePublication(
      parsed.data,
      actual,
      status !== 'rendering',
    );
    const publishedState: 'rendered' | 'missing-or-corrupt' | undefined =
      publication
        ? matchesFingerprint(actual, publication.verified)
          ? 'rendered'
          : 'missing-or-corrupt'
        : undefined;
    renders.push({
      output,
      settings: publication ? publication.settings : settings,
      state:
        publishedState ??
        (status === 'rendered' ? 'missing-or-corrupt' : status),
      ...(publishedState === 'rendered' &&
        publication && { verified: publication.verified }),
      ...(!publication && error && { error }),
      ...(publication &&
        publication === published &&
        status !== 'rendered' && {
          lastAttempt: { state: status, settings, ...(error && { error }) },
        }),
    });
  }
  return {
    ...result,
    state,
    steps,
    renders,
    ...(compile.frameCount !== undefined && { frameCount: compile.frameCount }),
    ...(compile.error !== undefined && { error: compile.error }),
  };
}

export async function* readCompileReceipts(
  cache: string,
  signal?: AbortSignal,
) {
  const builds = buildReceiptsDirectory(cache);
  const info = await ifPresent(lstat(builds));
  if (!info) return;
  if (!info.isDirectory()) {
    yield { path: builds };
    return;
  }
  const names = (await ifPresent(readdir(builds)))?.sort() ?? [];
  for (const name of names) {
    signal?.throwIfAborted();
    if (!sha256.safeParse(name).success) continue;
    const directory = join(builds, name);
    const path = join(directory, 'compile.json');
    const info = await ifPresent(lstat(directory));
    const parsed = compileSchema.safeParse(
      info?.isDirectory() ? await readCheckpoint(path) : null,
    );
    yield {
      path,
      receipt:
        parsed.success &&
        parsed.data.id === name &&
        resolve(parsed.data.definition) === parsed.data.definition
          ? parsed.data
          : undefined,
    };
  }
}

/** Read historical build and publish receipts for one definition. */
export async function listDefinitionBuildArtifacts(
  cache: string,
  definition: string,
  signal?: AbortSignal,
) {
  const files: {
    path: string;
    role?: string;
    owner: string;
    cacheFingerprint?: MediaFingerprint;
  }[] = [];
  const cacheEntries = new Map<string, ReturnType<typeof readMediaEntry>>();
  const fingerprints = new Map<
    string,
    ReturnType<typeof inspectOutputFingerprint>
  >();
  for await (const { path, receipt } of readCompileReceipts(cache, signal)) {
    if (receipt?.definition !== definition) continue;
    const directory = dirname(path);
    files.push({ path, role: 'cache-manifest', owner: definition });
    for (const { key, format, assetId } of receipt.steps) {
      const media = join(cache, key, 'media.' + format);
      let verified = cacheEntries.get(media);
      if (!verified) {
        verified = readMediaEntry(join(cache, key), key, format, signal);
        cacheEntries.set(media, verified);
      }
      const entry = await verified;
      files.push({
        path: media,
        ...(entry && {
          role: 'cache-media',
          cacheFingerprint: { identity: entry.identity, sha256: entry.sha256 },
        }),
        owner: 'assets.' + assetId,
      });
      files.push({
        path: join(cache, key, 'result.json'),
        ...(entry && { role: 'cache-manifest' }),
        owner: 'assets.' + assetId,
      });
    }
    for (const name of (await readdir(directory)).sort()) {
      if (!/^render-[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      const render = renderSchema.safeParse(await readCheckpoint(path));
      if (
        !render.success ||
        render.data.output !== resolve(render.data.output) ||
        name !== `render-${hashJson(render.data.output)}.json`
      )
        continue;
      files.push({ path, role: 'render-report', owner: definition });
      const { output, published, verified, state } = render.data;
      if (!published && !verified && state !== 'rendered') continue;
      let pending = fingerprints.get(output);
      if (!pending) {
        pending = inspectOutputFingerprint(output, signal);
        fingerprints.set(output, pending);
      }
      const actual = await pending;
      const publication = reconcilePublication(render.data, actual);
      if (publication || state === 'rendered')
        files.push({
          path: output,
          role:
            publication && matchesFingerprint(actual, publication.verified)
              ? 'export'
              : 'unverified-export',
          owner: path,
        });
    }
  }
  return files;
}
