import { canvasColorPattern } from '@opencut/shared';
import type { GraphicScene, GraphicSceneNode } from '@opencut/shared';
import { z } from 'zod';
import { motionChannelSchema } from './motion-schema.js';
import { entityIdSchema } from './project.js';

const bounded = (min: number, max: number) => z.number().min(min).max(max);
const motion = (min: number, max: number) => {
  const value = bounded(min, max);
  return z.union([value, motionChannelSchema(value)]);
};
const px = motion(-32768, 32768);
const dimension = motion(0, 8192);
const blur = motion(0, 128);
const ratio = motion(0, 1);
const degrees = motion(-36000, 36000);
const color = z.string().regex(canvasColorPattern);
const paintColor = z.union([
  color,
  z.strictObject({ from: color, to: color, progress: ratio }),
]);
const paint = z.union([
  paintColor,
  z.strictObject({
    angle: degrees,
    stops: z
      .array(z.strictObject({ color: paintColor, offset: bounded(0, 1) }))
      .min(2)
      .max(12)
      .refine(
        (entries) =>
          entries.every(
            (stop, i) => !i || stop.offset >= entries[i - 1]!.offset,
          ),
        'Gradient stops must be ordered.',
      ),
  }),
]);
const d = z
  .string()
  .max(16384)
  .regex(/^\s*[mM][0-9mMlLhHvVcCsSqQtTaAzZeE.+,\s-]+$/);
const mask = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('rect'),
    x: px,
    y: px,
    width: dimension,
    height: dimension,
    radius: dimension.optional(),
  }),
  z.strictObject({
    type: z.literal('ellipse'),
    x: px,
    y: px,
    radiusX: dimension,
    radiusY: dimension,
  }),
  z.strictObject({ type: z.literal('path'), d }),
  z.strictObject({
    type: z.literal('gradient'),
    angle: degrees,
    start: ratio,
    end: ratio,
  }),
]);
const time = bounded(0, 1_000_000);
const base = z.strictObject({
  id: entityIdSchema,
  timing: z
    .strictObject({
      at: time,
      duration: time.min(1 / 1024).optional(),
      in: time.optional(),
      speed: bounded(1 / 64, 64).optional(),
      cycle: z
        .strictObject({
          mode: z.enum(['loop', 'ping-pong']),
          duration: time.min(1 / 1024),
        })
        .optional(),
    })
    .optional(),
  x: px.optional(),
  y: px.optional(),
  scaleX: motion(0.001, 8).optional(),
  scaleY: motion(0.001, 8).optional(),
  rotation: degrees.optional(),
  rotateX: degrees.optional(),
  rotateY: degrees.optional(),
  perspective: bounded(40, 12000).optional(),
  origin: z.tuple([bounded(-8192, 8192), bounded(-8192, 8192)]).optional(),
  opacity: ratio.optional(),
  blend: z.enum(['normal', 'multiply', 'screen', 'overlay']).optional(),
  follow: z
    .strictObject({ d, progress: ratio, orient: z.boolean().optional() })
    .optional(),
  mask: mask.optional(),
  effects: z
    .strictObject({
      blur: blur.optional(),
      shadow: z
        .strictObject({ x: px, y: px, blur, color: paintColor })
        .optional(),
      brightness: motion(0, 4).optional(),
      saturation: motion(0, 4).optional(),
    })
    .optional(),
});

const node: z.ZodType<GraphicSceneNode, GraphicSceneNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    base.extend({ type: z.literal('group'), children: z.array(node).max(512) }),
    base.extend({
      type: z.literal('rect'),
      width: dimension,
      height: dimension,
      radius: dimension.optional(),
      fill: paint,
    }),
    base.extend({
      type: z.literal('ellipse'),
      width: dimension,
      height: dimension,
      fill: paint,
    }),
    base.extend({
      type: z.literal('path'),
      d,
      fill: paintColor.optional(),
      stroke: paintColor.optional(),
      strokeWidth: motion(0, 128).optional(),
      draw: ratio.optional(),
    }),
    base.extend({
      type: z.literal('audio'),
      mode: z.enum(['spectrum', 'waveform', 'rms', 'beat']),
      width: dimension,
      height: dimension,
      color: paintColor,
      gain: bounded(0.01, 100).optional(),
    }),
    base.extend({
      type: z.enum(['image', 'media-frame']),
      resource: entityIdSchema,
      width: dimension,
      height: dimension,
      fit: z.enum(['contain', 'cover', 'fill']).optional(),
    }),
    base.extend({
      type: z.literal('text'),
      content: z.string().max(1024).optional(),
      runs: z
        .array(
          z.strictObject({
            text: z.string().min(1).max(1024),
            font: entityIdSchema.optional(),
            color: paintColor.optional(),
            weight: z.int().min(100).max(900).optional(),
          }),
        )
        .min(1)
        .max(32)
        .optional(),
      counter: z
        .strictObject({
          value: motion(-1e9, 1e9),
          digits: z.int().min(0).max(4).optional(),
          suffix: z.string().max(48).optional(),
        })
        .optional(),
      width: dimension,
      height: dimension,
      size: motion(1, 512),
      minSize: bounded(1, 512).optional(),
      lineHeight: bounded(0.7, 3).optional(),
      weight: z.int().min(100).max(900).optional(),
      font: entityIdSchema.optional(),
      color: paintColor,
      align: z.enum(['left', 'center', 'right']).optional(),
      overflow: z.enum(['fit', 'clip', 'error']).optional(),
      stroke: z
        .strictObject({ color: paintColor, width: motion(0, 16) })
        .optional(),
      kinetic: z
        .strictObject({
          unit: z.enum(['grapheme', 'word', 'line']),
          stagger: time,
          duration: time.min(1 / 1024),
          offsetY: bounded(-8192, 8192).optional(),
        })
        .optional(),
      highlight: z
        .array(
          z.strictObject({
            from: z.int().nonnegative(),
            to: z.int().positive(),
            start: time,
            end: time,
            background: paintColor,
            color: paintColor.optional(),
          }),
        )
        .max(128)
        .optional(),
    }),
  ]),
);

