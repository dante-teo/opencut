import { z } from 'zod';
import { renderQualities } from '@opencut/shared';

const pixels = z.int().min(1).max(16384);
export const recipeFormatSchema = z.enum(['mov', 'mp4', 'png', 'wav', 'flac']);
const frameRate = {
  numerator: z.int().positive().max(120000),
  denominator: z.int().positive().max(120000).default(1),
};
const enhancementBackend = z.literal('videotoolbox').default('videotoolbox');
const interpolation = {
  ...frameRate,
  quality: z.enum(renderQualities).optional(),
  sceneThreshold: z.number().positive().max(100).default(8),
  sceneCuts: z.array(z.number().positive()).max(4096).default([]),
};

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
        ...frameRate,
      }),
      z.strictObject({
        type: z.literal('interpolateFrames'),
        ...interpolation,
      }),
      z.strictObject({
        type: z.literal('smoothSlowMotion'),
        ...interpolation,
        speed: z.number().min(0.125).lt(1),
      }),
      z.strictObject({
        type: z.literal('superResolution'),
        backend: enhancementBackend,
        width: pixels,
        height: pixels,
        quality: z.enum(renderQualities).optional(),
      }),
      z.strictObject({
        type: z.literal('denoise'),
        backend: enhancementBackend,
        strength: z.enum(['light', 'medium', 'strong']).default('medium'),
      }),
      z.strictObject({ type: z.literal('extractAudio') }),
      z.strictObject({
        type: z.literal('normalizeAudio'),
        targetLufs: z.number().min(-40).max(-10).default(-16),
      }),
      z.strictObject({
        type: z.literal('convert'),
        format: recipeFormatSchema,
      }),
    ]),
  )
  .min(1)
  .max(32);

export type VideoRecipe = z.input<typeof videoRecipeSchema>;
export type ResolvedVideoRecipe = z.output<typeof videoRecipeSchema>;
export type RecipeFormat = z.output<typeof recipeFormatSchema>;

export type EnhancementStep = Extract<
  ResolvedVideoRecipe[number],
  { type: 'superResolution' | 'denoise' }
>;

export function isEnhancementStep(
  step: ResolvedVideoRecipe[number],
): step is EnhancementStep {
  return step.type === 'superResolution' || step.type === 'denoise';
}

export type InterpolationStep = Extract<
  ResolvedVideoRecipe[number],
  { type: 'interpolateFrames' | 'smoothSlowMotion' }
>;

export function isInterpolationStep(
  step: ResolvedVideoRecipe[number],
): step is InterpolationStep {
  return step.type === 'interpolateFrames' || step.type === 'smoothSlowMotion';
}

export function inheritsRenderQuality(step: ResolvedVideoRecipe[number]) {
  return (
    (isInterpolationStep(step) || step.type === 'superResolution') &&
    step.quality === undefined
  );
}
