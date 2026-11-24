import {
  animatedProperties,
  clampVisualValue,
  visualRanges,
} from '@opencut/shared';
import type { AnimatedProperty } from '@opencut/shared';
import { z } from 'zod';
import { timeSchema } from './time.js';

import { motionEasingSchema } from './motion-schema.js';

export function visualValueSchema(property: AnimatedProperty) {
  const [min, max] = visualRanges[property];
  return z.number().min(min).max(max);
}
const unit = z.number().min(0).max(1);
const visualKeyframeSchema = z.strictObject({
  time: timeSchema,
  value: z.number(),
  easing: motionEasingSchema,
  curve: z
    .tuple([unit, unit])
    .refine(([a, b]) => a < b, 'Curve bounds must increase.')
    .optional(),
  curveValue: z.number().optional(),
  curveAmplitude: z.number().min(-72000).max(72000).optional(),
});
const channel = (property: AnimatedProperty) =>
  z
    .array(
      visualKeyframeSchema
        .extend({ value: visualValueSchema(property) })
        .refine(
          ({ value, curveValue }) =>
            curveValue === undefined ||
            value === clampVisualValue(property, curveValue),
          {
            path: ['curveValue'],
            message: 'The curve sample must clamp to the keyframe value.',
          },
        ),
    )
    .min(1)
    .optional();
export const visualKeyframesSchema = z
  .strictObject({
    x: channel('x'),
    y: channel('y'),
    scale: channel('scale'),
    rotation: channel('rotation'),
    opacity: channel('opacity'),
  })
  .refine(
    (keyframes) => animatedProperties.some((property) => keyframes[property]),
    'Animation must have at least one keyframe.',
  );
