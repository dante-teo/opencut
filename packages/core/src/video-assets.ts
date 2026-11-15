import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  isStillImage,
  probeMedia,
  probeRecipeMedia,
  validateEmbeddedFont,
  videoSourceDuration,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import type { MediaAsset } from './project.js';
import { VideoDefinitionError } from './video-definition.js';
import type { VideoAssetDefinition } from './video-definition.js';
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { IdentifiedMedia, RecordVideoInput } from './video-input.js';
import { inspectRecipe } from './video-recipe.js';
import type {
  RecipeMedia,
  RecipeInput,
  VideoRecipeInspection,
} from './video-recipe.js';
import { processVideoRecipes } from './video-processing.js';
import type {
  RecipeRecovery,
  VideoProcessingOptions,
} from './video-processing.js';

export type VideoSourceProbes = Map<
  string,
  {
    identity: string;
    standard?: Promise<MediaMetadata>;
    recipe?: Promise<MediaMetadata>;
  }
>;

export interface VideoAssetOptions {
  signal?: AbortSignal | undefined;
  probes?: VideoSourceProbes;
  processing?: VideoProcessingOptions | undefined;
  recovery?: RecipeRecovery;
  inputs?: {
    record: RecordVideoInput;
    snapshotMedia(path: string): Promise<string>;
  };
}

export interface CompiledVideoAsset {
  asset: MediaAsset;
  media?: IdentifiedMedia;
}

type PreparedAsset =
  | { id: string; compiled: CompiledVideoAsset }
  | {
      id: string;
      definition: VideoAssetDefinition;
      path: string;
      recipe: RecipeInput;
    };

export async function compileVideoAssets(
  directory: string,
  definitions: Readonly<Record<string, VideoAssetDefinition>>,
  referenced: ReadonlySet<string>,
  {
    signal,
    probes = new Map(),
    inputs,
    processing,
    recovery,
  }: VideoAssetOptions,
) {
  const prepared: PreparedAsset[] = [];
  const required: RecipeInput[] = [];
  for (const id of Object.keys(definitions).sort()) {
    const definition = definitions[id]!;
    const path = resolve(directory, definition.path);
    inputs?.record(identifyVideoInput(path, 'media'));
    if (definition.recipe) {
      const recipe = await readAssetRecipe(id, definition, path, {
        signal,
        record: inputs?.record,
        probes,
      });
      prepared.push({ id, definition, path, recipe });
      if (referenced.has(id)) required.push(recipe);
    } else {
      const source = inputs ? await inputs.snapshotMedia(path) : path;
      const media = await probeAsset(id, source, { signal, probes });
      prepared.push({
        id,
        compiled: compileProbedAsset(id, definition, media),
      });
    }
  }

  const processed = await processVideoRecipes(
    required,
    processing,
    signal,
    recovery,
  );
  const assets = new Map<string, CompiledVideoAsset>();
  const recipes: VideoRecipeInspection[] = [];
  for (const asset of prepared) {
    if ('compiled' in asset) {
      assets.set(asset.id, asset.compiled);
      continue;
    }
    const { id, definition, path, recipe } = asset;
    recipes.push(recipe.inspection);
    if (videoInputIdentity(path) !== recipe.input.identity)
      throw new VideoDefinitionError(
        `assets.${id}.path: Media changed during compilation.`,
      );
    const media = processed.get(id);
    if (media) {
      const pinned = inputs
        ? await pinDerivedAsset(id, media, inputs.snapshotMedia)
        : media;
      assets.set(id, compileProbedAsset(id, definition, pinned));
    } else {
      assets.set(id, {
        asset: describeUnusedRecipe(
          id,
          definition,
          recipe.inspection.steps.at(-1)!.media,
        ),
      });
    }
  }
  return { assets, recipes };
}

