import type { VisualTransform } from './index.js';

export const animatedProperties = [
  'x',
  'y',
  'scale',
  'rotation',
  'opacity',
] as const;
export const keyframeEasings = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
] as const;
export type AnimatedProperty = (typeof animatedProperties)[number];
export type KeyframeEasing = (typeof keyframeEasings)[number];
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

/** The supported easings stay between their endpoints. */
export function maximumVisualScale(
  visual: VisualTransform,
  keyframes?: VisualKeyframes,
) {
  return (
    keyframes?.scale?.reduce((max, key) => Math.max(max, key.value), 0) ??
    visual.scale ??
    visualDefaults.scale
  );
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
  easing: KeyframeEasing,
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
  if (!right || left.value === right.value) return left.value;
  const span = difference(right.time, left.time);
  const t =
    Number(relative(left.time) * BigInt(right.time.denominator)) /
    Number(offset.d * span.n);
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
    if (keys?.length) result[property] = sampleKeyframes(keys, time, start);
  }
  return result;
}
