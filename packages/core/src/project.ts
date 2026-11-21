import { visualGroupsSchema } from './visual-groups.js';
import { z } from 'zod';
import { transitionSchema, validateTransitions } from './transitions.js';
import { canvasColorPattern } from '@opencut/shared';
import { textLayerSchema } from './text-style.js';
import { subtitleTrackSchema, validSubtitleWords } from './subtitles.js';
import { visualKeyframesSchema, visualValueSchema } from './keyframes.js';
import { clipDuration, clipSpeedSchema } from './clip-timing.js';
import { audioRoleSchema, professionalMixSchema } from './professional-mix.js';
import { musicComparisonSchema } from './music-comparison.js';
import { clipAudioShape, resolveAudioFade, trackAudioShape } from './audio.js';
import {
  addTimes,
  compareTimes,
  frameRateSchema,
  frameTime,
  subtractTimes,
  timeSchema,
} from './time.js';
import type { RationalTime } from './time.js';

export const entityIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Use a nonempty stable ID containing letters, digits, underscores or hyphens.',
  );
export const entityNameSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'Name must not be blank.');
const path = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32),
    'Use forward slashes and no control characters in file paths.',
  );

export const relativeMediaPathSchema = path.refine(
  (value) => !value.startsWith('/') && !value.includes(':'),
  'Relative paths must not have a root, drive or URL scheme.',
);

export const mediaReferenceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('relative'),
    path: relativeMediaPathSchema,
  }),
  z.strictObject({
    type: z.literal('absolute'),
    path: path.refine(
      (value) =>
        /^\/(?!\/)/.test(value) ||
        /^[A-Za-z]:\//.test(value) ||
        /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value),
      'Expected an absolute POSIX, drive or UNC file path.',
    ),
  }),
]);