export async function inspectAssetRecipes(
  directory: string,
  definitions: Readonly<Record<string, VideoAssetDefinition>>,
  signal?: AbortSignal,
) {
  const recipes: VideoRecipeInspection[] = [];
  for (const id of Object.keys(definitions).sort()) {
    const definition = definitions[id]!;
    if (!definition.recipe) continue;
    const { inspection } = await readAssetRecipe(
      id,
      definition,
      resolve(directory, definition.path),
      { signal },
    );
    recipes.push(inspection);
  }
  signal?.throwIfAborted();
  return recipes;
}

async function readAssetRecipe(
  id: string,
  definition: VideoAssetDefinition,
  path: string,
  options: ProbeOptions,
): Promise<RecipeInput> {
  if (definition.freezeFrame)
    throw new VideoDefinitionError(
      `assets.${id}: Choose either recipe or freezeFrame.`,
    );
  const input = await probeAsset(id, path, { ...options, recipe: true });
  return {
    input,
    inspection: inspectRecipe(
      id,
      input.metadata,
      definition.recipe!,
      definition.kind,
    ),
  };
}

interface ProbeOptions {
  signal?: AbortSignal | undefined;
  probes?: VideoSourceProbes;
  recipe?: boolean;
  record?: RecordVideoInput | undefined;
}

