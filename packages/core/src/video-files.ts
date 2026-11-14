import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  audioSourceDuration,
  probeMedia,
  videoSourceDuration,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import { describeMediaAsset } from './assets.js';
import {
  canonicalProjectFilePath,
  resolveMediaReference,
} from './project-files.js';
import {
  createProject,
  deserializeProject,
  validateProject,
} from './project.js';
import type { MediaAsset, Project, TimelineClip, Track } from './project.js';
import { bindRenderSources } from './render-files.js';
import { planProjectRender } from './render-plan.js';
import { frameTime, rationalTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import { videoDefinitionSchema } from './video-definition.js';
import type { VideoDefinition } from './video-definition.js';

export class VideoDefinitionError extends Error {
  override name = 'VideoDefinitionError';
  readonly code = 'INVALID_VIDEO_DEFINITION';
}

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts') || file.endsWith('.video.json');
}

async function readDefinition(path: string, json: boolean): Promise<unknown> {
  if (json) return (await readDefinitionJson(path)).value;

  // Node keys ESM modules by URL. Pass the build ID along each local import
  // edge, including dynamic imports, while leaving package imports alone.
  const build = randomUUID();
  const parameter = 'opencut-build';
  const url = pathToFileURL(path);
  url.searchParams.set(parameter, build);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const { parentURL } = context;
      if (
        !parentURL?.startsWith('file:') ||
        new URL(parentURL).searchParams.get(parameter) !== build ||
        !resolved.url.startsWith('file:') ||
        !/^(?:\.{1,2}\/|\/|file:)/.test(specifier)
      )
        return resolved;
      const dependency = new URL(resolved.url);
      dependency.searchParams.set(parameter, build);
      return { ...resolved, url: dependency.href };
    },
  });
  try {
    return (await import(url.href)).default as unknown;
  } catch (cause) {
    throw definitionLoadError(path, cause);
  } finally {
    hooks.deregister();
  }
}

async function readDefinitionJson(path: string) {
  try {
    const json = await readFile(path, 'utf8');
    return { json, value: JSON.parse(json) as unknown };
  } catch (cause) {
    throw definitionLoadError(path, cause);
  }
}

