import {
  animatedProperties,
  keyframeEasings,
  keyframeProgress,
  sampleKeyframes,
  visualRanges,
} from '@opencut/shared';
import type {
  AnimatedProperty,
  VisualKeyframe,
  VisualKeyframes,
} from '@opencut/shared';
import { z } from 'zod';
import {
  addTimes,
  compareTimes,
  rationalTime,
  subtractTimes,
  timeSchema,
} from './time.js';
import type { RationalTime } from './time.js';
import { clipDuration, clipSpeed } from './clip-timing.js';
import type { TimelineClip } from './project.js';

const propertySchema = z.enum(animatedProperties);
const easingSchema = z.enum(keyframeEasings);
const target = { property: propertySchema, time: timeSchema };
export const keyframeEdits = {
  add: z.strictObject({
    type: z.literal('clip.keyframe.add'),
    ...target,
    value: z.number(),
    easing: easingSchema.optional(),
  }),
  set: z.strictObject({
    type: z.literal('clip.keyframe.set'),
    ...target,
    newTime: timeSchema.optional(),
    value: z.number().optional(),
    easing: easingSchema.optional(),
  }),
  remove: z.strictObject({
    type: z.literal('clip.keyframe.remove'),
    ...target,
  }),
};
export type KeyframeEdit = z.infer<
  (typeof keyframeEdits)[keyof typeof keyframeEdits]
>;

export function visualValueSchema(property: AnimatedProperty) {
  const [min, max] = visualRanges[property];
  return z.number().min(min).max(max);
}
const unit = z.number().min(0).max(1);
const visualKeyframeSchema = z.strictObject({
  time: timeSchema,
  value: z.number(),
  easing: easingSchema,
  curve: z
    .tuple([unit, unit])
    .refine(([a, b]) => a < b, 'Curve bounds must increase.')
    .optional(),
});
const channel = (property: AnimatedProperty) =>
  z
    .array(visualKeyframeSchema.extend({ value: visualValueSchema(property) }))
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

const zero = { numerator: 0, denominator: 1 };

function rescaleTime(time: RationalTime, from: RationalTime, to: RationalTime) {
  return rationalTime(
    BigInt(time.numerator) * BigInt(from.numerator) * BigInt(to.denominator),
    BigInt(time.denominator) * BigInt(from.denominator) * BigInt(to.numerator),
  );
}

function mapChannels(
  keyframes: VisualKeyframes,
  map: (keys: VisualKeyframe[]) => VisualKeyframe[],
): VisualKeyframes {
  const result: VisualKeyframes = {};
  for (const property of animatedProperties) {
    const keys = keyframes[property];
    if (keys) result[property] = map(keys);
  }
  return result;
}

export function retimeKeyframes(previous: TimelineClip, clip: TimelineClip) {
  if (!previous.keyframes) return;
  const from = clipSpeed(previous);
  const to = clipSpeed(clip);
  clip.keyframes = mapChannels(previous.keyframes, (keys) =>
    keys.map((key) => ({
      ...key,
      time: rescaleTime(key.time, from, to),
    })),
  );
}

function restrictKeys(
  keys: VisualKeyframe[],
  start: RationalTime,
  end: RationalTime,
) {
  const first = keys[0]!.time;
  const last = keys.at(-1)!.time;
  const boundary = (time: RationalTime): VisualKeyframe => ({
    time,
    value: sampleKeyframes(keys, time),
    easing: 'linear',
  });
  if (compareTimes(end, first) < 0 || compareTimes(start, last) > 0)
    return [boundary(start)];

  const slice = keys.filter(
    ({ time }) =>
      compareTimes(time, start) >= 0 && compareTimes(time, end) <= 0,
  );
  if (
    compareTimes(start, first) > 0 &&
    (!slice[0] || compareTimes(slice[0].time, start) > 0)
  )
    slice.unshift(boundary(start));
  if (compareTimes(end, last) < 0 && compareTimes(slice.at(-1)!.time, end) < 0)
    slice.push(boundary(end));

  let right = 0;
  return slice.map((key, i): VisualKeyframe => {
    const next = slice[i + 1];
    if (!next) return key;
    while (
      right < keys.length &&
      compareTimes(keys[right]!.time, key.time) <= 0
    )
      right++;
    const left = keys[right - 1];
    const upper = keys[right];
    if (!left || !upper || left.easing === 'linear') return key;
    if (
      compareTimes(left.time, key.time) === 0 &&
      compareTimes(upper.time, next.time) === 0
    )
      return key;
    const [a, b] = left.curve ?? [0, 1];
    const at = (time: RationalTime) =>
      a + (b - a) * keyframeProgress(time, left.time, upper.time);
    const from = at(key.time);
    const to = at(next.time);
    if (from >= to)
      return { time: key.time, value: key.value, easing: 'linear' };
    return { ...key, easing: left.easing, curve: [from, to] };
  });
}

/** Keep the curve attached to surviving source content at the unchanged clip speed. */
export function trimKeyframes(previous: TimelineClip, clip: TimelineClip) {
  if (!previous.keyframes || compareTimes(clip.sourceOut, clip.sourceIn) <= 0)
    return;
  const offset = (sourceOut: RationalTime, sourceIn: RationalTime) =>
    clipDuration({ ...clip, sourceIn, sourceOut });
  const startOrder = compareTimes(clip.sourceIn, previous.sourceIn);
  const laterStart = startOrder > 0;
  const earlierEnd = compareTimes(clip.sourceOut, previous.sourceOut) < 0;
  const before = compareTimes(clip.sourceOut, previous.sourceIn) <= 0;
  const after = compareTimes(clip.sourceIn, previous.sourceOut) >= 0;
  if (before || after) {
    const edge = before ? zero : clipDuration(previous);
    clip.keyframes = mapChannels(previous.keyframes, (keys) => [
      { time: zero, value: sampleKeyframes(keys, edge), easing: 'linear' },
    ]);
    return;
  }

  const start = laterStart ? offset(clip.sourceIn, previous.sourceIn) : zero;
  const end = earlierEnd
    ? offset(clip.sourceOut, previous.sourceIn)
    : clipDuration(previous);
  const extension =
    startOrder < 0 ? offset(previous.sourceIn, clip.sourceIn) : zero;
  clip.keyframes = mapChannels(previous.keyframes, (keys) => {
    const surviving =
      laterStart || earlierEnd ? restrictKeys(keys, start, end) : keys;
    return surviving.map((key) => ({
      ...key,
      time: laterStart
        ? subtractTimes(key.time, start)
        : addTimes(key.time, extension),
    }));
  });
}
