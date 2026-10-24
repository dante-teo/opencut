import { z } from 'zod';
import { compareTimes, frameRateSchema, timeSchema } from './time.js';

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
});
const trackSchema = z.strictObject({ id, name, type: mediaType });
const clipSchema = z.strictObject({
  id,
  assetId: id,
  trackId: id,
  timelineStart: timeSchema,
  sourceIn: timeSchema,
  sourceOut: timeSchema,
});
const settingsSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  frameRate: frameRateSchema,
});
const projectSchema = z.strictObject({
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
  clips: z.array(clipSchema),
});

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
  project.clips.forEach((clip, index) => {
    const location = `/clips/${index}`;
    const asset = assets.get(clip.assetId);
    const track = tracks.get(clip.trackId);
    if (!asset)
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
  });
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
  return JSON.stringify(requireProject(project), null, 2) + '\n';
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
  return requireProject(value);
}
