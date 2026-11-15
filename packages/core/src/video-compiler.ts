import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  audioSourceDuration,
  probeMedia,
  videoSourceDuration,
  validateEmbeddedFont,
  validateSubtitleBurnIn,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import { describeMediaAsset, readEmbeddedFont } from './video-assets.js';
import { validateProject } from './project.js';
import type { MediaAsset, Project, TimelineClip } from './project.js';
import { bindRenderSources } from './render-sources.js';
import { planProjectRender } from './render-plan.js';
import { frameTime, rationalTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import { videoDefinitionSchema } from './video-definition.js';
import type { VideoDefinition } from './video-definition.js';
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { RecordVideoInput } from './video-input.js';

export class VideoDefinitionError extends Error {
  override name = 'VideoDefinitionError';
  readonly code = 'INVALID_VIDEO_DEFINITION';
}

export function definitionLoadError(path: string, cause: unknown) {
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

type BoundRenderPlan = ReturnType<typeof bindRenderSources>;
type AuthoredTrack = VideoDefinition['tracks'][number];
type AuthoredClip = AuthoredTrack['clips'][number];
type AuthoredTime = AuthoredClip['at'];
type AuthoredAsset = NonNullable<VideoDefinition['assets']>[string];
type CompiledAsset = {
  asset: MediaAsset;
  source: MediaMetadata;
  sourceIdentity: string;
};
type FontStyle = {
  font?: string | undefined;
  embeddedFont?: string | null | undefined;
};
export type CompilationOptions = {
  signal?: AbortSignal | undefined;
  probes?: VideoSourceProbes;
  preview?: boolean;
  inputs?: {
    record: RecordVideoInput;
    snapshotMedia(path: string): Promise<string>;
  };
};

const epoch = '1970-01-01T00:00:00.000Z';
export type VideoSourceProbes = Map<string, MediaMetadata>;

export interface CompiledVideo {
  readonly path: string;
  /** A deeply frozen project snapshot. */
  readonly project: Project;
  readonly frameCount: number;
  /** Media identity recorded before probing, keyed by the bound source path. */
  sourceIdentity(path: string): string | undefined;
  resolveRender(): Promise<
    BoundRenderPlan & { sourceMetadata: ReadonlyMap<string, MediaMetadata> }
  >;
}

export async function compileDefinition(
  path: string,
  value: unknown,
  options: CompilationOptions = {},
): Promise<CompiledVideo> {
  const { signal, preview = false } = options;
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

  const { project, assets } = await buildProject(path, parsed.data, options);
  let renderPlan: BoundRenderPlan;
  try {
    const plan = planProjectRender(project);
    if (!preview) validateSubtitleBurnIn(plan.visualClips);
    renderPlan = bindRenderSources(
      plan,
      (assetId) => assets.get(assetId)!.source.path,
    );
  } catch (cause) {
    throw new VideoDefinitionError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
  signal?.throwIfAborted();
  const sourceMetadata = new Map(
    Array.from(assets.values(), ({ source }) => [source.path, source] as const),
  );
  const sourceIdentities = new Map(
    Array.from(
      assets.values(),
      ({ source, sourceIdentity }) => [source.path, sourceIdentity] as const,
    ),
  );
  return Object.freeze({
    path,
    project: freeze(project),
    frameCount: renderPlan.frameCount,
    sourceIdentity: (path: string) => sourceIdentities.get(path),
    async resolveRender() {
      return {
        ...structuredClone(renderPlan),
        sourceMetadata: new Map(sourceMetadata),
      };
    },
  });
}

async function buildProject(
  path: string,
  definition: VideoDefinition,
  { signal, probes = new Map(), inputs }: CompilationOptions,
) {
  const {
    canvas,
    assets = {},
    tracks,
    name = 'Untitled video',
    id = stableId('video', name),
    createdAt = epoch,
    updatedAt = createdAt,
    transitions,
    markers,
  } = definition;
  const { frameRate: authoredRate, ...settings } = canvas;
  const frameRate =
    typeof authoredRate === 'number'
      ? { numerator: authoredRate, denominator: 1 }
      : authoredRate;
  const project: Project = {
    metadata: { name, id, createdAt, updatedAt },
    settings: { ...settings, frameRate },
    assets: [],
    tracks: [],
    clips: [],
    transitions,
    markers,
  };

  const resolveFont = await loadFonts(
    path,
    definition.fonts,
    signal,
    inputs?.record,
  );
  const { subtitles } = definition;
  if (subtitles) {
    const cues = [];
    for (const [index, { style, ...cue }] of subtitles.cues.entries())
      cues.push({
        ...cue,
        ...(style && {
          style: await resolveFont(style, `subtitles.cues.${index}.style`),
        }),
      });
    project.subtitles = {
      style: await resolveFont(subtitles.style, 'subtitles.style'),
      cues,
    };
  }

  const occurrences = new Map<string, number>();
  const clipLocations: string[] = [];
  for (const [trackIndex, track] of tracks.entries()) {
    const { id, name, type, clips, ...properties } = track;
    const trackId = id ?? generatedTrackId(track, occurrences);
    project.tracks.push({
      ...properties,
      id: trackId,
      name: name ?? type,
      type: type === 'audio' ? 'audio' : 'video',
    });
    for (const [clipIndex, clip] of clips.entries()) {
      const location = `tracks.${trackIndex}.clips.${clipIndex}`;
      const asset =
        'asset' in clip && Object.hasOwn(assets, clip.asset)
          ? assets[clip.asset]
          : undefined;
      if (
        'asset' in clip &&
        (!asset ||
          (type === 'audio' && asset.kind === 'image') ||
          (type === 'video' && asset.kind === 'audio') ||
          (type === 'image' && asset.kind !== 'image'))
      )
        throw new VideoDefinitionError(
          `${location}.asset: Expected a named ${type} asset compatible with the track; received '${clip.asset}'.`,
        );
      clipLocations.push(location);
      project.clips.push(
        await compileClip(
          clip,
          frameRate,
          trackId,
          location,
          resolveFont,
          'text' in clip || asset?.kind === 'image',
        ),
      );
    }
  }

  const compiledAssets = new Map<string, CompiledAsset>();
  for (const id of Object.keys(assets).sort()) {
    const asset = assets[id]!;
    const sourcePath = resolve(dirname(path), asset.path);
    inputs?.record(identifyVideoInput(sourcePath, 'media'));
    const compiled = await compileAsset(
      id,
      asset,
      inputs ? await inputs.snapshotMedia(sourcePath) : sourcePath,
      probes,
      signal,
    );
    compiledAssets.set(id, compiled);
    project.assets.push(compiled.asset);
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

  validateSourceBounds(validated.project, compiledAssets, clipLocations);

  return { project: validated.project, assets: compiledAssets };
}

function validateSourceBounds(
  project: Project,
  assets: ReadonlyMap<string, CompiledAsset>,
  clipLocations: readonly string[],
) {
  const trackTypes = new Map(project.tracks.map(({ id, type }) => [id, type]));
  for (const [index, clip] of project.clips.entries()) {
    if (clip.assetId === undefined) continue;
    const { source, asset } = assets.get(clip.assetId)!;
    if (asset.metadata?.kind === 'image') continue;
    const audio = trackTypes.get(clip.trackId) === 'audio';
    if (audio && !source.audio)
      throw new VideoDefinitionError(
        `${clipLocations[index]}.asset: '${clip.assetId}' has no audio stream.`,
      );
    if (clip.detachedAudio) continue;
    const duration = audio
      ? audioSourceDuration(source)
      : videoSourceDuration(source);
    if (!withinSource(clip.sourceOut, duration))
      throw new VideoDefinitionError(
        `${clipLocations[index]}.sourceOut: Out point exceeds the duration of '${clip.assetId}' or its duration is unknown.`,
      );
  }
}

async function loadFonts(
  path: string,
  definitions: VideoDefinition['fonts'],
  signal?: AbortSignal,
  record?: RecordVideoInput,
) {
  const fonts = new Map<string, string>();
  const verifiedFonts = new Set<string>();
  async function verifyFont(data: string, location: string) {
    if (verifiedFonts.has(data)) return;
    try {
      await validateEmbeddedFont(Buffer.from(data, 'base64'));
      verifiedFonts.add(data);
    } catch (cause) {
      throw definitionLoadError(location, cause);
    }
  }
  for (const [id, font] of Object.entries(definitions ?? {})) {
    signal?.throwIfAborted();
    if ('data' in font) {
      await verifyFont(font.data, `fonts.${id}.data`);
      fonts.set(id, font.data);
    } else {
      try {
        const file = resolve(dirname(path), font.path);
        record?.(identifyVideoInput(file, 'font'));
        const data = await readEmbeddedFont(file);
        verifiedFonts.add(data);
        fonts.set(id, data);
      } catch (cause) {
        signal?.throwIfAborted();
        throw definitionLoadError(`fonts.${id}.path`, cause);
      }
    }
  }
  return async <Style extends FontStyle>(style: Style, location: string) => {
    const { font, ...properties } = style;
    if (font === undefined) {
      if (style.embeddedFont)
        await verifyFont(style.embeddedFont, `${location}.embeddedFont`);
      return properties;
    }
    const embeddedFont = fonts.get(font);
    if (embeddedFont === undefined)
      throw new VideoDefinitionError(
        `${location}.font: Unknown font '${font}'.`,
      );
    return { ...properties, embeddedFont };
  };
}

async function compileAsset(
  id: string,
  definition: AuthoredAsset,
  sourcePath: string,
  probes: VideoSourceProbes,
  signal?: AbortSignal,
): Promise<CompiledAsset> {
  const { path, kind, name = id, freezeFrame, ...properties } = definition;
  const file = { type: 'relative' as const, path };
  const sourceIdentity = videoInputIdentity(sourcePath);
  const source = await probeVideoSource(id, sourcePath, probes, signal);
  if (
    sourceIdentity === null ||
    sourceIdentity !== videoInputIdentity(sourcePath) ||
    sourceIdentity !== videoInputIdentity(source.path)
  )
    throw new VideoDefinitionError(
      `assets.${id}.path: Media '${sourcePath}' changed during compilation. Retry after the write completes.`,
    );
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
    ...properties,
    id,
    name,
    file,
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
  return { source, sourceIdentity, asset };
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

async function compileClip(
  clip: AuthoredClip,
  frameRate: FrameRate,
  trackId: string,
  location: string,
  resolveFont: Awaited<ReturnType<typeof loadFonts>>,
  still: boolean,
): Promise<TimelineClip> {
  const time = (value: AuthoredTime, field: string) => {
    if (typeof value !== 'number') return value;
    try {
      return frameTime(value, frameRate);
    } catch (cause) {
      throw new VideoDefinitionError(
        `${location}.${field}: Frame position exceeds the supported rational time range.`,
        { cause },
      );
    }
  };
  const {
    id,
    at,
    sourceIn,
    sourceOut,
    duration,
    fadeIn,
    fadeOut,
    ...properties
  } = clip;
  if (
    (sourceOut === undefined) === (duration === undefined) ||
    (duration !== undefined && (!still || sourceIn !== undefined))
  )
    throw new VideoDefinitionError(
      `${location}: Specify sourceOut with optional sourceIn, or duration alone for an image or text clip.`,
    );
  if (still && (clip.speed || clip.gainKeys || clip.effects?.length))
    throw new VideoDefinitionError(
      `${location}: Playback speed, audio effects and volume keyframes require timed media.`,
    );
  const timelineStart = time(at, 'at');
  const fade = (value: typeof fadeIn, field: string) =>
    typeof value === 'number' ? { duration: time(value, field) } : value;
  const timing = {
    id: id ?? stableId('clip', trackId, reduce(timelineStart)),
    trackId,
    timelineStart,
    sourceIn: time(sourceIn ?? 0, 'sourceIn'),
    sourceOut: time(
      sourceOut ?? duration!,
      sourceOut === undefined ? 'duration' : 'sourceOut',
    ),
    fadeIn: fade(fadeIn, 'fadeIn'),
    fadeOut: fade(fadeOut, 'fadeOut'),
  };
  if ('asset' in properties) {
    const { asset, ...media } = properties;
    return { ...media, ...timing, assetId: asset };
  }
  const { text, ...title } = properties;
  return {
    ...title,
    ...timing,
    text: await resolveFont(text, `${location}.text`),
  };
}

async function probeVideoSource(
  id: string,
  sourcePath: string,
  probes: VideoSourceProbes,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  try {
    const canonical = await realpath(sourcePath);
    const source =
      probes.get(canonical) ?? freeze(await probeMedia(canonical, signal));
    probes.set(canonical, source);
    return source;
  } catch (cause) {
    signal?.throwIfAborted();
    throw new VideoDefinitionError(
      `assets.${id}.path: Cannot probe '${sourcePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
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
