import { z } from 'zod';
import {
  assetSchema,
  clipSchema,
  entityIdSchema,
  graphicPropsSchema,
  markerSchema,
  relativeMediaPathSchema,
  settingsSchema,
  snapshotSchema,
  trackSchema,
} from './project.js';
import { frameRateSchema, timeSchema } from './time.js';
import { textLayerSchema } from './text-style.js';
import {
  MAX_SUBTITLE_CUES,
  subtitleStyleSchema,
  subtitleTrackSchema,
} from './subtitles.js';
import { videoRecipeSchema } from './video-recipe-schema.js';
import { transitionSchema } from './transitions.js';
import { checkGraphicScene } from './graphic-scene-schema.js';
import { graphicAssetSchema } from './video-graphics-contract.js';
import { layoutAssertionsSchema } from './layout-assertion-schema.js';

const frame = z.int().nonnegative();
const frameCount = z.int().positive();
const position = z.union([frame, timeSchema]);
const duration = z.union([frameCount, timeSchema]);
const fade = z.union([frameCount, clipSchema.shape.fadeIn.unwrap()]).optional();

const fontReference = { font: entityIdSchema.optional() };
const hasOneFont = ({
  font,
  embeddedFont,
}: {
  font?: string | undefined;
  embeddedFont?: string | null | undefined;
}) => font === undefined || embeddedFont === undefined;
const fontConflict = {
  path: ['font'],
  message: 'Specify either font or embeddedFont.',
};
const text = textLayerSchema
  .extend(fontReference)
  .refine(hasOneFont, fontConflict);
const subtitleStyle = subtitleStyleSchema
  .extend(fontReference)
  .refine(hasOneFont, fontConflict);
const subtitles = subtitleTrackSchema.extend({
  style: subtitleStyle,
  cues: z
    .array(
      subtitleTrackSchema.shape.cues.element.extend({
        style: subtitleStyle.optional(),
      }),
    )
    .max(MAX_SUBTITLE_CUES),
});

const clip = clipSchema
  .omit({
    assetId: true,
    graphicProps: true,
    text: true,
    trackId: true,
    timelineStart: true,
    sourceIn: true,
    sourceOut: true,
    fadeIn: true,
    fadeOut: true,
  })
  .extend({
    id: entityIdSchema.optional(),
    at: position,
    sourceIn: position.optional(),
    sourceOut: duration.optional(),
    duration: duration.optional(),
    fadeIn: fade,
    fadeOut: fade,
  });
const mediaClip = clip.extend({ asset: entityIdSchema });
const visualMediaClip = mediaClip.extend({
  props: graphicPropsSchema.optional(),
});
const textClip = clip.extend({ text });
const track = trackSchema.omit({ id: true, name: true, type: true }).extend({
  id: entityIdSchema.optional(),
  name: trackSchema.shape.name.optional(),
});
const visualOnlyTrack = track.omit({
  volume: true,
  muted: true,
  audioRole: true,
  channelMode: true,
});
const mediaAsset = assetSchema
  .pick({ name: true, freezeFrame: true, provenance: true })
  .partial()
  .extend({
    path: relativeMediaPathSchema,
    kind: z.enum(['video', 'image', 'audio']),
    recipe: videoRecipeSchema.optional(),
  });
const font = z.union([
  z.strictObject({ path: relativeMediaPathSchema }),
  z.strictObject({
    data: textLayerSchema.shape.embeddedFont.unwrap().unwrap(),
  }),
]);

export const videoDefinitionSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  ...snapshotSchema.shape.metadata.partial().shape,
  canvas: settingsSchema.extend({
    frameRate: z.union([frameCount, frameRateSchema]),
  }),
  assets: z
    .record(entityIdSchema, z.union([mediaAsset, graphicAssetSchema]))
    .optional(),
  fonts: z.record(entityIdSchema, font).optional(),
  tracks: z.array(
    z.discriminatedUnion('type', [
      track.extend({
        type: z.literal('video'),
        clips: z.array(z.union([visualMediaClip, textClip])),
      }),
      track.extend({
        type: z.literal('audio'),
        clips: z.array(mediaClip),
      }),
      visualOnlyTrack.extend({
        type: z.literal('image'),
        clips: z.array(mediaClip),
      }),
      visualOnlyTrack.extend({
        type: z.literal('text'),
        clips: z.array(textClip),
      }),
    ]),
  ),
  subtitles: subtitles.optional(),
  layoutAssertions: layoutAssertionsSchema.optional(),
  transitions: z.array(transitionSchema).optional(),
  visualGroups: snapshotSchema.shape.visualGroups,
  markers: z.array(markerSchema).optional(),
  professionalMix: snapshotSchema.shape.professionalMix,
  musicComparison: snapshotSchema.shape.musicComparison,
});

export type VideoDefinition = z.input<typeof videoDefinitionSchema>;

