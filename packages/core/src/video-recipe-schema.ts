import { z } from 'zod';

const pixels = z.int().min(1).max(16384);
const format = z.enum(['mov', 'mp4', 'png', 'wav', 'flac']);
export const videoRecipeSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('trim'),
        start: z.number().nonnegative(),
        end: z.number().positive(),
      }),
      z.strictObject({
        type: z.literal('crop'),
        x: z.int().nonnegative().max(16384),
        y: z.int().nonnegative().max(16384),
        width: pixels,
        height: pixels,
      }),
      z.strictObject({
        type: z.literal('resize'),
        width: pixels,
        height: pixels,
        method: z
          .enum(['bicubic', 'bilinear', 'lanczos', 'nearest'])
          .default('bicubic'),
      }),
      z.strictObject({
        type: z.literal('frameRate'),
        numerator: z.int().positive().max(120000),
        denominator: z.int().positive().max(120000).default(1),
      }),
      z.strictObject({ type: z.literal('extractAudio') }),
      z.strictObject({
        type: z.literal('normalizeAudio'),
        targetLufs: z.number().min(-40).max(-10).default(-16),
      }),
      z.strictObject({ type: z.literal('convert'), format }),
    ]),
  )
  .min(1)
  .max(32);

export type VideoRecipe = z.input<typeof videoRecipeSchema>;
export type ResolvedVideoRecipe = z.output<typeof videoRecipeSchema>;
export type RecipeFormat = z.output<typeof format>;
