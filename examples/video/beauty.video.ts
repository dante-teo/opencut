import { defineVideo, videoParams } from '@opencut/sdk';
import type { VideoRecipe } from '@opencut/sdk';

const portrait = {
  faceSlim: 0.18,
  headReduce: 0.12,
  eyeEnlarge: 0.11,
  skinSmooth: 0.22,
  skinBrighten: 0.13,
  warmth: 0.03,
  facialRedness: 0.15,
} as const;
const body = {
  bodySlim: 0.16,
  waistSlim: 0.13,
  armSlim: 0.12,
  armLength: 0.06,
  legSlim: 0.1,
  legLength: 0.06,
} as const;
const levels = {
  skin: { skinSmooth: 0.18, skinBrighten: 0.1 },
  subtle: { faceSlim: 0.12, skinSmooth: 0.18, skinBrighten: 0.1 },
  portrait,
  body,
  full: { ...portrait, ...body },
  neutral: {},
} as const;

export default defineVideo(
  {
    source: videoParams.string().min(1),
    analysisRef: videoParams.string().regex(/^[a-f0-9]{64}$/),
    frameRate: videoParams.int().positive(),
    frames: videoParams.int().positive(),
    people: videoParams
      .array(
        videoParams.strictObject({
          shotId: videoParams.string(),
          trackId: videoParams.string(),
          start: videoParams.number().nonnegative(),
          end: videoParams.number().positive(),
          look: videoParams.enum([
            'subtle',
            'skin',
            'portrait',
            'body',
            'full',
            'neutral',
          ]),
          fadeIn: videoParams.boolean().default(false),
        }),
      )
      .min(1),
    allowLimitations: videoParams.boolean().default(false),
    acceptance: videoParams
      .enum(['complete-coverage', 'visible-result', 'allow-limitations'])
      .optional(),
    protect: videoParams
      .array(
        videoParams.strictObject({
          x: videoParams.number(),
          y: videoParams.number(),
          width: videoParams.number(),
          height: videoParams.number(),
        }),
      )
      .default([]),
  },
  ({
    source,
    analysisRef,
    frameRate,
    frames,
    people,
    allowLimitations,
    acceptance,
    protect,
  }) => {
    const recipe: VideoRecipe = [
      {
        type: 'beauty',
        analysisRef,
        acceptance:
          acceptance ??
          (allowLimitations ? 'allow-limitations' : 'complete-coverage'),
        effects: people.map(
          ({ shotId, trackId, start, end, look, fadeIn }, index) => ({
            type: 'beauty',
            version: 1,
            id: 'beauty-' + (index + 1),
            target: { assetId: 'picture', shotId, trackId },
            timeRange: { start, end },
            parameters: levels[look],
            ...(fadeIn &&
              look !== 'neutral' && {
                keyframes: Object.fromEntries(
                  Object.entries(levels[look]).map(([parameter, value]) => [
                    parameter,
                    [
                      { time: start, value: 0 },
                      { time: start + Math.min(0.4, (end - start) / 2), value },
                    ],
                  ]),
                ),
              }),
            protectedRegions: protect,
            failurePolicy: {
              trackingUncertain: allowLimitations ? 'bypass' : 'fail',
            },
          }),
        ),
      },
    ];
    return {
      canvas: { width: 640, height: 360, frameRate },
      assets: { picture: { path: source, kind: 'video', recipe } },
      tracks: [
        {
          type: 'video',
          clips: [{ asset: 'picture', at: 0, sourceOut: frames }],
        },
      ],
    };
  },
);
