import { canvasColorPattern } from '@opencut/shared';
import type {
  AnimatedNumber,
  GraphicScene,
  GraphicSceneNode,
  MotionChannel,
} from '@opencut/shared';
import { z } from 'zod';
import { entityIdSchema } from './project.js';

const copy = z.string().min(1).max(280);
const color = z.string().regex(canvasColorPattern);
const style = {
  accent: color.optional(),
  ink: color.optional(),
  background: color.optional(),
  font: entityIdSchema.optional(),
  revealFrames: z.number().min(1).max(240).optional(),
};
const heading = z.strictObject({
  name: z.enum(['title-sequence', 'lower-third', 'device-card', 'end-card']),
  title: copy,
  subtitle: copy.optional(),
  ...style,
});
const data = z.strictObject({
  name: z.enum(['bar-chart', 'line-chart']),
  title: copy,
  rows: z
    .array(z.strictObject({ label: copy, value: z.number().min(0).max(1e6) }))
    .min(2)
    .max(8),
  ...style,
});
const preset = z.discriminatedUnion('name', [
  heading,
  data,
  z.strictObject({
    name: z.literal('statistic'),
    label: copy,
    value: z.number().min(-1e9).max(1e9),
    unit: z.string().max(12).optional(),
    ...style,
  }),
  z.strictObject({
    name: z.literal('callout'),
    label: copy,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    ...style,
  }),
  z.strictObject({
    name: z.literal('split-screen'),
    first: entityIdSchema,
    second: entityIdSchema,
    ...style,
  }),
  z.strictObject({
    name: z.enum(['waveform', 'spectrum']),
    title: copy.optional(),
    gain: z.number().min(0.01).max(100).optional(),
    ...style,
  }),
]);

export const presetSceneSchema = z.strictObject({
  version: z.literal(1),
  units: z.literal('px'),
  preset,
});
export type ScenePreset = z.input<typeof preset>;
export const graphicScenePresets = preset.options.flatMap(({ shape }) =>
  shape.name instanceof z.ZodEnum ? shape.name.options : [shape.name.value],
);

const easing = {
  type: 'cubic-bezier',
  x1: 0.32,
  y1: 0,
  x2: 0.18,
  y2: 1,
} as const;
const ramp = (from: number, to: number, end: number): MotionChannel => ({
  keys: [
    { at: 0, value: from, easing },
    { at: end, value: to },
  ],
});

