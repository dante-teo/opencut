import { z } from 'zod';

const target = z.strictObject({
  assetId: z.string(),
  shotId: z.string(),
  trackId: z.string(),
});

const sourceInterval = z.strictObject({
  startFrame: z.int().nonnegative(),
  endFrame: z.int().positive(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
});

const outcome = z.strictObject({
  effectId: z.string(),
  target,
  parameter: z.string(),
  status: z.enum([
    'applied',
    'attenuated',
    'bypassed',
    'unsupported',
    'failed',
  ]),
  reason: z.string().nullable(),
  requested: z.tuple([z.number(), z.number()]),
  effective: z.tuple([z.number(), z.number()]),
  measurement: z
    .strictObject({
      metric: z.enum([
        'head-silhouette-area-reduction-percent',
        'mean-cheek-width-reduction-percent',
        'mean-arm-chain-extension-percent',
        'mean-hip-to-ankle-extension-percent',
      ]),
      min: z.number(),
      max: z.number(),
      samples: z.int().positive(),
    })
    .optional(),
  frames: z.int().nonnegative(),
  activeRange: z
    .strictObject({
      start: z.number().nonnegative(),
      end: z.number().positive(),
    })
    .optional(),
  intervals: z.array(sourceInterval),
});
export const beautyReportSchema = z.strictObject({
  version: z.literal(1),
  profile: z.literal('cpu-beauty-v1'),
  analysisRef: z.string(),
  status: z.enum(['completed', 'completed-with-limitations']),
  intervals: z.array(outcome),
  visibleResult: z
    .strictObject({
      profile: z.literal('cpu-beauty-visible-v2'),
      status: z.enum(['passed', 'failed']),
      controls: z.array(
        z.strictObject({
          effectId: z.string(),
          parameter: z.string(),
          status: z.enum(['passed', 'failed']),
          frames: z.int().positive(),
          visibleFrames: z.int().nonnegative(),
          missingFrames: z.int().nonnegative(),
          activeSeconds: z.number().positive(),
          visibleSeconds: z.number().nonnegative(),
          longestBelowFloorSeconds: z.number().nonnegative(),
          firstBelowFloorFrame: z.int().nonnegative().nullable(),
        }),
      ),
      unavailableControls: z.array(
        z.strictObject({ effectId: z.string(), parameter: z.string() }),
      ),
    })
    .optional(),
  reconstruction: z
    .array(
      z.strictObject({
        effectId: z.string(),
        target,
        intervals: z.array(sourceInterval),
        temporalPixels: z.int().nonnegative(),
        spatialPixels: z.int().nonnegative(),
        sample: z.strictObject({
          frame: z.int().nonnegative(),
          seconds: z.number().nonnegative(),
          box: z.tuple([
            z.int().nonnegative(),
            z.int().nonnegative(),
            z.int().positive(),
            z.int().positive(),
          ]),
          temporalPixels: z.int().nonnegative(),
          spatialPixels: z.int().nonnegative(),
        }),
      }),
    )
    .optional(),
  metrics: z.strictObject({
    temporalPixels: z.int().nonnegative(),
    spatialPixels: z.int().nonnegative(),
    changedPixels: z.int().nonnegative(),
    changedFrames: z.int().nonnegative(),
  }),
  quality: z.strictObject({
    geometryBounds: z.enum(['passed', 'not-evaluated']),
    sourceTiming: z.enum(['passed', 'not-evaluated']),
    visualAcceptance: z.literal('not-evaluated'),
  }),
  frames: z.int().positive(),
  resources: z.strictObject({
    seconds: z.number().nonnegative(),
    peakWorkerBytes: z.int().nonnegative(),
    bytes: z.int().positive(),
  }),
});
export type BeautyRenderReport = z.output<typeof beautyReportSchema>;
