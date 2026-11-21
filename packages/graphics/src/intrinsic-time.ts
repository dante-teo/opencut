import type { GraphicTiming } from './react.js';

export type IntrinsicRange = 'hold' | 'loop' | 'error';

export function exactSeconds(timing: GraphicTiming) {
  const position = timing.exactSourceTime;
  if (!position)
    throw new Error('This graphics adapter requires exact source time.');
  return position.numerator / position.denominator;
}

export function intrinsicTime(
  seconds: number,
  duration: number,
  range: IntrinsicRange,
) {
  if (seconds >= 0 && seconds < duration) return seconds;
  if (range === 'error')
    throw new Error(
      `Intrinsic sample ${seconds}s is outside [0, ${duration}s).`,
    );
  return range === 'loop'
    ? ((seconds % duration) + duration) % duration
    : Math.max(0, Math.min(duration, seconds));
}
