import type { VideoMixEdit } from '@opencut/shared';
import { videoMixEditSchema } from './professional-mix.js';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  audioSourceDuration,
  videoSourceDuration,
  validateEmbeddedFont,
  validateSubtitleBurnIn,
  renderQualities,
} from '@opencut/media';
import type {
  GraphicBundle,
  MediaMetadata,
  RenderQuality,
} from '@opencut/media';
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
  VideoDefinitionError,
} from './video-definition.js';
import type {
  ParsedVideoDefinition,
  VideoDefinition,
} from './video-definition.js';
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { RecordVideoInput, VideoInput } from './video-input.js';
import { graphicLayer } from './video-graphics.js';
import type { CompiledGraphics } from './video-graphics.js';
import type { VideoBuild } from './video-files.js';
import { checkpointQualityCompilation } from './video-build.js';
import type { VideoProcessingProgress } from './video-processing.js';
import type { VideoRecipeInspection } from './video-recipe.js';
import { musicSelectionSchema } from './music-comparison.js';
import type { MusicSelection } from './music-comparison.js';

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
export type CompilationOptions = VideoAssetOptions & {
  preview?: boolean;
  audioMixEdit?: VideoMixEdit | undefined;
  musicSelection?: MusicSelection | undefined;
};

const epoch = '1970-01-01T00:00:00.000Z';

export interface CompiledVideo {
  readonly path: string;
  readonly build?: VideoBuild;
  /** A deeply frozen project snapshot. */
  readonly project: Project;
  readonly frameCount: number;
  readonly recipes: readonly VideoRecipeInspection[];
  readonly audioMixEdit?: VideoMixEdit;
  forQuality(
    quality: RenderQuality,
    preview: boolean,
    signal?: AbortSignal,
  ): Promise<CompiledVideo>;
  /** Media identity recorded before probing, keyed by the bound source path. */
  sourceIdentity(path: string): string | undefined;
  readonly graphicInputs: readonly VideoInput[];
  graphicSource(key: string): GraphicBundle | undefined;
  graphicScene(key: string): import('@opencut/shared').GraphicScene | undefined;
  resolveRender(): Promise<
    BoundRenderPlan & { sourceMetadata: ReadonlyMap<string, MediaMetadata> }
  >;
}

export interface DefinitionSources {
  path: string;
  definition: ParsedVideoDefinition;
  graphics: CompiledGraphics;
}