export function createPresetScene(
  input: ScenePreset,
  { width, height }: { width: number; height: number },
): GraphicScene {
  const p = preset.parse(input);
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 64 && value <= 3840,
    )
  )
    throw new RangeError(
      'Preset surfaces require integer sides between 64 and 3840 pixels.',
    );
  const min = Math.min(width, height);
  const edge = Math.round(min * 0.08);
  const inner = width - 2 * edge;
  const size = Math.max(8, Math.round(min * 0.072));
  const accent = p.accent ?? '#54e1cc';
  const ink = p.ink ?? '#eaf5f1';
  const background = p.background ?? '#112438';
  const frames = p.revealFrames ?? 30;
  const rect = (
    id: string,
    x: number,
    y: AnimatedNumber,
    w: AnimatedNumber,
    h: AnimatedNumber,
    fill = background,
  ): GraphicSceneNode => ({
    type: 'rect',
    id,
    x,
    y,
    width: w,
    height: h,
    fill,
  });
  const text = (
    id: string,
    content: string,
    x: number,
    y: number,
    w: number,
    h: number,
    fontSize = size,
    tint = ink,
  ): GraphicSceneNode & { type: 'text' } => ({
    type: 'text',
    id,
    content,
    x,
    y,
    width: w,
    height: h,
    size: fontSize,
    weight: 750,
    color: tint,
    align: 'left',
    overflow: 'fit',
    minSize: Math.max(6, fontSize * 0.55),
    ...(p.font && { font: p.font }),
  });
  const bg = rect('background', 0, 0, width, height);
  let children: GraphicSceneNode[];

  switch (p.name) {
    case 'split-screen': {
      const portrait = height > width;
      const gap = Math.max(2, Math.round(edge / 3));
      const w = portrait ? inner : (inner - gap) / 2;
      const h = portrait ? (height - 2 * edge - gap) / 2 : height - 2 * edge;
      children = [
        bg,
        ...[p.first, p.second].map((resource, i): GraphicSceneNode => ({
          type: 'image',
          id: `panel-${i + 1}`,
          resource,
          fit: 'cover',
          x: edge + (portrait ? 0 : i * (w + gap)),
          y: edge + (portrait ? i * (h + gap) : 0),
          width: w,
          height: h,
        })),
      ];
      break;
    }
    case 'callout': {
      const x = p.x * width;
      const y = p.y * height;
      const anchor = x > width / 2 ? edge : width * 0.58;
      const row = Math.max(
        edge,
        Math.min(height - edge - size, y - min * 0.22),
      );
      children = [
        {
          type: 'path',
          id: 'leader',
          d: `M${x} ${y} L${anchor} ${row + size} h${inner * 0.23}`,
          stroke: accent,
          strokeWidth: Math.max(1, min * 0.004),
          draw: ramp(0, 1, frames),
        },
        text(
          'caption',
          p.label,
          anchor,
          row,
          inner * 0.36,
          size * 1.2,
          size * 0.55,
        ),
      ];
      break;
    }
    case 'waveform':
    case 'spectrum':
      children = [
        bg,
        ...(p.title
          ? [text('audio-title', p.title, edge, edge, inner, size * 1.4)]
          : []),
        {
          type: 'audio',
          id: 'monitor',
          mode: p.name,
          x: edge,
          y: height * 0.36,
          width: inner,
          height: height * 0.46,
          color: accent,
          gain: p.gain,
        },
      ];
      break;
    case 'bar-chart':
    case 'line-chart': {
      const max = Math.max(1, ...p.rows.map(({ value }) => value));
      const bottom = height * 0.8;
      const range = height * 0.5;
      const spacing = inner / p.rows.length;
      const plotted = p.rows.map(
        ({ value }, i) =>
          [edge + (i + 0.5) * spacing, bottom - (value * range) / max] as const,
      );
      const marks = p.rows.flatMap(
        ({ label, value }, i): GraphicSceneNode[] => {
          const [x, y] = plotted[i]!;
          const caption = text(
            `label-${i}`,
            label,
            x - spacing / 2,
            bottom + min * 0.035,
            spacing,
            height - bottom - edge,
            size * 0.45,
          );
          caption.align = 'center';
          const item =
            p.name === 'bar-chart'
              ? rect(
                  `bar-${i}`,
                  x - spacing * 0.31,
                  ramp(bottom, y, frames),
                  spacing * 0.62,
                  ramp(0, bottom - y, frames),
                  accent,
                )
              : {
                  type: 'ellipse' as const,
                  id: `marker-${i}`,
                  x: x - 4,
                  y: y - 4,
                  width: 8,
                  height: 8,
                  fill: accent,
                  opacity: ramp(0, 1, frames),
                };
          const number = text(
            `value-${i}`,
            String(value),
            x - spacing / 2,
            y - size * 0.68,
            spacing,
            size * 0.7,
            size * 0.48,
          );
          number.align = 'center';
          number.opacity = ramp(0, 1, frames);
          return [item, caption, number];
        },
      );
      children = [
        bg,
        text('chart-title', p.title, edge, edge, inner, size * 1.5),
        ...marks,
      ];
      if (p.name === 'line-chart')
        children.push({
          type: 'path',
          id: 'trend',
          d: plotted.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' '),
          stroke: accent,
          strokeWidth: Math.max(1, min * 0.004),
          draw: ramp(0, 1, frames),
        });
      break;
    }
    case 'statistic': {
      const number = text(
        'number',
        '',
        edge,
        height * 0.36,
        inner,
        height * 0.4,
        size * 2.4,
        accent,
      );
      delete number.content;
      number.counter = { value: ramp(0, p.value, frames), suffix: p.unit };
      children = [
        bg,
        text('statistic-label', p.label, edge, edge, inner, size * 1.5),
        number,
      ];
      break;
    }
    default: {
      const y = p.name === 'lower-third' ? height * 0.68 : height * 0.35;
      const title = text('title', p.title, edge, y, inner, size * 2);
      title.opacity = ramp(0, 1, frames);
      if (p.name === 'title-sequence')
        title.kinetic = {
          unit: 'grapheme',
          duration: frames * 0.7,
          stagger: frames / 22,
        };
      const lead = p.name === 'lower-third' ? [] : [bg];
      if (p.name === 'device-card')
        lead.push({
          type: 'rect',
          id: 'device',
          x: edge * 0.5,
          y: height * 0.2,
          width: width - edge,
          height: height * 0.63,
          radius: edge * 0.3,
          fill: {
            angle: 140,
            stops: [
              { offset: 0, color: accent },
              { offset: 1, color: background },
            ],
          },
          opacity: 0.36,
          rotateY: 10,
          origin: [inner * 0.5, height * 0.38],
          perspective: 1200,
        });
      children = [
        ...lead,
        rect(
          'accent',
          edge,
          y - size * 0.35,
          ramp(0, inner * 0.24, frames),
          Math.max(2, Math.round(min * 0.008)),
          accent,
        ),
        title,
        ...(p.subtitle
          ? [
              text(
                'subtitle',
                p.subtitle,
                edge,
                y + size * 1.6,
                inner,
                Math.max(size, height - (y + size * 1.6) - edge),
                size * 0.58,
                accent,
              ),
            ]
          : []),
      ];
    }
  }
  return { version: 1, units: 'px', children };
}
