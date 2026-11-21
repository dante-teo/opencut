export const keyframeEasings = [
  'linear',
  'ease-in',
  'ease-out',
  'ease-in-out',
] as const;

export type NamedEasing = (typeof keyframeEasings)[number];

export type MotionEasing =
  | NamedEasing
  | { type: 'cubic-bezier'; x1: number; y1: number; x2: number; y2: number }
  | {
      type: 'spring';
      mass: number;
      stiffness: number;
      damping: number;
      duration: number;
    };

export type Extrapolation = 'clamp' | 'extend' | 'identity';

export interface MotionKeyframe {
  at: number;
  value: number;
  easing?: MotionEasing | undefined;
}

export interface MotionCycle {
  mode: 'loop' | 'ping-pong';
  duration: number;
}

export interface MotionChannel {
  keys: readonly MotionKeyframe[];
  delay?: number | undefined;
  speed?: number | undefined;
  cycle?: MotionCycle | undefined;
  before?: Extrapolation | undefined;
  after?: Extrapolation | undefined;
}

const unit = (value: number) => Math.max(0, Math.min(1, value));

export function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function cubic(a: number, b: number, t: number) {
  return t * (3 * (1 - t) * ((1 - t) * a + t * b) + t * t);
}

function bezierProgress(
  { x1, x2, y1, y2 }: Extract<MotionEasing, { type: 'cubic-bezier' }>,
  t: number,
) {
  let lo = 0;
  let hi = 1;
  // A bounded bisection also handles a flat derivative on the x curve.
  for (let iteration = 0; iteration < 30; iteration++) {
    const mid = (lo + hi) / 2;
    if (cubic(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return cubic(y1, y2, (lo + hi) / 2);
}

type Spring = Extract<MotionEasing, { type: 'spring' }>;

function springProgress({ mass, stiffness, damping }: Spring, seconds: number) {
  const natural = Math.sqrt(stiffness / mass);
  const decay = damping / (2 * mass);
  const ratio = decay / natural;
  if (Math.abs(ratio - 1) < 1e-7) {
    const t = natural * seconds;
    return -Math.expm1(-t) - t * Math.exp(-t);
  }
  if (ratio < 1) {
    const frequency = natural * Math.sqrt(1 - ratio ** 2);
    const t = frequency * seconds;
    return (
      1 -
      Math.exp(-decay * seconds) *
        (Math.cos(t) + (decay * Math.sin(t)) / frequency)
    );
  }
  const root = Math.sqrt(decay ** 2 - natural ** 2);
  const fast = -decay - root;
  const slow = natural ** 2 / fast;
  return (
    1 -
    (fast * Math.exp(slow * seconds) - slow * Math.exp(fast * seconds)) /
      (fast - slow)
  );
}

/** Easing in normalized segment time. Spring motion starts at rest. */
export function ease(t: number, easing: MotionEasing = 'linear'): number {
  if (t <= 0 || t >= 1) return unit(t);
  switch (easing) {
    case 'linear':
      return t;
    case 'ease-in':
      return t ** 2;
    case 'ease-out':
      return 1 - (1 - t) ** 2;
    case 'ease-in-out':
      return t < 0.5 ? 2 * t ** 2 : 1 - 2 * (1 - t) ** 2;
  }
  if (easing.type === 'cubic-bezier') return bezierProgress(easing, t);
  const end = springProgress(easing, easing.duration);
  // Spread the finite-horizon correction over the segment so the last key
  // is exact without clamping interior overshoot or jumping at the seam.
  return springProgress(easing, easing.duration * t) + (1 - end) * t;
}

export function easingBounds(easing: MotionEasing): [number, number] {
  if (typeof easing === 'string') return [0, 1];
  if (easing.type === 'cubic-bezier')
    return [
      Math.min(0, easing.y1, easing.y2),
      Math.max(1, easing.y1, easing.y2),
    ];
  const ratio =
    easing.damping / (2 * Math.sqrt(easing.mass * easing.stiffness));
  const peak =
    ratio < 1
      ? 1 + Math.exp((-Math.PI * ratio) / Math.sqrt(1 - ratio ** 2))
      : 1;
  const correction = 1 - springProgress(easing, easing.duration);
  return [Math.min(0, correction), peak + Math.max(0, correction)];
}

export function interpolate(
  input: number,
  [start, end]: readonly [number, number],
  [from, to]: readonly [number, number],
  {
    easing = 'linear',
    before = 'clamp',
    after = 'clamp',
  }: {
    easing?: MotionEasing | undefined;
    before?: Extrapolation | undefined;
    after?: Extrapolation | undefined;
  } = {},
) {
  if (!(end > start))
    throw new RangeError('Interpolation input range must increase.');
  const progress = (input - start) / (end - start);
  if (progress >= 0 && progress <= 1)
    return lerp(from, to, ease(progress, easing));
  const mode = progress < 0 ? before : after;
  if (mode === 'identity') return input;
  if (mode === 'extend') return lerp(from, to, progress);
  return progress < 0 ? from : to;
}

/** Repeat or reflect time with an exact origin and a well-defined loop seam. */
export function cycleTime(time: number, { mode, duration }: MotionCycle) {
  if (!(duration > 0)) throw new RangeError('Cycle duration must be positive.');
  const period = mode === 'loop' ? duration : duration * 2;
  const phase = ((time % period) + period) % period;
  return phase <= duration ? phase : period - phase;
}

/** A sequence interval is start-inclusive and end-exclusive. */
export function sequenceTime(time: number, start: number, duration: number) {
  const local = time - start;
  return local >= 0 && local < duration ? local : undefined;
}

export function staggerTime(time: number, index: number, interval: number) {
  return time - index * interval;
}

/** Evaluate a previously validated, strictly ordered, nonempty key list. */
export function sampleMotion(channel: MotionChannel, time: number) {
  const { keys, delay = 0, speed = 1, cycle, before, after } = channel;
  let sample = (time - delay) * speed;
  if (cycle) sample = cycleTime(Math.max(0, sample), cycle);
  if (keys.length === 1) return keys[0]!.value;
  let lo = 1;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sample > keys[mid]!.at) lo = mid + 1;
    else hi = mid;
  }
  const left = keys[lo - 1]!;
  const right = keys[lo]!;
  return interpolate(sample, [left.at, right.at], [left.value, right.value], {
    easing: left.easing,
    before,
    after,
  });
}

export function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number) {
  return value <= 0.0031308
    ? value * 12.92
    : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Blend #RRGGBB and #RRGGBBAA in premultiplied linear-light sRGB. */
export function interpolateColor(from: string, to: string, progress: number) {
  const channels = (color: string) => {
    if (!/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color))
      throw new TypeError('Expected #RRGGBB or #RRGGBBAA.');
    return [1, 3, 5, 7].map((offset) =>
      offset < color.length
        ? parseInt(color.slice(offset, offset + 2), 16) / 255
        : 1,
    );
  };
  const a = channels(from);
  const b = channels(to);
  const t = unit(progress);
  const alpha = lerp(a[3]!, b[3]!, t);
  const hex = (value: number) =>
    Math.round(unit(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return (
    '#' +
    a
      .slice(0, 3)
      .map((value, i) =>
        hex(
          alpha === 0
            ? 0
            : linearToSrgb(
                lerp(
                  srgbToLinear(value) * a[3]!,
                  srgbToLinear(b[i]!) * b[3]!,
                  t,
                ) / alpha,
              ),
        ),
      )
      .join('') +
    hex(alpha)
  );
}

/** Stateless variation keyed by a seed and a stable item ID. */
export function seededVariation(seed: number, id: string) {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 0x100000000;
}