async function probeAsset(
  id: string,
  path: string,
  { signal, probes, recipe = false, record }: ProbeOptions,
): Promise<IdentifiedMedia> {
  signal?.throwIfAborted();
  const identity = videoInputIdentity(path);
  let metadata: MediaMetadata;
  try {
    const canonical = await realpath(path);
    record?.(identifyVideoInput(canonical, 'media'));
    const probe = recipe ? probeRecipeMedia : probeMedia;
    let entry = probes?.get(canonical);
    if (identity && entry?.identity !== identity) {
      entry = { identity };
      probes?.set(canonical, entry);
    }
    const mode = recipe ? 'recipe' : 'standard';
    const pending = entry?.[mode] ?? probe(canonical, signal);
    if (entry) entry[mode] = pending;
    try {
      metadata = await pending;
    } catch (error) {
      if (entry?.[mode] === pending) delete entry[mode];
      throw error;
    }
  } catch (cause) {
    signal?.throwIfAborted();
    throw new VideoDefinitionError(
      `assets.${id}.path: Cannot probe '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (
    !identity ||
    videoInputIdentity(path) !== identity ||
    videoInputIdentity(metadata.path) !== identity
  )
    throw new VideoDefinitionError(
      recipe
        ? `assets.${id}.path: Media changed during recipe inspection.`
        : `assets.${id}.path: Media '${path}' changed during compilation. Retry after the write completes.`,
    );
  return { metadata, identity };
}

async function pinDerivedAsset(
  id: string,
  { metadata, identity }: IdentifiedMedia,
  snapshotMedia: (path: string) => Promise<string>,
): Promise<IdentifiedMedia> {
  const path = await snapshotMedia(metadata.path);
  const snapshotIdentity = videoInputIdentity(path);
  if (!snapshotIdentity || videoInputIdentity(metadata.path) !== identity)
    throw new VideoDefinitionError(
      `assets.${id}: Recipe result changed during compilation.`,
    );
  return { metadata: { ...metadata, path }, identity: snapshotIdentity };
}

function describeUnusedRecipe(
  id: string,
  definition: VideoAssetDefinition,
  media: RecipeMedia,
): MediaAsset {
  const { kind, width, height, durationSeconds, frameRate, hasAudio } = media;
  return {
    ...assetReference(id, definition),
    mediaTypes:
      kind === 'audio' ? ['audio'] : hasAudio ? ['video', 'audio'] : ['video'],
    metadata: {
      kind,
      width,
      height,
      durationSeconds,
      frameRate,
      hasAudio,
      formatName: null,
      videoCodec: null,
      audioCodec: null,
      frameRateRatio: null,
    },
  };
}

function assetReference(
  id: string,
  { path, name = id, provenance }: VideoAssetDefinition,
) {
  return { id, name, provenance, file: { type: 'relative' as const, path } };
}

/** Translate probe metadata into the compiled asset fields. */
export function describeMediaAsset(probed: MediaMetadata) {
  const image = isStillImage(probed);
  const durationSeconds = image ? null : probed.durationSeconds;
  const videoMicroseconds = Math.round(
    (videoSourceDuration(probed) ?? 0) * 1_000_000,
  );
  const mediaTypes: MediaAsset['mediaTypes'] = [];
  if (probed.video) mediaTypes.push('video');
  if (probed.audio) mediaTypes.push('audio');
  const asset: Pick<MediaAsset, 'mediaTypes' | 'duration'> & {
    metadata: NonNullable<MediaAsset['metadata']>;
  } = {
    mediaTypes,
    metadata: {
      kind: image ? 'image' : probed.video ? 'video' : 'audio',
      formatName: probed.formatName,
      durationSeconds,
      ...(!image &&
        Number.isSafeInteger(videoMicroseconds) &&
        videoMicroseconds > 0 && {
          videoDuration: {
            numerator: videoMicroseconds,
            denominator: 1_000_000,
          },
        }),
      width: probed.video?.width ?? null,
      height: probed.video?.height ?? null,
      videoCodec: probed.video?.codec ?? null,
      audioCodec: probed.audio?.codec ?? null,
      frameRate: image ? null : (probed.video?.frameRate ?? null),
      frameRateRatio: image ? null : (probed.video?.frameRateRatio ?? null),
      hasAudio: probed.hasAudio,
    },
  };
  // ffprobe exposes decimal seconds. Record the source bound to microsecond precision.
  if (durationSeconds !== null && durationSeconds > 0) {
    const numerator = Math.round(durationSeconds * 1_000_000);
    if (Number.isSafeInteger(numerator) && numerator > 0)
      asset.duration = { numerator, denominator: 1_000_000 };
  }
  return asset;
}

export async function readEmbeddedFont(path: string) {
  const file = await open(path, 'r');
  let bytes: Buffer;
  try {
    const { size } = await file.stat();
    if (!size || size > 2_097_152)
      throw new Error('Choose a TTF or OTF font up to 2 MiB.');
    bytes = Buffer.alloc(size);
    const { bytesRead } = await file.read(bytes, 0, size, 0);
    if (bytesRead !== size)
      throw new Error('The font file changed while reading.');
  } finally {
    await file.close();
  }
  await validateEmbeddedFont(bytes);
  return bytes.toString('base64');
}

function compileProbedAsset(
  id: string,
  definition: VideoAssetDefinition,
  media: IdentifiedMedia,
): CompiledVideoAsset {
  const source = media.metadata;
  const { path, kind, freezeFrame } = definition;
  const described = describeMediaAsset(source);
  if (freezeFrame) {
    const end = videoSourceDuration(source);
    if (
      kind !== 'image' ||
      described.metadata.kind !== 'video' ||
      !source.video?.frameRate ||
      (end !== null && freezeFrame.numerator / freezeFrame.denominator >= end)
    )
      throw new VideoDefinitionError(
        `assets.${id}.freezeFrame: Choose a source time inside a timed video and set kind to image.`,
      );
  }
  const asset: MediaAsset = {
    ...assetReference(id, definition),
    ...(freezeFrame && { freezeFrame }),
    mediaTypes: freezeFrame ? ['video'] : described.mediaTypes,
    metadata: freezeFrame
      ? {
          ...described.metadata,
          kind: 'image',
          durationSeconds: null,
          videoDuration: undefined,
          frameRate: null,
          frameRateRatio: null,
          hasAudio: false,
          audioCodec: null,
          videoCodec: 'png',
        }
      : described.metadata,
  };
  if (
    asset.metadata?.kind !== kind ||
    asset.mediaTypes.length === 0 ||
    (kind === 'video' && !source.video?.frameRate)
  )
    throw new VideoDefinitionError(
      `assets.${id}: '${path}' does not match the declared ${kind} source and streams.`,
    );
  return { media, asset };
}