const mediaType = z.enum(['video', 'audio']);
const assetMetadataSchema = z.strictObject({
  kind: z.enum(['video', 'audio', 'image', 'graphic']),
  formatName: z.string().nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
  videoDuration: timeSchema.optional(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  frameRate: z.number().finite().positive().nullable(),
  frameRateRatio: z.string().nullable(),
  hasAudio: z.boolean(),
});
export const assetSchema = z.strictObject({
  id: entityIdSchema,
  name: entityNameSchema,
  file: mediaReferenceSchema,
  mediaTypes: z
    .array(mediaType)
    .min(1)
    .refine(
      (types) => new Set(types).size === types.length,
      'Media types must be unique.',
    ),
  duration: timeSchema
    .refine((value) => value.numerator > 0, 'Known duration must be positive.')
    .optional(),
  metadata: assetMetadataSchema.optional(),
  freezeFrame: timeSchema.optional(),
  provenance: z
    .strictObject({
      provider: z.enum(['commons', 'openverse']),
      creator: z.string().min(1).max(300).nullable(),
      sourceUrl: z.url({ protocol: /^https$/ }).max(4096),
      license: z.string().min(1).max(100),
      licenseUrl: z.url({ protocol: /^https$/ }).max(4096),
    })
    .optional(),
});
export const trackSchema = z.strictObject({
  id: entityIdSchema,
  name: entityNameSchema,
  type: mediaType,
  ...trackAudioShape,
  audioRole: audioRoleSchema.optional(),
  channelMode: z.enum(['source', 'mono-center']).optional(),
});
export const clipVisualSchema = z.strictObject({
  sourceWindow: z
    .strictObject({
      x: z.int().nonnegative(),
      y: z.int().nonnegative(),
      width: z.int().positive(),
      height: z.int().positive(),
    })
    .optional(),
  crop: z
    .strictObject({
      left: z.number().min(0).lt(1),
      top: z.number().min(0).lt(1),
      right: z.number().min(0).lt(1),
      bottom: z.number().min(0).lt(1),
    })
    .refine(
      (crop) => crop.left + crop.right < 1 && crop.top + crop.bottom < 1,
      'Crop must leave visible area.',
    )
    .optional(),
  x: visualValueSchema('x').optional(),
  y: visualValueSchema('y').optional(),
  scale: visualValueSchema('scale').optional(),
  opacity: visualValueSchema('opacity').optional(),
  rotation: visualValueSchema('rotation').optional(),
  fit: z.enum(['contain', 'cover', 'stretch']).optional(),
});
export const canvasShape = {
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  backgroundColor: z.string().regex(canvasColorPattern).optional(),
};
export const colorGradeSchema = z.strictObject({
  exposure: z.number().min(-4).max(4),
  temperature: z.number().min(-1).max(1),
  tint: z.number().min(-1).max(1),
  contrast: z.number().min(0).max(3),
  saturation: z.number().min(0).max(3),
  curve: z
    .array(
      z.strictObject({
        input: z.number().gt(0).lt(1),
        output: z.number().min(0).max(1),
      }),
    )
    .max(16)
    .refine(
      (points) =>
        points.every(
          (point, i) => i === 0 || points[i - 1]!.input < point.input,
        ),
      'Curve input points must increase.',
    ),
});
export const graphicPropsSchema = z.record(z.string(), z.json());
export const clipSchema = z.strictObject({
  id: entityIdSchema,
  assetId: entityIdSchema.optional(),
  text: textLayerSchema.optional(),
  trackId: entityIdSchema,
  timelineStart: timeSchema,
  sourceIn: timeSchema,
  sourceOut: timeSchema,
  speed: clipSpeedSchema.optional(),
  ...clipAudioShape,
  detachedAudio: z.literal(true).optional(),
  visual: clipVisualSchema.optional(),
  grade: colorGradeSchema.optional(),
  keyframes: visualKeyframesSchema.optional(),
  graphicProps: graphicPropsSchema.optional(),
});
const snapshotClipSchema = clipSchema.refine(
  ({ assetId, text }) => (assetId === undefined) !== (text === undefined),
  {
    message: 'A clip must specify exactly one of assetId or text.',
    path: ['assetId'],
    when: ({ value }) =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  },
);
export const settingsSchema = z.strictObject({
  backgroundColor: canvasShape.backgroundColor,
  width: z.int().positive(),
  height: z.int().positive(),
  frameRate: frameRateSchema,
  durationFrames: z.int().positive().optional(),
});
export const markerSchema = z.strictObject({
  id: entityIdSchema,
  frame: z.int().nonnegative(),
  name: entityNameSchema,
});
export const snapshotSchema = z.strictObject({
  visualGroups: visualGroupsSchema,
  metadata: z.strictObject({
    id: entityIdSchema,
    name: entityNameSchema,
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
  }),
  settings: settingsSchema,
  assets: z.array(assetSchema),
  tracks: z.array(trackSchema),
  musicComparison: musicComparisonSchema.optional(),
  clips: z.array(snapshotClipSchema),
  subtitles: subtitleTrackSchema.optional(),
  transitions: z.array(transitionSchema).optional(),
  markers: z.array(markerSchema).optional(),
  professionalMix: professionalMixSchema.optional(),
});

export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type MediaAsset = z.infer<typeof assetSchema>;
export type Track = z.infer<typeof trackSchema>;
export type TimelineClip = z.infer<typeof clipSchema>;
export type ProjectSettings = z.infer<typeof settingsSchema>;
export type Project = z.infer<typeof snapshotSchema>;
export type ProjectMetadata = Project['metadata'];

export interface ProjectIssue {
  /** JSON pointer into the input document, or an empty string for the root. */
  path: string;
  code: string;
  message: string;
}

export class ProjectFormatError extends Error {
  override name = 'ProjectFormatError';
  constructor(public readonly issues: readonly ProjectIssue[]) {
    super(
      issues
        .map((issue) => `${issue.path || '/'}: ${issue.message}`)
        .join('\n'),
    );
  }
}

export type ProjectValidationResult =
  | { success: true; project: Project }
  | { success: false; error: ProjectFormatError };

function pointer(parts: readonly PropertyKey[]): string {
  return parts.length
    ? '/' +
        parts
          .map((part) =>
            String(part).replaceAll('~', '~0').replaceAll('/', '~1'),
          )
          .join('/')
    : '';
}

function collectSemanticIssues(project: Project): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const add = (path: string, code: string, message: string) =>
    issues.push({ path, code, message });
  let declaredEnd: RationalTime | undefined;
  if (project.settings.durationFrames !== undefined) {
    try {
      declaredEnd = frameTime(
        project.settings.durationFrames,
        project.settings.frameRate,
      );
    } catch {
      add(
        '/settings/durationFrames',
        'time_overflow',
        'Canvas duration exceeds the supported time range.',
      );
    }
  }
  const ids = new Set([project.metadata.id]);
  for (const collection of ['assets', 'tracks', 'clips'] as const) {
    project[collection].forEach((entity, index) => {
      if (ids.has(entity.id))
        add(
          `/${collection}/${index}/id`,
          'duplicate_id',
          `ID '${entity.id}' is already in use; every entity needs a unique stable ID.`,
        );
      ids.add(entity.id);
    });
  }
  project.markers?.forEach((marker, index) => {
    if (ids.has(marker.id))
      add(
        `/markers/${index}/id`,
        'duplicate_id',
        `ID '${marker.id}' is already in use.`,
      );
    ids.add(marker.id);
    try {
      frameTime(marker.frame, project.settings.frameRate);
    } catch {
      add(
        `/markers/${index}/frame`,
        'time_overflow',
        'Marker time exceeds the supported range.',
      );
    }
  });
  project.subtitles?.cues.forEach((cue, index) => {
    const location = `/subtitles/cues/${index}`;
    if (ids.has(cue.id))
      add(
        location + '/id',
        'duplicate_id',
        `ID '${cue.id}' is already in use.`,
      );
    ids.add(cue.id);
    if (declaredEnd && compareTimes(cue.end, declaredEnd) > 0)
      add(
        location + '/end',
        'timeline_bounds',
        'Subtitle ends after the declared canvas duration.',
      );
    if (compareTimes(cue.end, cue.start) <= 0) {
      add(
        location + '/end',
        'invalid_range',
        'Subtitle end must be later than start.',
      );
    } else {
      try {
        if (!validSubtitleWords(cue, subtractTimes(cue.end, cue.start)))
          add(
            location + '/words',
            'invalid_range',
            'Words must have ordered, non-overlapping text and time ranges within the cue.',
          );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        add(
          location + '/end',
          'time_overflow',
          'Subtitle duration exceeds the supported time range.',
        );
      }
    }
  });
  if (
    Date.parse(project.metadata.updatedAt) <
    Date.parse(project.metadata.createdAt)
  ) {
    add(
      '/metadata/updatedAt',
      'invalid_timestamp',
      'updatedAt must not precede createdAt.',
    );
  }
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const mix = project.professionalMix;
  const references = new Set(Object.keys(mix?.automation?.dialogue ?? {}));
  const reference = mix?.matching?.referenceClip;
  if (reference) references.add(reference);
  for (const id of references) {
    const clip = project.clips.find((clip) => clip.id === id);
    if (
      !clip ||
      tracks.get(clip.trackId)?.audioRole !== 'dialogue' ||
      clip.text
    )
      add(
        '/professionalMix',
        'invalid_audio_reference',
        `Mix clip '${id}' must belong to a dialogue track.`,
      );
  }
  project.assets.forEach((asset, index) => {
    if (
      asset.freezeFrame &&
      (asset.metadata?.kind !== 'image' ||
        asset.mediaTypes.includes('audio') ||
        asset.duration !== undefined)
    )
      add(
        `/assets/${index}/freezeFrame`,
        'invalid_freeze_frame',
        'A freeze frame is a still image without audio or a source duration.',
      );
  });
  const intervals = new Map<
    string,
    { index: number; clip: TimelineClip; end: RationalTime }[]
  >();
  project.clips.forEach((clip, index) => {
    const location = `/clips/${index}`;
    const asset =
      clip.assetId === undefined ? undefined : assets.get(clip.assetId);
    const track = tracks.get(clip.trackId);
    if (clip.assetId !== undefined && !asset)
      add(
        `${location}/assetId`,
        'invalid_reference',
        `Asset '${clip.assetId}' does not exist.`,
      );
    if (!track)
      add(
        `${location}/trackId`,
        'invalid_reference',
        `Track '${clip.trackId}' does not exist.`,
      );
    if (asset && track && !asset.mediaTypes.includes(track.type))
      add(
        `${location}/assetId`,
        'incompatible_media',
        `Asset '${asset.id}' has no ${track.type} media for track '${track.id}'.`,
      );
    if (
      clip.detachedAudio &&
      (track?.type !== 'audio' || !asset?.mediaTypes.includes('video'))
    )
      add(
        `${location}/detachedAudio`,
        'incompatible_media',
        'Detached audio requires a video source on an audio track.',
      );
    if (
      clip.graphicProps &&
      (asset?.metadata?.kind !== 'graphic' ||
        !['react', 'template'].includes(asset.metadata.formatName ?? ''))
    )
      add(
        location + '/graphicProps',
        'incompatible_visual',
        'Only React graphics and templates accept clip props.',
      );
    if (clip.keyframes && track?.type !== 'video')
      add(
        location + '/keyframes',
        'incompatible_visual',
        'Keyframes require a video track.',
      );
    if (
      clip.visual?.sourceWindow &&
      (track?.type !== 'video' ||
        clip.text ||
        asset?.metadata?.kind === 'graphic' ||
        clip.visual.fit === undefined)
    )
      add(
        location + '/visual/sourceWindow',
        'incompatible_visual',
        'A sourceWindow requires video or image media and an explicit visual.fit.',
      );
    if (clip.visual?.crop && track?.type !== 'video')
      add(
        location + '/visual/crop',
        'incompatible_visual',
        'Cropping requires a video track.',
      );
    if (clip.grade && (track?.type !== 'video' || clip.text))
      add(
        location + '/grade',
        'incompatible_visual',
        'Color grading requires a video or image clip.',
      );
    if (
      (clip.gainKeys || clip.effects?.length) &&
      (clip.text || asset?.metadata?.kind === 'image')
    )
      add(
        location + '/gainKeys',
        'incompatible_media',
        'Audio effects and volume keyframes require a timed media clip.',
      );
    if (clip.visual !== undefined && track?.type !== 'video')
      add(
        `${location}/visual`,
        'incompatible_visual',
        'Visual properties require a video track.',
      );
    if (
      clip.speed !== undefined &&
      (clip.text ||
        asset?.metadata?.kind === 'image' ||
        (asset?.metadata?.kind === 'graphic' &&
          asset.metadata.formatName === 'svg'))
    )
      add(
        location + '/speed',
        'incompatible_speed',
        'Playback speed requires a video or audio clip.',
      );
    if (clip.text !== undefined) {
      if (track?.type !== 'video')
        add(
          location + '/text',
          'incompatible_text',
          'Text requires a video track.',
        );
      if (
        clip.volume !== undefined ||
        clip.muted !== undefined ||
        clip.fadeIn !== undefined ||
        clip.fadeOut !== undefined ||
        clip.visual?.fit !== undefined ||
        clip.visual?.crop !== undefined
      )
        add(
          location,
          'text_properties',
          'Text has no clip audio or media fitting mode.',
        );
    }
    if (compareTimes(clip.sourceOut, clip.sourceIn) <= 0)
      add(
        `${location}/sourceOut`,
        'invalid_range',
        'sourceOut must be strictly later than sourceIn (the out point is exclusive).',
      );
    if (asset?.duration && compareTimes(clip.sourceOut, asset.duration) > 0)
      add(
        `${location}/sourceOut`,
        'source_bounds',
        `sourceOut exceeds the known duration of asset '${asset.id}'.`,
      );
    if (compareTimes(clip.sourceOut, clip.sourceIn) > 0) {
      try {
        const duration = clipDuration(clip);
        if (clip.gainKeys?.some((key) => compareTimes(key.time, duration) > 0))
          add(
            location + '/gainKeys',
            'keyframe_bounds',
            'Volume keyframes must be within the clip duration.',
          );
        const end = addTimes(clip.timelineStart, duration);
        if (declaredEnd && compareTimes(end, declaredEnd) > 0)
          add(
            location + '/timelineStart',
            'timeline_bounds',
            'Clip ends after the declared canvas duration.',
          );
        for (const [property, keys] of Object.entries(clip.keyframes ?? {})) {
          if (!keys) continue;
          const keyframesPath = location + '/keyframes/' + property;
          if (
            keys.some(
              (key, index) =>
                index > 0 && compareTimes(keys[index - 1]!.time, key.time) >= 0,
            )
          )
            add(
              keyframesPath,
              'keyframe_order',
              'Keyframe times must be strictly increasing within each property.',
            );
          if (keys.some((key) => compareTimes(key.time, duration) > 0))
            add(
              keyframesPath,
              'keyframe_bounds',
              'Keyframe times must be between zero and clip duration, inclusive.',
            );
          for (const [index, key] of keys.entries()) {
            try {
              addTimes(clip.timelineStart, key.time);
            } catch (error) {
              if (!(error instanceof RangeError)) throw error;
              add(
                keyframesPath + '/' + index + '/time',
                'time_overflow',
                'The keyframe position exceeds the supported rational time precision.',
              );
            }
          }
        }
        const attack = clip.fadeIn && resolveAudioFade('fadeIn', clip.fadeIn);
        const release =
          clip.fadeOut && resolveAudioFade('fadeOut', clip.fadeOut);
        if (attack || release) {
          const zero = { numerator: 0, denominator: 1 };
          const attackDuration = attack?.duration ?? zero;
          const releaseDuration = release?.duration ?? zero;
          if (
            compareTimes(attackDuration, duration) > 0 ||
            compareTimes(
              releaseDuration,
              subtractTimes(duration, attackDuration),
            ) > 0
          ) {
            add(
              location + '/fadeIn',
              'fade_bounds',
              'Fade durations must fit within the clip without overlapping.',
            );
          } else if (
            (attack &&
              (attack.from > attack.to ||
                (attack.to !== 1 &&
                  compareTimes(attack.duration, duration) !== 0))) ||
            (release &&
              (release.from < release.to ||
                (release.from !== 1 &&
                  compareTimes(release.duration, duration) !== 0)))
          ) {
            add(
              location + '/fadeIn',
              'fade_gain',
              'Fade gain endpoints must form a continuous envelope within the clip.',
            );
          } else if (release) {
            // The release start is used as a clip-relative edit boundary.
            try {
              subtractTimes(duration, release.duration);
            } catch (error) {
              if (!(error instanceof RangeError)) throw error;
              add(
                location + '/fadeOut',
                'time_overflow',
                'The fade-out boundary exceeds the supported rational time precision.',
              );
            }
          }
        }
        const entries = intervals.get(clip.trackId) ?? [];
        entries.push({ index, clip, end });
        intervals.set(clip.trackId, entries);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        add(
          `${location}/timelineStart`,
          'time_overflow',
          'Clip duration and timeline end must be representable as safe rational time components. Reduce the range or position.',
        );
      }
    }
  });
  for (const entries of intervals.values()) {
    entries.sort((a, b) =>
      compareTimes(a.clip.timelineStart, b.clip.timelineStart),
    );
    let previous: (typeof entries)[number] | undefined;
    for (const entry of entries) {
      if (previous && compareTimes(entry.clip.timelineStart, previous.end) < 0)
        add(
          `/clips/${entry.index}/timelineStart`,
          'clip_overlap',
          `Clip '${entry.clip.id}' overlaps clip '${previous.clip.id}' on track '${entry.clip.trackId}'. Move or trim it, or choose another compatible track; touching exclusive boundaries are allowed.`,
        );
      if (!previous || compareTimes(entry.end, previous.end) > 0)
        previous = entry;
    }
  }
  if (project.musicComparison) {
    const candidates = new Set(
      project.musicComparison.candidates.map(({ trackId }) => trackId),
    );
    let end = declaredEnd ?? { numerator: 0, denominator: 1 };
    for (const cue of project.subtitles?.cues ?? [])
      if (compareTimes(cue.end, end) > 0) end = cue.end;
    for (const [trackId, entries] of intervals)
      if (!candidates.has(trackId))
        for (const entry of entries)
          if (compareTimes(entry.end, end) > 0) end = entry.end;
    for (const trackId of candidates) {
      const track = tracks.get(trackId);
      const clips = intervals.get(trackId);
      if (
        track?.type !== 'audio' ||
        track.audioRole !== 'music' ||
        !clips?.length
      )
        add(
          '/musicComparison/candidates',
          'invalid_music_candidate',
          `Candidate '${trackId}' must be an audio track with music clips and audioRole 'music'.`,
        );
      for (const clip of clips ?? [])
        if (compareTimes(clip.end, end) > 0)
          add(
            `/clips/${clip.index}/timelineStart`,
            'music_candidate_bounds',
            `Music candidate '${trackId}' extends past the edit. Trim the music to fit the picture and dialogue duration.`,
          );
    }
  }
  validateTransitions(project, add, ids);
  return issues;
}

/** Pure data validation. No media, filesystem or tool access occurs here. */
export function validateProject(value: unknown): ProjectValidationResult {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      error: new ProjectFormatError(
        parsed.error.issues.map((issue) => ({
          path: pointer(issue.path),
          code: issue.code,
          message: issue.message,
        })),
      ),
    };
  }
  const issues = collectSemanticIssues(parsed.data);
  return issues.length
    ? {
        success: false,
        error: new ProjectFormatError(issues),
      }
    : { success: true, project: parsed.data };
}

function requireProject(value: unknown): Project {
  const result = validateProject(value);
  if (!result.success) throw result.error;
  return result.project;
}

export interface CreateProjectOptions {
  name: string;
  id?: string;
  createdAt?: string;
  settings?: ProjectSettings;
}

export function createProject(options: CreateProjectOptions): Project {
  const now = options.createdAt ?? new Date().toISOString();
  return requireProject({
    metadata: {
      id: options.id ?? globalThis.crypto.randomUUID(),
      name: options.name,
      createdAt: now,
      updatedAt: now,
    },
    settings: options.settings ?? {
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
    },
    assets: [],
    tracks: [],
    clips: [],
  });
}
