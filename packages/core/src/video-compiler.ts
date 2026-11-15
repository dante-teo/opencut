import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  audioSourceDuration,
  videoSourceDuration,
  validateEmbeddedFont,
  validateSubtitleBurnIn,
} from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import { compileVideoAssets, readEmbeddedFont } from './video-assets.js';
import type { CompiledVideoAsset, VideoAssetOptions } from './video-assets.js';
import { validateProject } from './project.js';
import type { Project, TimelineClip } from './project.js';
import { bindRenderSources } from './render-sources.js';
import { planProjectRender } from './render-plan.js';
import { frameTime, rationalTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import {
  definitionLoadError,
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import type {
  ParsedVideoDefinition,
  VideoDefinition,
} from './video-definition.js';
import { identifyVideoInput } from './video-input.js';
import type { RecordVideoInput } from './video-input.js';
import type { VideoBuild } from './video-files.js';
import type { VideoRecipeInspection } from './video-recipe.js';

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
type FontStyle = {
  font?: string | undefined;
  embeddedFont?: string | null | undefined;
};
export type CompilationOptions = VideoAssetOptions & { preview?: boolean };

const epoch = '1970-01-01T00:00:00.000Z';

export interface CompiledVideo {
  readonly path: string;
  readonly build?: VideoBuild;
  /** A deeply frozen project snapshot. */
  readonly project: Project;
  readonly frameCount: number;
  readonly recipes: readonly VideoRecipeInspection[];
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
  getBuild?: (definition: ParsedVideoDefinition) => VideoBuild,
): Promise<CompiledVideo> {
  const { signal, preview = false } = options;
  signal?.throwIfAborted();
  const definition = parseVideoDefinition(value);
  const { project, assets, recipes } = await buildProject(
    path,
    definition,
    options,
  );
  let renderPlan: BoundRenderPlan;
  try {
    const plan = planProjectRender(project);
    if (!preview) validateSubtitleBurnIn(plan.visualClips);
    renderPlan = bindRenderSources(
      plan,
      (assetId) => assets.get(assetId)!.media!.metadata.path,
    );
  } catch (cause) {
    throw new VideoDefinitionError(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
  signal?.throwIfAborted();
  const sourceMetadata = new Map<string, MediaMetadata>();
  const sourceIdentities = new Map<string, string>();
  for (const { media } of assets.values()) {
    if (!media) continue;
    const { metadata, identity } = media;
    sourceMetadata.set(metadata.path, freeze(metadata));
    sourceIdentities.set(metadata.path, identity);
  }
  return Object.freeze({
    path,
    ...(getBuild && { build: freeze(getBuild(definition)) }),
    project: freeze(project),
    frameCount: renderPlan.frameCount,
    recipes: freeze(recipes),
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
  definition: ParsedVideoDefinition,
  options: CompilationOptions,
) {
  const { signal, inputs } = options;
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

  const clipAssets = new Set(
    project.clips.flatMap(({ assetId }) => (assetId ? [assetId] : [])),
  );
  const compiled = await compileVideoAssets(
    dirname(path),
    assets,
    clipAssets,
    options,
  );
  project.assets = [...compiled.assets.values()].map(({ asset }) => asset);

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

  validateSourceBounds(validated.project, compiled.assets, clipLocations);
  return { project: validated.project, ...compiled };
}

function validateSourceBounds(
  project: Project,
  assets: ReadonlyMap<string, CompiledVideoAsset>,
  clipLocations: readonly string[],
) {
  const trackTypes = new Map(project.tracks.map(({ id, type }) => [id, type]));
  for (const [index, clip] of project.clips.entries()) {
    if (clip.assetId === undefined) continue;
    const { media, asset } = assets.get(clip.assetId)!;
    const source = media!.metadata;
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

function withinSource(sourceOut: RationalTime, seconds: number | null) {
  // FFprobe reports decimal seconds. Match the compositing preflight's 1 µs
  // tolerance when comparing an exact authored frame against that measurement.
  return (
    seconds !== null &&
    seconds > 0 &&
    sourceOut.numerator / sourceOut.denominator <= seconds + 0.000001
  );
}