export const videoDefinitionFormats = {
  typescript: { suffix: '.video.ts', authoringCode: true },
} as const;

export function isVideoDefinitionPath(file: string) {
  return file.endsWith(videoDefinitionFormats.typescript.suffix);
}

export type VideoParameterValue =
  | string
  | number
  | boolean
  | null
  | readonly VideoParameterValue[]
  | VideoParameters;
export interface VideoParameters {
  readonly [key: string]: VideoParameterValue;
}
const parametersSchema = z.record(z.string(), z.json());
const parameterized = Symbol('videoParameters');

interface ParameterizedVideo {
  [parameterized](value?: VideoParameters): Promise<ResolvedVideoDefinition>;
}

export interface ResolvedVideoDefinition {
  value: unknown;
  params?: VideoParameters;
}

/** Zod builders for the strict parameter shape of a TypeScript definition. */
export const videoParams = z;

export function defineVideo(definition: VideoDefinition): VideoDefinition;
export function defineVideo<Shape extends z.ZodRawShape>(
  shape: Shape,
  compose: (
    params: z.output<z.ZodObject<Shape>>,
  ) => VideoDefinition | Promise<VideoDefinition>,
): ParameterizedVideo;
export function defineVideo<Shape extends z.ZodRawShape>(
  definition: VideoDefinition | Shape,
  compose?: (
    params: z.output<z.ZodObject<Shape>>,
  ) => VideoDefinition | Promise<VideoDefinition>,
): VideoDefinition | ParameterizedVideo {
  if (!compose) return definition as VideoDefinition;
  const schema = z.strictObject(definition as Shape);
  return {
    async [parameterized](value) {
      const result = await schema.safeParseAsync(value ?? {});
      if (!result.success) throw invalidParameters(result.error);
      const params = structuredClone(validateVideoParameters(result.data));
      return { value: await compose(result.data), params };
    },
  };
}

export function validateVideoParameters(value: unknown) {
  try {
    const result = parametersSchema.safeParse(value);
    if (!result.success) throw invalidParameters(result.error);
    // The author schema must see every input key, including keys ignored by JSON validation.
    return value as VideoParameters;
  } catch (error) {
    if (error instanceof VideoDefinitionError) throw error;
    throw new VideoDefinitionError('params: Expected a finite JSON object.', {
      cause: error,
    });
  }
}

function invalidParameters(error: z.ZodError) {
  return new VideoDefinitionError(
    error.issues
      .map(
        ({ path, message }) => [`params`, ...path].join('.') + ': ' + message,
      )
      .join('\n'),
  );
}

export async function resolveVideoDefinition(
  value: unknown,
  params?: VideoParameters,
): Promise<ResolvedVideoDefinition> {
  if (value && typeof value === 'object' && parameterized in value)
    return (value as ParameterizedVideo)[parameterized](params);
  if (params !== undefined)
    throw new VideoDefinitionError(
      'params: This definition does not declare external parameters.',
    );
  return { value };
}

/** Qualify a local ID with its placement scopes for clips, transitions, or cues. */
export function videoId(scope: string, ...parts: string[]) {
  return [scope, ...parts]
    .map((part) => {
      const id = entityIdSchema.parse(part);
      return `${id.length}-${id}`;
    })
    .join('-');
}

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

export function parseVideoDefinition(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    'assets' in value &&
    value.assets &&
    typeof value.assets === 'object'
  ) {
    for (const [id, asset] of Object.entries(value.assets)) {
      if (asset?.renderer !== 'scene') continue;
      try {
        checkGraphicScene(asset.scene);
      } catch (cause) {
        throw new VideoDefinitionError(
          `assets.${id}.scene: ${(cause as Error).message}`,
          { cause },
        );
      }
    }
  }
  const parsed = videoDefinitionSchema.safeParse(value);
  if (!parsed.success)
    throw new VideoDefinitionError(
      parsed.error.issues
        .map(
          ({ path, message }) =>
            `${path.length ? path.join('.') : 'Definition'}: ${message}`,
        )
        .join('\n'),
    );

  const definition = parsed.data;
  const graphics = Object.values(definition.assets ?? {}).flatMap((asset) =>
    asset.kind === 'graphic' ? [asset.renderer] : [],
  );
  if (graphics.some((renderer) => renderer !== 'react' && renderer !== 'svg')) {
    if (definition.version !== undefined && definition.version < 3)
      throw new VideoDefinitionError(
        'version: Built-in graphic assets require version 3.',
      );
    return { ...definition, version: 3 as const };
  }
  if (graphics.length && definition.version === 1)
    throw new VideoDefinitionError('version: Graphics require version 2 or 3.');
  if (graphics.length && definition.version === undefined)
    return { ...definition, version: 2 as const };
  return definition;
}

export type ParsedVideoDefinition = ReturnType<typeof parseVideoDefinition>;
export type VideoAssetDefinition = z.output<typeof mediaAsset>;
