import type { VisualTransform } from './index.js';
import { ease, easingBounds, lerp } from './motion.js';
import type { MotionEasing, NamedEasing } from './motion.js';

export const animatedProperties = [
  'x',
  'y',
  'scale',
  'rotation',
  'opacity',
] as const;
export type AnimatedProperty = (typeof animatedProperties)[number];
export type KeyframeEasing = MotionEasing;
export interface KeyframeTime {
  numerator: number;
  denominator: number;
}
export interface VisualKeyframe {
  time: KeyframeTime;
  value: number;
  easing: KeyframeEasing;
  /** Subdomain of the outgoing easing curve retained by a split or trim. */
  curve?: [number, number] | undefined;
  /** Original value delta for trimming a nonmonotonic curve. */
  curveAmplitude?: number | undefined;
}
export type VisualKeyframes = Partial<
  Record<AnimatedProperty, VisualKeyframe[] | undefined>
>;
/** Clip-local animation bound to its exact start on the project timeline. */
export interface VisualAnimation {
  start: KeyframeTime;
  keyframes: VisualKeyframes;
}

export const visualDefaults = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
} as const;
export const visualRanges = {
  x: [-32768, 32768],
  y: [-32768, 32768],
  scale: [0.01, 4],
  rotation: [-36000, 36000],
  opacity: [0, 1],
} as const;

export function maximumVisualScale(
  visual: VisualTransform,
  keyframes?: VisualKeyframes,
) {
  const keys = keyframes?.scale;
  if (!keys?.length) return visual.scale ?? visualDefaults.scale;
  let maximum = keys[0]!.value;
  for (let i = 1; i < keys.length; i++) {
    const left = keys[i - 1]!;
    const right = keys[i]!;
    maximum = Math.max(maximum, right.value);
    if (typeof left.easing === 'string') continue;
    const [start, end] = left.curve ?? [0, 1];
    const from = ease(start, left.easing);
    const to = ease(end, left.easing);
    const [lo, hi] = easingBounds(left.easing);
    const delta = right.value - left.value;
    const amplitude =
      left.curveAmplitude ?? (to === from ? 0 : delta / (to - from));
    // Bound the eased and affine terms independently. Full-range keys
    // cancel the affine term so ordinary springs get a tighter bound.
    const affineStart = left.value - amplitude * from;
    const affineEnd = right.value - amplitude * to;
    maximum = Math.max(
      maximum,
      Math.max(affineStart, affineEnd) +
        Math.max(lo * amplitude, hi * amplitude),
    );
  }
  return Math.min(visualRanges.scale[1], maximum);
}

/** Rotation and keyframes need a transformable layer rather than a baked placement. */
export function usesLayerTransform(
  rotation: number | undefined,
  animated: boolean,
) {
  return animated || !!rotation;
}

const zero = { numerator: 0, denominator: 1 };
function difference(a: KeyframeTime, b: KeyframeTime) {
  return {
    n:
      BigInt(a.numerator) * BigInt(b.denominator) -
      BigInt(b.numerator) * BigInt(a.denominator),
    d: BigInt(a.denominator) * BigInt(b.denominator),
  };
}

/** Sample a normalized subdomain without cancellation near flat endpoints. */
function easingProgress(
  easing: NamedEasing,
  t: number,
  [a, b]: [number, number],
): number {
  if (easing === 'linear') return t;
  if (easing === 'ease-in')
    return t * ((2 * a) / (a + b) + ((b - a) / (a + b)) * t);
  if (easing === 'ease-out') {
    const remaining = 1 - a + (1 - b);
    return t * ((2 * (1 - a)) / remaining - ((b - a) / remaining) * t);
  }
  if (b <= 0.5) return easingProgress('ease-in', t, [a, b]);
  if (a >= 0.5) return easingProgress('ease-out', t, [a, b]);
  const turn = 0.5 - a;
  const progress = (distance: number) => {
    if (distance <= turn) return distance * (2 * a + distance);
    const afterTurn = distance - turn;
    return turn * (0.5 + a) + afterTurn * (1 - afterTurn);
  };
  return progress((b - a) * t) / progress(b - a);
}

export function keyframeProgress(
  time: KeyframeTime,
  from: KeyframeTime,
  to: KeyframeTime,
) {
  const elapsed = difference(time, from);
  const span = difference(to, from);
  return Number(elapsed.n * span.d) / Number(elapsed.d * span.n);
}

export function sampleKeyframes(
  keys: readonly VisualKeyframe[],
  time: KeyframeTime,
  start: KeyframeTime = zero,
): number {
  const offset = difference(time, start);
  const relative = (key: KeyframeTime) =>
    offset.n * BigInt(key.denominator) - BigInt(key.numerator) * offset.d;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (relative(keys[mid]!.time) >= 0n) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return keys[0]!.value;
  const left = keys[lo - 1]!;
  const right = keys[lo];
  if (!right) return left.value;
  const span = difference(right.time, left.time);
  const t =
    Number(relative(left.time) * BigInt(right.time.denominator)) /
    Number(offset.d * span.n);
  if (typeof left.easing !== 'string') {
    const [from, to] = left.curve ?? [0, 1];
    const a = ease(from, left.easing);
    const b = ease(to, left.easing);
    const progress = ease(lerp(from, to, t), left.easing);
    const amplitude = left.curveAmplitude;
    if (amplitude !== undefined)
      return (
        lerp(left.value, right.value, t) +
        amplitude * (progress - lerp(a, b, t))
      );
    return lerp(
      left.value,
      right.value,
      a === b ? t : (progress - a) / (b - a),
    );
  }
  if (left.value === right.value) return left.value;
  const progress = easingProgress(left.easing, t, left.curve ?? [0, 1]);
  const value = left.value + (right.value - left.value) * progress;
  return Math.max(
    Math.min(left.value, right.value),
    Math.min(Math.max(left.value, right.value), value),
  );
}

/** Both compositors call this sampler using the same exact project clock. */
export function evaluateVisual<T extends VisualTransform>(
  visual: T,
  keyframes: VisualKeyframes | undefined,
  time: KeyframeTime,
  start?: KeyframeTime,
): T {
  if (!keyframes) return visual;
  const result = { ...visual };
  for (const property of animatedProperties) {
    const keys = keyframes[property];
    if (keys?.length) {
      const [min, max] = visualRanges[property];
      result[property] = Math.max(
        min,
        Math.min(max, sampleKeyframes(keys, time, start)),
      );
    }
  }
  return result;
}
