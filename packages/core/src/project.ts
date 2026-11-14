import { z } from 'zod';
import { transitionSchema, validateTransitions } from './transitions.js';
import { canvasColorPattern } from '@opencut/shared';
import { textLayerSchema } from './text-style.js';
import { subtitleTrackSchema, validSubtitleWords } from './subtitles.js';
import { visualKeyframesSchema, visualValueSchema } from './keyframes.js';
import { clipDuration, clipSpeedSchema } from './clip-timing.js';
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

export const PROJECT_SCHEMA_VERSION = 1;

const id = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Use a nonempty stable ID containing letters, digits, underscores or hyphens.',
  );
const name = z
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

export const mediaReferenceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('relative'),
    path: path.refine(
      (value) => !value.startsWith('/') && !value.includes(':'),
      'Relative paths must not have a root, drive or URL scheme.',
    ),
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
  kind: z.enum(['video', 'audio', 'image']),
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
const assetSchema = z.strictObject({
  id,
  name,
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
const trackSchema = z.strictObject({
  id,
  name,
  type: mediaType,
  ...trackAudioShape,
  locked: z.boolean().optional(),
});
export const clipVisualSchema = z.strictObject({
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
export const clipSchema = z.strictObject({
  id,
  assetId: id.optional(),
  text: textLayerSchema.optional(),
  trackId: id,
  timelineStart: timeSchema,
  sourceIn: timeSchema,
  sourceOut: timeSchema,
  speed: clipSpeedSchema.optional(),
  ...clipAudioShape,
  detachedAudio: z.literal(true).optional(),
  linkId: id.optional(),
  visual: clipVisualSchema.optional(),
  grade: colorGradeSchema.optional(),
  keyframes: visualKeyframesSchema.optional(),
});
const persistedClipSchema = clipSchema.refine(
  ({ assetId, text }) => (assetId === undefined) !== (text === undefined),
  {
    message: 'A clip must specify exactly one of assetId or text.',
    path: ['assetId'],
    when: ({ value }) =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  },
);
const settingsSchema = z.strictObject({
  backgroundColor: canvasShape.backgroundColor,
  width: z.int().positive(),
  height: z.int().positive(),
  frameRate: frameRateSchema,
});
export const markerSchema = z.strictObject({
  id,
  frame: z.int().nonnegative(),
  name,
});
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  metadata: z.strictObject({
    id,
    name,
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
  }),
  settings: settingsSchema,
  assets: z.array(assetSchema),
  tracks: z.array(trackSchema),
  clips: z.array(persistedClipSchema),
  subtitles: subtitleTrackSchema.optional(),
  transitions: z.array(transitionSchema).optional(),
  markers: z.array(markerSchema).optional(),
});

const historyEntrySchema = z.strictObject({
  id,
  label: name,
  committedAt: z.iso.datetime({ precision: 3 }),
  before: snapshotSchema,
  after: snapshotSchema,
});
const projectSchema = snapshotSchema.extend({
  editing: z
    .strictObject({
      revision: z.int().nonnegative(),
      undo: z.array(historyEntrySchema),
      redo: z.array(historyEntrySchema),
    })
    .optional(),
});
export type ProjectSnapshot = z.infer<typeof snapshotSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type MediaAsset = z.infer<typeof assetSchema>;
export type Track = z.infer<typeof trackSchema>;
export type TimelineClip = z.infer<typeof clipSchema>;
export type ProjectSettings = z.infer<typeof settingsSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectMetadata = Project['metadata'];

export interface ProjectIssue {
  /** JSON pointer into the input document, or an empty string for the root. */
  path: string;
  code: string;
  message: string;
}

export class ProjectFormatError extends Error {
  override name = 'ProjectFormatError';
  constructor(
    public readonly code:
      'INVALID_JSON' | 'INVALID_PROJECT' | 'UNSUPPORTED_VERSION',
    public readonly issues: readonly ProjectIssue[],
    options?: ErrorOptions,
  ) {
    super(
      issues
        .map((issue) => `${issue.path || '/'}: ${issue.message}`)
        .join('\n'),
      options,
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
    if (clip.keyframes && track?.type !== 'video')
      add(
        location + '/keyframes',
        'incompatible_visual',
        'Keyframes require a video track.',
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
      (clip.text || asset?.metadata?.kind === 'image')
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
  validateTransitions(project, add, ids);
  return issues;
}

/** Pure data validation. No media, filesystem or tool access occurs here. */
export function validateProject(value: unknown): ProjectValidationResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion !== PROJECT_SCHEMA_VERSION
  ) {
    return {
      success: false,
      error: new ProjectFormatError('UNSUPPORTED_VERSION', [
        {
          path: '/schemaVersion',
          code: 'unsupported_version',
          message: `Unsupported project schema version ${String(value.schemaVersion)}; supported version is ${PROJECT_SCHEMA_VERSION}.`,
        },
      ]),
    };
  }
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success) {
    return {
      success: false,
      error: new ProjectFormatError(
        'INVALID_PROJECT',
        parsed.error.issues.map((issue) => ({
          path: pointer(issue.path),
          code: issue.code,
          message: issue.message,
        })),
      ),
    };
  }
  const issues = collectSemanticIssues(parsed.data);
  for (const stack of ['undo', 'redo'] as const) {
    parsed.data.editing?.[stack].forEach((entry, index) => {
      for (const side of ['before', 'after'] as const) {
        const snapshot = entry[side];
        for (const issue of collectSemanticIssues(snapshot))
          issues.push({
            ...issue,
            path: `/editing/${stack}/${index}/${side}${issue.path}`,
          });
        if (snapshot.metadata.id !== parsed.data.metadata.id)
          issues.push({
            path: `/editing/${stack}/${index}/${side}/metadata/id`,
            code: 'history_project',
            message: 'History must belong to this project.',
          });
      }
    });
  }
  return issues.length
    ? {
        success: false,
        error: new ProjectFormatError('INVALID_PROJECT', issues),
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

/** Validated metadata and collection counts; does not check media availability. */
export function getProjectInfo(project: Project) {
  const validated = requireProject(project);
  return {
    schemaVersion: validated.schemaVersion,
    metadata: validated.metadata,
    settings: validated.settings,
    statistics: {
      assets: validated.assets.length,
      tracks: validated.tracks.length,
      clips: validated.clips.length,
    },
  };
}

export function createProject(options: CreateProjectOptions): Project {
  const now = options.createdAt ?? new Date().toISOString();
  return requireProject({
    schemaVersion: PROJECT_SCHEMA_VERSION,
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

/** Schema parsing fixes object key order without sorting semantically ordered arrays. */
export function serializeProject(project: Project): string {
  const fonts: string[] = [];
  const ids = new Map<string, number>();
  const document = { ...requireProject(project), embeddedFonts: fonts };
  return (
    JSON.stringify(
      document,
      (key, value: unknown) => {
        if (key === 'embeddedFonts') return fonts.length ? fonts : undefined;
        if (key !== 'embeddedFont' || typeof value !== 'string') return value;
        let index = ids.get(value);
        if (index === undefined) {
          index = fonts.length;
          ids.set(value, index);
          fonts.push(value);
        }
        return { font: index };
      },
      2,
    ) + '\n'
  );
}

export function deserializeProject(json: string): Project {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new ProjectFormatError(
      'INVALID_JSON',
      [
        {
          path: '',
          code: 'invalid_json',
          message:
            'Malformed project JSON; expected one JSON object with no comments or trailing commas.',
        },
      ],
      { cause },
    );
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(value) || !('embeddedFonts' in value))
    return requireProject(value);
  const { embeddedFonts, ...document } = value;
  const fontTable = z
    .array(textLayerSchema.shape.embeddedFont.unwrap().unwrap())
    .safeParse(embeddedFonts);
  if (!fontTable.success)
    throw new ProjectFormatError('INVALID_PROJECT', [
      {
        path: '/embeddedFonts',
        code: 'invalid_font_table',
        message: 'Expected a table of embedded font data.',
      },
    ]);
  const snapshots = [document];
  if (isObject(document.editing)) {
    for (const stack of [document.editing.undo, document.editing.redo])
      if (Array.isArray(stack))
        for (const entry of stack)
          if (isObject(entry))
            for (const snapshot of [entry.before, entry.after])
              if (isObject(snapshot)) snapshots.push(snapshot);
  }
  const restore = (style: unknown) => {
    if (!isObject(style) || !isObject(style.embeddedFont)) return;
    const reference = style.embeddedFont;
    if (
      Object.keys(reference).length === 1 &&
      typeof reference.font === 'number' &&
      Number.isSafeInteger(reference.font) &&
      reference.font >= 0 &&
      reference.font < fontTable.data.length
    )
      style.embeddedFont = fontTable.data[reference.font];
  };
  for (const snapshot of snapshots) {
    if (Array.isArray(snapshot.clips))
      for (const clip of snapshot.clips) if (isObject(clip)) restore(clip.text);
    if (isObject(snapshot.subtitles)) {
      restore(snapshot.subtitles.style);
      if (Array.isArray(snapshot.subtitles.cues))
        for (const cue of snapshot.subtitles.cues)
          if (isObject(cue)) restore(cue.style);
    }
  }
  return requireProject(document);
}