export const sceneLimits = { nodes: 512, depth: 16, paths: 16384 } as const;

export const graphicSceneSchema = z.strictObject({
  version: z.literal(1),
  units: z.literal('px'),
  children: z.array(node).min(1).max(sceneLimits.nodes),
});

export function checkGraphicScene(value: unknown) {
  // Check depth and work before the recursive schema reads the tree.
  const pending: { item: unknown; depth: number }[] = [
    { item: value, depth: 0 },
  ];
  let count = 0;
  while (pending.length) {
    const { item, depth } = pending.pop()!;
    if (!item || typeof item !== 'object' || !('children' in item)) continue;
    if (!Array.isArray(item.children)) continue;
    count += item.children.length;
    if (depth >= sceneLimits.depth || count > sceneLimits.nodes)
      throw new RangeError('Scene exceeds the 16-level or 512-node limit.');
    for (const child of item.children)
      pending.push({ item: child, depth: depth + 1 });
  }
}

export function validateSceneResources(
  scene: GraphicScene,
  resources: Record<string, string>,
  mediaFrames: Readonly<Record<string, unknown>> = {},
) {
  const ids = new Set<string>();
  for (const node of walkScene(scene.children)) {
    if (ids.has(node.id))
      throw new Error(`Scene node '${node.id}' has a duplicate ID.`);
    ids.add(node.id);
    if (
      node.type === 'media-frame' &&
      !Object.hasOwn(mediaFrames, node.resource)
    )
      throw new Error(
        `Scene node '${node.id}' requires a declared media frame '${node.resource}'.`,
      );
    if (node.type === 'image' || (node.type === 'text' && node.font)) {
      const key = node.type === 'text' ? node.font! : node.resource;
      const path = Object.hasOwn(resources, key) ? resources[key] : undefined;
      const expected =
        node.type === 'image'
          ? /\.(?:png|jpg|jpeg|webp|avif|svg)$/i
          : /\.(?:ttf|otf|woff|woff2)$/i;
      if (!path || !expected.test(path))
        throw new Error(
          `Scene node '${node.id}' requires a declared ${node.type === 'image' ? 'image' : 'font'} resource '${key}'.`,
        );
    }
    if (node.type === 'text') {
      if (
        [node.content, node.counter, node.runs].filter(
          (value) => value !== undefined,
        ).length !== 1
      )
        throw new Error(
          `Text node '${node.id}' requires one of content, rich text runs, or counter.`,
        );
      if (node.runs) {
        if (node.runs.reduce((sum, run) => sum + run.text.length, 0) > 1024)
          throw new Error(
            `Text node '${node.id}' rich text is limited to 1024 code units.`,
          );
        if (node.kinetic || node.highlight)
          throw new Error(
            `Text node '${node.id}' rich text runs require node-level animation or separate plain-text animated nodes.`,
          );
        for (const { font } of node.runs)
          if (
            font &&
            (!Object.hasOwn(resources, font) ||
              !/\.(?:ttf|otf|woff|woff2)$/i.test(resources[font]!))
          )
            throw new Error(
              `Text node '${node.id}' requires a declared run font '${font}'.`,
            );
      }
      if (node.highlight) {
        const text = node.content ?? '';
        const segmenter = new Intl.Segmenter('und', {
          granularity: 'grapheme',
        });
        const starts = new Set(
          [...segmenter.segment(text)].map(({ index }) => index),
        );
        starts.add(text.length);
        for (const { from, to, start, end } of node.highlight)
          if (
            to <= from ||
            end <= start ||
            !starts.has(from) ||
            !starts.has(to)
          )
            throw new Error(
              `Text node '${node.id}' has an invalid highlight character range or time.`,
            );
        if (node.kinetic)
          throw new Error(
            `Text node '${node.id}' cannot combine kinetic segmentation and timed highlights.`,
          );
      }
    }
  }
}

export function* walkScene(
  nodes: readonly GraphicSceneNode[],
): Iterable<GraphicSceneNode> {
  for (const node of nodes) {
    yield node;
    if (node.type === 'group') yield* walkScene(node.children);
  }
}

export function defineGraphicScene(scene: GraphicScene): GraphicScene {
  return scene;
}