export async function compileDefinition(
  sources: DefinitionSources,
  options: CompilationOptions,
  getBuild?: (steps: VideoBuild['processing']['steps']) => VideoBuild,
): Promise<CompiledVideo> {
  const { path, graphics } = sources;
  const {
    signal,
    preview = false,
    quality = preview ? 'fast' : 'quality',
  } = options;
  signal?.throwIfAborted();
  if (!renderQualities.includes(quality))
    throw new VideoDefinitionError(
      'Choose fast, quality, or maximum render quality.',
    );
  const definition = freeze(sources.definition);
  const audioMixEdit =
    options.audioMixEdit === undefined
      ? undefined
      : freeze(videoMixEditSchema.parse(options.audioMixEdit));
  const recipeSteps: VideoBuild['processing']['steps'][number][] = [];
  const { processing, probes = new Map() } = options;
  const authoredFiles = [
    ...Object.values(definition.assets ?? {})
      .filter((asset) => asset.kind !== 'graphic')
      .map(({ path }) => [path, 'media'] as const),
    ...Object.values(definition.fonts ?? {}).flatMap((font) =>
      'path' in font ? [[font.path, 'font'] as const] : [],
    ),
  ].map(([file, kind]) => [resolve(dirname(path), file), kind] as const);
  let pinnedSources = options.pinnedSources;
  let profileIdentities = new Map(
    authoredFiles.map(([file]) => {
      const source = pinnedSources?.get(file) ?? file;
      return [source, videoInputIdentity(source)];
    }),
  );
  const checkInputs = (quality: RenderQuality) => {
    for (const [file, identity] of profileIdentities)
      if (videoInputIdentity(file) !== identity)
        throw new VideoDefinitionError(
          `Media or font '${file}' changed since compilation. Compile the definition again for ${quality}.`,
        );
  };
  const { project, assets, recipes, qualitySensitive } = await buildProject(
    sources,
    {
      ...options,
      quality,
      audioMixEdit,
      probes,
      ...(getBuild && {
        processing: {
          ...processing,
          onProgress(event: VideoProcessingProgress) {
            if (event.status === 'completed' || event.status === 'cache-hit') {
              const { assetId, step, key } = event;
              recipeSteps.push({ assetId, step, key });
            }
            processing?.onProgress?.(event);
          },
        },
      }),
    },
  );
  if (qualitySensitive && options.inputs && !pinnedSources) {
    checkInputs(quality);
    const snapshots = new Map<string, string>();
    for (const [file, kind] of authoredFiles)
      if (!snapshots.has(file))
        snapshots.set(file, await options.inputs.snapshotMedia(file, kind));
    checkInputs(quality);
    pinnedSources = snapshots;
    profileIdentities = new Map(
      [...snapshots.values()].map((file) => [file, videoInputIdentity(file)]),
    );
  }
  let renderPlan: BoundRenderPlan;
  try {
    const plan = planProjectRender(project);
    if (!preview) validateSubtitleBurnIn(plan.visualClips);
    renderPlan = bindRenderSources(plan, (id, props) => {
      const source = graphics.get(id);
      return source
        ? {
            path: source.path,
            graphic: graphicLayer(
              source,
              project.settings.frameRate,
              props,
              (assetId) => {
                const media = assets.get(assetId)?.media;
                if (!media?.metadata.video)
                  throw new VideoDefinitionError(
                    `Graphic '${id}' references '${assetId}', which has no timed video stream.`,
                  );
                return { path: media.metadata.path, identity: media.identity };
              },
            ),
          }
        : { path: assets.get(id)!.media!.metadata.path };
    });
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
  const build = getBuild?.(
    recipeSteps.sort(
      (a, b) => a.assetId.localeCompare(b.assetId) || a.step - b.step,
    ),
  );
  const bundles = new Map(
    [...graphics.values()].map(({ bundle }) => [bundle.key, freeze(bundle)]),
  );
  const scenes = new Map(
    [...graphics.values()].flatMap(({ bundle, scene }) =>
      scene ? [[bundle.key, freeze(scene)] as const] : [],
    ),
  );
  const compiled: CompiledVideo = Object.freeze({
    graphicScene: (key: string) => scenes.get(key),
    graphicInputs: freeze(
      [...graphics.values()].flatMap(({ inputs }) => inputs),
    ),
    graphicSource: (key: string) => bundles.get(key),
    path,
    ...(build && { build: freeze(build) }),
    project: freeze(project),
    ...(audioMixEdit && { audioMixEdit }),
    frameCount: renderPlan.frameCount,
    recipes: freeze(recipes),
    async forQuality(
      next: RenderQuality,
      preview: boolean,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (!renderQualities.includes(next))
        throw new VideoDefinitionError(
          'Choose fast, quality, or maximum render quality.',
        );
      if (!qualitySensitive || (next === 'fast') === (quality === 'fast'))
        return compiled;
      checkInputs(next);
      return checkpointQualityCompilation(
        compiled,
        definition,
        next,
        preview,
        signal,
        async (recovery) => {
          const rebuilt = await compileDefinition(
            sources,
            {
              quality: next,
              preview,
              signal,
              processing,
              probes,
              pinnedSources,
              audioMixEdit,
              musicSelection: options.musicSelection,
              ...(recovery && { recovery }),
            },
            getBuild,
          );
          checkInputs(next);
          return rebuilt;
        },
      );
    },
    sourceIdentity: (path: string) => sourceIdentities.get(path),
    async resolveRender() {
      return {
        ...structuredClone(renderPlan),
        sourceMetadata: new Map(sourceMetadata),
      };
    },
  });
  return compiled;
}

async function buildProject(
  { path, definition, graphics }: DefinitionSources,
  options: CompilationOptions,
) {
  const { signal, inputs, audioMixEdit } = options;
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
  const professionalMix = audioMixEdit
    ? audioMixEdit.mix
    : definition.professionalMix;
  const selection =
    options.musicSelection &&
    musicSelectionSchema.parse(options.musicSelection);
  if (selection && !definition.musicComparison)
    throw new VideoDefinitionError(
      'Declare music candidates before selecting one.',
    );
  const musicComparison = definition.musicComparison && {
    ...definition.musicComparison,
    selected: selection?.candidate ?? definition.musicComparison.selected,
    matchLoudness:
      selection?.matchLoudness ?? definition.musicComparison.matchLoudness,
  };
  if (
    musicComparison &&
    !musicComparison.candidates.some(
      ({ trackId }) => trackId === musicComparison.selected,
    )
  )
    throw new VideoDefinitionError(
      `Unknown music candidate '${musicComparison.selected}'.`,
    );
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
    ...(definition.visualGroups && { visualGroups: definition.visualGroups }),
    ...(professionalMix && { professionalMix }),
    ...(musicComparison && { musicComparison }),
  };

  const resolveFont = await loadFonts(
    path,
    definition.fonts,
    signal,
    inputs?.record,
    options.pinnedSources,
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
    const roles = audioMixEdit?.roles;
    const role =
      roles && Object.hasOwn(roles, trackId) ? roles[trackId] : undefined;
    if (role && type !== 'audio' && type !== 'video')
      throw new VideoDefinitionError(
        `Track '${trackId}' does not support audio routing.`,
      );
    project.tracks.push({
      ...properties,
      ...(role && { audioRole: role }),
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
        'props' in clip &&
        clip.props !== undefined &&
        (asset?.kind !== 'graphic' ||
          !['react', 'template'].includes(asset.renderer))
      )
        throw new VideoDefinitionError(
          `${location}.props: Only React graphics and templates accept placement props.`,
        );
      if (
        asset?.kind === 'graphic' &&
        (type !== 'video' ||
          clip.gainKeys ||
          clip.effects?.length ||
          clip.detachedAudio)
      )
        throw new VideoDefinitionError(
          `${location}: Graphics require a video track and have no audio stream.`,
        );
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
          'text' in clip ||
            asset?.kind === 'image' ||
            (asset?.kind === 'graphic' && asset.renderer === 'svg'),
        ),
      );
    }
  }

  for (const id of Object.keys(audioMixEdit?.roles ?? {}))
    if (!project.tracks.some((track) => track.id === id))
      throw new VideoDefinitionError(`Unknown audio track '${id}'.`);
  const mediaAssets = Object.fromEntries(
    Object.entries(assets).flatMap(([id, asset]) =>
      asset.kind === 'graphic' ? [] : ([[id, asset]] as const),
    ),
  );
  const clipAssets = new Set(
    project.clips.flatMap(({ assetId }) => (assetId ? [assetId] : [])),
  );
  for (const [id, graphic] of graphics)
    for (const { asset } of Object.values(graphic.react?.mediaFrames ?? {})) {
      if (mediaAssets[asset]?.kind !== 'video')
        throw new VideoDefinitionError(
          `Graphic '${id}' requires a non-graphic video asset for media-frame reference '${asset}'.`,
        );
      clipAssets.add(asset);
    }
  const compiled = await compileVideoAssets(
    dirname(path),
    mediaAssets,
    clipAssets,
    options,
  );
  for (const [id, graphic] of graphics)
    compiled.assets.set(id, { asset: graphic.asset });
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
    if (asset.metadata?.kind === 'image' || asset.metadata?.kind === 'graphic')
      continue;
    const source = media!.metadata;
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
  pinnedSources?: ReadonlyMap<string, string>,
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
        const data = await readEmbeddedFont(pinnedSources?.get(file) ?? file);
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
    if ('props' in media) {
      const { props, ...visual } = media;
      return {
        ...visual,
        ...timing,
        assetId: asset,
        ...(props && { graphicProps: props }),
      };
    }
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