function definitionLoadError(path: string, cause: unknown) {
  return new VideoDefinitionError(
    `Cannot load '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
}

function stableId(kind: string, ...parts: unknown[]) {
  return (
    kind +
    '-' +
    createHash('sha256')
      .update(JSON.stringify(parts))
      .digest('hex')
      .slice(0, 24)
  );
}

function reduce(time: RationalTime) {
  return rationalTime(BigInt(time.numerator), BigInt(time.denominator));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

type BoundRenderPlan = Awaited<ReturnType<typeof bindRenderSources>>;
type AuthoredTrack = VideoDefinition['tracks'][number];
type AuthoredClip = AuthoredTrack['clips'][number];
type AuthoredAssets = NonNullable<VideoDefinition['assets']>;

export interface CompiledVideo {
  readonly path: string;
  /** A deeply frozen project snapshot. */
  readonly project: Project;
  resolveRender(): Promise<
    BoundRenderPlan & { sourceMetadata: ReadonlyMap<string, MediaMetadata> }
  >;
}

/** Compile a fresh definition using shared project rules and metadata-only probes. */
export async function compileVideo(
  file: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<CompiledVideo> {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts or .video.json file.');
  signal?.throwIfAborted();
  const resolved = resolve(file);
  const path = await realpath(resolved).catch((cause: unknown) => {
    throw new VideoDefinitionError(
      `Cannot open video definition '${resolved}'.`,
      { cause },
    );
  });
  // The selected filename determines how to load a symlink alias. Both loading
  // and media resolution use the same physical definition path.
  const value = await readDefinition(path, file.endsWith('.video.json'));
  return compileDefinition(path, value, signal);
}

/** A .video.json filename can also belong to a saved project. Read it once. */
export async function readVideoJsonForPreview(
  file: string,
  signal: AbortSignal,
) {
  const path = await canonicalProjectFilePath(resolve(file));
  const { json, value } = await readDefinitionJson(path);
  if (
    value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'schemaVersion')
  )
    return { path, project: deserializeProject(json) };
  return compileDefinition(await realpath(path), value, signal);
}

async function compileDefinition(
  path: string,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<CompiledVideo> {
  const parsed = videoDefinitionSchema.safeParse(value);
  signal?.throwIfAborted();
  if (!parsed.success)
    throw new VideoDefinitionError(
      parsed.error.issues
        .map(
          ({ path, message }) =>
            `${path.length ? path.join('.') : 'Definition'}: ${message}`,
        )
        .join('\n'),
    );

  const { project, clipLocations } = buildProject(parsed.data);
  const assets = parsed.data.assets ?? {};
  const probes = new Map<string, MediaMetadata>();
  const assetPaths = new Map<string, string>();
  for (const asset of project.assets)
    assetPaths.set(
      asset.id,
      await probeAsset(asset, assets[asset.id]!.kind, path, probes, signal),
    );

  for (const [index, clip] of project.clips.entries()) {
    if (clip.assetId === undefined) continue;
    const kind = assets[clip.assetId]!.kind;
    if (kind === 'image') continue;
    const source = probes.get(assetPaths.get(clip.assetId)!)!;
    const duration =
      kind === 'audio'
        ? audioSourceDuration(source)
        : videoSourceDuration(source);
    if (!withinSource(clip.sourceOut, duration))
      throw new VideoDefinitionError(
        `${clipLocations[index]}.sourceOut: Out point exceeds the duration of '${clip.assetId}' or its duration is unknown.`,
      );
  }

  let renderPlan: BoundRenderPlan;
  try {
    renderPlan = await bindRenderSources(
      planProjectRender(project),
      ({ assetId }) => assetPaths.get(assetId)!,
    );
  } catch (cause) {
    throw new VideoDefinitionError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
  signal?.throwIfAborted();
  return Object.freeze({
    path,
    project: freeze(project),
    async resolveRender() {
      return {
        ...structuredClone(renderPlan),
        sourceMetadata: new Map(probes),
      };
    },
  });
}

function buildProject(definition: VideoDefinition) {
  const { canvas, assets = {}, tracks, name = 'Untitled video' } = definition;
  const { frameRate: authoredRate, ...settings } = canvas;
  const frameRate =
    typeof authoredRate === 'number'
      ? { numerator: authoredRate, denominator: 1 }
      : reduce(authoredRate);

  const project = createProject({
    name,
    id: stableId('video', name),
    createdAt: '1970-01-01T00:00:00.000Z',
    settings: { ...settings, frameRate },
  });

  for (const id of Object.keys(assets).sort()) {
    const asset = assets[id]!;
    project.assets.push({
      id,
      name: id,
      file: { type: 'relative', path: asset.path },
      mediaTypes: [asset.kind === 'audio' ? 'audio' : 'video'],
    });
  }

  const occurrences = new Map<string, number>();
  const clipLocations: string[] = [];
  for (const [trackIndex, track] of tracks.entries()) {
    const trackId = track.id ?? generatedTrackId(track, occurrences);
    const properties: Track = {
      id: trackId,
      name: track.name ?? track.type,
      type: track.type === 'audio' ? 'audio' : 'video',
    };
    if (track.type === 'audio' || track.type === 'video') {
      properties.volume = track.volume;
      properties.muted = track.muted;
    }
    project.tracks.push(properties);
    for (const [clipIndex, clip] of track.clips.entries()) {
      const location = `tracks.${trackIndex}.clips.${clipIndex}`;
      if ('asset' in clip) {
        const asset = Object.hasOwn(assets, clip.asset)
          ? assets[clip.asset]
          : undefined;
        if (!asset || asset.kind !== track.type)
          throw new VideoDefinitionError(
            `${location}.asset: Expected a named ${track.type} asset; received '${clip.asset}'.`,
          );
      }
      clipLocations.push(location);
      project.clips.push(compileClip(clip, frameRate, trackId, location));
    }
  }

  const validated = validateProject(project);
  if (!validated.success)
    throw new VideoDefinitionError(
      validated.error.issues
        .map(
          ({ path, message }) =>
            `${path.replace(/^\/clips\/(\d+)/, (_, index: string) => clipLocations[Number(index)]!)}: ${message}`,
        )
        .join('\n'),
      { cause: validated.error },
    );
  return { project: validated.project, clipLocations };
}

function generatedTrackId(
  track: AuthoredTrack,
  occurrences: Map<string, number>,
) {
  const key = stableId('track', track);
  const count = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, count);
  return count === 1 ? key : `${key}-${count}`;
}

function compileClip(
  clip: AuthoredClip,
  frameRate: FrameRate,
  trackId: string,
  location: string,
): TimelineClip {
  const time = (frame: number, field: string) => {
    try {
      return frameTime(frame, frameRate);
    } catch (cause) {
      throw new VideoDefinitionError(
        `${location}.${field}: Frame position exceeds the supported rational time range.`,
        { cause },
      );
    }
  };
  const placement = {
    id: clip.id ?? stableId('clip', trackId, clip.at),
    trackId,
    timelineStart: time(clip.at, 'at'),
    ...('visual' in clip && { visual: clip.visual }),
  };
  if ('duration' in clip)
    return {
      ...placement,
      sourceIn: time(0, 'sourceIn'),
      sourceOut: time(clip.duration, 'duration'),
      ...('asset' in clip ? { assetId: clip.asset } : { text: clip.text }),
    };

  return {
    ...placement,
    assetId: clip.asset,
    sourceIn: time(clip.sourceIn ?? 0, 'sourceIn'),
    sourceOut: time(clip.sourceOut, 'sourceOut'),
    ...(clip.speed && { speed: reduce(clip.speed) }),
    volume: clip.volume,
    muted: clip.muted,
    ...(clip.fadeIn !== undefined && {
      fadeIn: { duration: time(clip.fadeIn, 'fadeIn') },
    }),
    ...(clip.fadeOut !== undefined && {
      fadeOut: { duration: time(clip.fadeOut, 'fadeOut') },
    }),
  };
}

async function probeAsset(
  asset: MediaAsset,
  kind: AuthoredAssets[string]['kind'],
  definitionPath: string,
  probes: Map<string, MediaMetadata>,
  signal: AbortSignal | undefined,
) {
  signal?.throwIfAborted();
  const sourcePath = resolveMediaReference(asset.file, definitionPath);
  let source: MediaMetadata;
  try {
    const canonical = await realpath(sourcePath);
    source =
      probes.get(canonical) ?? freeze(await probeMedia(canonical, signal));
    probes.set(canonical, source);
  } catch (cause) {
    signal?.throwIfAborted();
    throw new VideoDefinitionError(
      `assets.${asset.id}.path: Cannot probe '${sourcePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const { mediaTypes, metadata } = describeMediaAsset(source);
  if (
    metadata.kind !== kind ||
    mediaTypes.length === 0 ||
    (kind === 'video' && !source.video?.frameRate)
  )
    throw new VideoDefinitionError(
      `assets.${asset.id}: '${asset.file.path}' is not a supported ${kind} source.`,
    );

  // Source bounds are validated against each stream. Container duration is
  // inspection metadata and is not a second bound on compiled clips.
  asset.mediaTypes = mediaTypes;
  asset.metadata = metadata;
  return source.path;
}

function withinSource(sourceOut: RationalTime, seconds: number | null) {
  // FFprobe reports decimal seconds. Match the compositing preflight's 1 µs
  // tolerance when comparing an exact authored frame against that measurement.
  return (
    seconds !== null &&
    seconds > 0 &&
    sourceOut.numerator / sourceOut.denominator <= seconds + 0.000001
  );
}
