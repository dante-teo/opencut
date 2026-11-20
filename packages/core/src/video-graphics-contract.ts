import { z } from 'zod';
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

const graphicLocation = z.strictObject({
  kind: z.literal('graphic'),
  recipe: z.never().optional(),
  freezeFrame: z.never().optional(),
  provenance: z.never().optional(),
  name,
  width: dimension.optional(),
  height: dimension.optional(),
});

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
    durationFrames: z.int().positive(),
    props: graphicPropsSchema.optional(),
    resources: z.record(entityIdSchema, relativeMediaPathSchema).optional(),
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
