import { z } from 'zod';
import { timeSchema } from './time.js';
import type { FrameRate, RationalTime } from './time.js';
import { audioAnalysisSchema } from './graphic-audio-schema.js';
import { presetSceneSchema } from './scene-presets.js';
import { graphicSceneSchema } from './graphic-scene-schema.js';
import {
  intrinsicRangeSchema,
  threeSceneSchema,
} from './graphic-adapter-inputs.js';
import {
  entityIdSchema,
  entityNameSchema,
  graphicPropsSchema,
  relativeMediaPathSchema,
} from './project.js';

const axis = 3840;
const pixels = 3840 * 2160;
const dimension = z.int().positive().max(axis);
const name = entityNameSchema.optional();

const motionBlur = z.strictObject({
  samples: z.int().min(2).max(12),
  shutterAngle: z.int().min(1).max(360),
});
export const exactGraphicSampling = {
  sampling: z.literal('exact').optional(),
  motionBlur: motionBlur.optional(),
};

const graphicLocation = z.strictObject({
  kind: z.literal('graphic'),
  recipe: z.never().optional(),
  freezeFrame: z.never().optional(),
  provenance: z.never().optional(),
  name,
  width: dimension.optional(),
  height: dimension.optional(),
});

export const graphicTemplates = [
  'LowerThird',
  'StatisticCard',
  'BarChart',
  'Callout',
  'SectionCard',
] as const;
const resources = z.record(entityIdSchema, relativeMediaPathSchema).optional();
const durationFrames = z.int().positive();
const fixedSampling = { motionBlur: motionBlur.optional() };
const animatedGraphic = graphicLocation.extend({ durationFrames, resources });

const animationParameters = z.record(
  entityIdSchema,
  z.enum(['string', 'number', 'boolean', 'json']),
);

export const graphicAnimationSchema = z.strictObject({
  version: z.literal(1),
  seed: z.int().nonnegative().max(0xffffffff).optional(),
  parameters: animationParameters.optional(),
});

export function validateAnimationProps(
  parameters: z.output<typeof animationParameters>,
  props: GraphicProps,
) {
  for (const key of Object.keys(props)) {
    if (!Object.hasOwn(parameters, key))
      throw new Error(`Unknown parameter '${key}'.`);
  }
  for (const [key, type] of Object.entries(parameters)) {
    if (
      !Object.hasOwn(props, key) ||
      (type !== 'json' && typeof props[key] !== type)
    )
      throw new Error(
        `Parameter '${key}' requires a default and must be a ${type} value.`,
      );
  }
}

export const graphicAssetSchema = z.discriminatedUnion('renderer', [
  graphicLocation.extend({
    renderer: z.literal('svg'),
    fonts: z
      .record(
        entityIdSchema,
        relativeMediaPathSchema.refine(
          (path) => /\.(ttf|otf)$/i.test(path),
          'Expected a TTF or OTF font.',
        ),
      )
      .refine(
        (fonts) => Object.keys(fonts).length <= 8,
        'Choose at most eight SVG font aliases.',
      )
      .optional(),
    path: relativeMediaPathSchema.refine(
      (path) => /\.svg$/i.test(path),
      'Expected an SVG file.',
    ),
  }),
  graphicLocation.extend({
    renderer: z.literal('react'),
    path: relativeMediaPathSchema.refine(
      (path) => /\.[jt]sx$/i.test(path),
      'Expected a TSX or JSX component.',
    ),
    durationFrames,
    props: graphicPropsSchema.optional(),
    resources,
    ...exactGraphicSampling,
    animation: graphicAnimationSchema.optional(),
    audioAnalysis: audioAnalysisSchema.optional(),
  }),
  animatedGraphic.extend({
    renderer: z.literal('scene'),
    scene: z.union([graphicSceneSchema, presetSceneSchema]),
    mediaFrames: z
      .record(
        entityIdSchema,
        z.strictObject({
          asset: entityIdSchema,
          offset: timeSchema.optional(),
        }),
      )
      .refine(
        (entries) => Object.keys(entries).length <= 2,
        'Choose up to two media-frame sources.',
      )
      .optional(),
    audioAnalysis: audioAnalysisSchema.optional(),
    path: z.never().optional(),
    ...fixedSampling,
  }),
  animatedGraphic.extend({
    renderer: z.literal('template'),
    template: z.enum(graphicTemplates),
    props: graphicPropsSchema.optional(),
    path: z.never().optional(),
  }),
  animatedGraphic.extend({
    renderer: z.literal('lottie'),
    path: relativeMediaPathSchema.refine(
      (path) => /\.json$/i.test(path),
      'Expected a Lottie JSON file.',
    ),
    outOfRange: intrinsicRangeSchema.optional(),
    ...fixedSampling,
  }),
  animatedGraphic.extend({
    renderer: z.literal('three'),
    path: relativeMediaPathSchema
      .refine(
        (path) => /\.glb$/i.test(path),
        'Expected a self-contained GLB file.',
      )
      .optional(),
    scene: threeSceneSchema,
    ...fixedSampling,
  }),
]);

export type GraphicAssetDefinition = z.input<typeof graphicAssetSchema>;
export type GraphicProps = z.output<typeof graphicPropsSchema>;

export function graphicSurface(
  graphic: GraphicAssetDefinition,
  canvas: { width: number; height: number },
) {
  const width = dimension.parse(graphic.width ?? canvas.width);
  const height = dimension.parse(graphic.height ?? canvas.height);
  if (width * height > pixels)
    throw new RangeError(
      'A graphics surface may contain at most 3840 × 2160 pixels.',
    );
  return { width, height };
}

export function resolveGraphicProps(
  defaults?: GraphicProps,
  overrides?: GraphicProps,
): GraphicProps {
  return JSON.parse(
    JSON.stringify({ ...defaults, ...overrides }),
  ) as GraphicProps;
}

/** Anime.js placements use whole samples on the project's rational frame grid. */
export function graphicFrameIndex(
  time: number | RationalTime,
  rate: FrameRate,
) {
  if (typeof time === 'number') return time;
  const ticks = BigInt(time.numerator) * BigInt(rate.numerator);
  const size = BigInt(time.denominator) * BigInt(rate.denominator);
  const frame = ticks / size;
  if (ticks % size || frame > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(
      'Anime.js clip boundaries must land on whole project frames.',
    );
  return Number(frame);
}
