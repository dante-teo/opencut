import { z } from 'zod';
import { clipSpeedSchema } from './clip-timing.js';
import {
  canvasShape,
  clipVisualSchema,
  entityIdSchema,
  entityNameSchema,
  relativeMediaPathSchema,
} from './project.js';
import { frameRateSchema } from './time.js';
import { textLayerSchema } from './text-style.js';
import { trackAudioShape } from './audio.js';

const frame = z.int().nonnegative();
const duration = z.int().positive();
const clip = {
  id: entityIdSchema.optional(),
  at: frame,
};
const timedMedia = {
  ...clip,
  asset: entityIdSchema,
  sourceIn: frame.optional(),
  sourceOut: duration,
  speed: clipSpeedSchema.optional(),
  ...trackAudioShape,
  fadeIn: duration.optional(),
  fadeOut: duration.optional(),
};
const track = {
  id: entityIdSchema.optional(),
  name: entityNameSchema.optional(),
};
const asset = z.strictObject({
  path: relativeMediaPathSchema,
  kind: z.enum(['video', 'image', 'audio']),
});

export const videoDefinitionSchema = z.strictObject({
  version: z.literal(1).optional(),
  name: entityNameSchema.optional(),
  canvas: z.strictObject({
    width: duration,
    height: duration,
    frameRate: z.union([duration, frameRateSchema]),
    durationFrames: duration,
    backgroundColor: canvasShape.backgroundColor,
  }),
  assets: z.record(entityIdSchema, asset).optional(),
  tracks: z.array(
    z.discriminatedUnion('type', [
      z.strictObject({
        ...track,
        ...trackAudioShape,
        type: z.literal('video'),
        clips: z.array(
          z.strictObject({
            ...timedMedia,
            visual: clipVisualSchema.optional(),
          }),
        ),
      }),
      z.strictObject({
        ...track,
        ...trackAudioShape,
        type: z.literal('audio'),
        clips: z.array(z.strictObject(timedMedia)),
      }),
      z.strictObject({
        ...track,
        type: z.literal('image'),
        clips: z.array(
          z.strictObject({
            ...clip,
            asset: entityIdSchema,
            duration,
            visual: clipVisualSchema.optional(),
          }),
        ),
      }),
      z.strictObject({
        ...track,
        type: z.literal('text'),
        clips: z.array(
          z.strictObject({
            ...clip,
            duration,
            text: textLayerSchema.pick({
              content: true,
              fontFamily: true,
              fontSize: true,
              fontWeight: true,
              color: true,
              alignment: true,
              wrapWidth: true,
              stroke: true,
              shadow: true,
              background: true,
            }),
            visual: clipVisualSchema.omit({ fit: true, crop: true }).optional(),
          }),
        ),
      }),
    ]),
  ),
});

export type VideoDefinition = z.input<typeof videoDefinitionSchema>;

/** Type an authoring expression. Both file formats are validated when compiled. */
export function defineVideo(definition: VideoDefinition): VideoDefinition {
  return definition;
}
