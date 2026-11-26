import { z } from 'zod';

const strength = z.number().min(0).max(1);
const signed = z.number().min(-1).max(1);
const seconds = z.number().min(0).max(86_400);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const beautyAnalysisId = z.string().regex(/^[a-f0-9]{64}$/);

export const beautyParameterSchema = z.strictObject({
  faceSlim: strength.optional(),
  headReduce: strength.optional(),
  eyeEnlarge: strength.optional(),
  bodySlim: strength.optional(),
  waistSlim: strength.optional(),
  legSlim: strength.optional(),
  legLength: strength.optional(),
  armSlim: strength.optional(),
  armLength: strength.optional(),
  skinSmooth: strength.optional(),
  skinBrighten: strength.optional(),
  warmth: signed.optional(),
  tint: signed.optional(),
  saturation: signed.optional(),
  facialRedness: strength.optional(),
});
export const beautyParameters = Object.keys(
  beautyParameterSchema.shape,
) as Array<keyof typeof beautyParameterSchema.shape>;
const interval = z
  .strictObject({ start: seconds, end: seconds })
  .refine(({ start, end }) => end > start, {
    path: ['end'],
    message: 'End must follow start.',
  });
const normalizedRect = z.strictObject({
  x: strength,
  y: strength,
  width: strength.positive(),
  height: strength.positive(),
});
const protect = normalizedRect
  .extend({ timeRange: interval.optional() })
  .refine(({ x, y, width, height }) => x + width <= 1 && y + height <= 1, {
    message: 'Protected region must fit the normalized source frame.',
  });

const point = (value: typeof strength) =>
  z.strictObject({ time: seconds, value });

const keyframes = z.strictObject(
  Object.fromEntries(
    Object.entries(beautyParameterSchema.shape).map(([name, value]) => [
      name,
      z
        .array(point(value.unwrap()))
        .min(1)
        .max(128)
        .refine(
          (points) =>
            points.every(
              (item, i) => i === 0 || item.time > points[i - 1]!.time,
            ),
          'Keyframe times must increase.',
        )
        .optional(),
    ]),
  ),
);

const beautyEffectSchema = z
  .strictObject({
    id,
    type: z.literal('beauty'),
    version: z.literal(1),
    enabled: z.boolean().default(true),
    target: z.strictObject({ assetId: id, shotId: id, trackId: id }),
    timeRange: interval,
    parameters: beautyParameterSchema.default({}),
    keyframes: keyframes.optional(),
    interpolation: z.enum(['linear', 'hold']).default('linear'),
    skinScope: z.enum(['face', 'visible-target-skin']).default('face'),
    protectedRegions: z.array(protect).max(128).default([]),
    temporal: z
      .strictObject({
        strength: strength.default(0.5),
      })
      .prefault({}),
    failurePolicy: z
      .strictObject({
        trackingUncertain: z.enum(['bypass', 'fail']).default('fail'),
        invalidGeometry: z.enum(['attenuate', 'fail']).default('attenuate'),
        unreliableReconstruction: z
          .enum(['attenuate', 'fail'])
          .default('attenuate'),
      })
      .prefault({}),
  })
  .superRefine(({ timeRange, keyframes }, ctx) => {
    for (const [name, points] of Object.entries(keyframes ?? {}))
      if (
        points?.some(
          ({ time }) => time < timeRange.start || time >= timeRange.end,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['keyframes', name],
          message: 'Keyframes must be inside the source-time effect interval.',
        });
  });

export const beautyRecipeSchema = z
  .strictObject({
    type: z.literal('beauty'),
    analysisRef: beautyAnalysisId,
    effects: z.array(beautyEffectSchema).min(1).max(32),
    acceptance: z
      .enum(['complete-coverage', 'visible-result', 'allow-limitations'])
      .default('complete-coverage'),
  })
  .superRefine(({ effects }, ctx) => {
    const ids = new Set<string>();
    const ranges = new Map<string, Array<z.output<typeof interval>>>();
    for (const [index, effect] of effects.entries()) {
      const { id, target, timeRange } = effect;
      if (ids.has(id))
        ctx.addIssue({
          code: 'custom',
          path: ['effects', index, 'id'],
          message: 'Beauty effect IDs must be unique.',
        });
      ids.add(id);
      if (!isActiveBeautyEffect(effect)) continue;
      const key = JSON.stringify(target);
      const previous = ranges.get(key) ?? [];
      if (
        previous.some(
          ({ start, end }) => start < timeRange.end && timeRange.start < end,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['effects', index, 'timeRange'],
          message: 'Intervals for the same beauty target must not overlap.',
        });
      ranges.set(key, [...previous, timeRange]);
    }
  });

export type BeautyRecipeStep = z.output<typeof beautyRecipeSchema>;
type BeautyEffect = BeautyRecipeStep['effects'][number];

export function isActiveBeautyEffect({
  enabled,
  parameters,
  keyframes,
}: BeautyEffect) {
  return (
    enabled &&
    beautyParameters.some((name) => {
      const points = keyframes?.[name];
      return points
        ? points.some(({ value }) => value !== 0)
        : (parameters[name] ?? 0) !== 0;
    })
  );
}

export function isActiveBeautyStep(step: BeautyRecipeStep) {
  return step.effects.some(isActiveBeautyEffect);
}
