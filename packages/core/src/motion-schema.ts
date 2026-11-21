import { keyframeEasings } from '@opencut/shared';
import { z } from 'zod';

const unit = z.number().min(0).max(1);
const bezierY = z.number().min(-4).max(4);

export const motionEasingSchema = z.union([
  z.enum(keyframeEasings),
  z.strictObject({
    type: z.literal('cubic-bezier'),
    x1: unit,
    y1: bezierY,
    x2: unit,
    y2: bezierY,
  }),
  z.strictObject({
    type: z.literal('spring'),
    mass: z.number().min(0.05).max(100),
    stiffness: z.number().min(1).max(10_000),
    damping: z.number().min(0).max(1000),
    duration: z.number().min(0.01).max(60),
  }),
]);

const extrapolation = z.enum(['clamp', 'extend', 'identity']);

export function motionChannelSchema(value: z.ZodNumber) {
  const time = z.number().min(0).max(1_000_000);
  return z.strictObject({
    keys: z
      .array(
        z.strictObject({
          at: time,
          value,
          easing: motionEasingSchema.optional(),
        }),
      )
      .min(1)
      .max(128)
      .refine(
        (keys) => keys.every((key, i) => i === 0 || keys[i - 1]!.at < key.at),
        'Keyframe times must strictly increase.',
      ),
    delay: time.optional(),
    speed: z
      .number()
      .min(1 / 64)
      .max(64)
      .optional(),
    cycle: z
      .strictObject({
        mode: z.enum(['loop', 'ping-pong']),
        duration: time.min(1 / 1024),
      })
      .optional(),
    before: extrapolation.optional(),
    after: extrapolation.optional(),
  });
}
