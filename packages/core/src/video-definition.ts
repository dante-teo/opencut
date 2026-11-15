import { z } from 'zod';
import {
  assetSchema,
  clipSchema,
  entityIdSchema,
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
const textClip = clip.extend({ text });
const track = trackSchema.omit({ id: true, name: true, type: true }).extend({
  id: entityIdSchema.optional(),
  name: trackSchema.shape.name.optional(),
});
const visualOnlyTrack = track.omit({ volume: true, muted: true });
const asset = assetSchema
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
  version: z.literal(1).optional(),
  ...snapshotSchema.shape.metadata.partial().shape,
  canvas: settingsSchema.extend({
    frameRate: z.union([frameCount, frameRateSchema]),
  }),
  assets: z.record(entityIdSchema, asset).optional(),
  fonts: z.record(entityIdSchema, font).optional(),
  tracks: z.array(
    z.discriminatedUnion('type', [
      track.extend({
        type: z.literal('video'),
        clips: z.array(z.union([mediaClip, textClip])),
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
  transitions: z.array(transitionSchema).optional(),
  markers: z.array(markerSchema).optional(),
});

export type VideoDefinition = z.input<typeof videoDefinitionSchema>;

/** Type an authoring expression. Both file formats are validated when compiled. */
export function defineVideo(definition: VideoDefinition): VideoDefinition {
  return definition;
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

  return parsed.data;
}

export type ParsedVideoDefinition = ReturnType<typeof parseVideoDefinition>;
export type VideoAssetDefinition = NonNullable<
  ParsedVideoDefinition['assets']
>[string];
