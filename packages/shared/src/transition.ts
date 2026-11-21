import { ease } from './motion.js';
import type { MotionEasing } from './motion.js';

export type TransitionStyle =
  | { kind: 'dip-to-color'; color: string }
  | {
      kind: 'wipe' | 'push' | 'slide';
      direction: 'left' | 'right' | 'up' | 'down';
      easing?: Extract<MotionEasing, { type: 'cubic-bezier' }> | undefined;
    }
  | { kind: 'zoom'; amount: number }
  | { kind: 'blur'; radius: number };

export interface TransitionRamp {
  startFrame: number;
  endFrame: number;
  direction: 'in' | 'out';
  style?: TransitionStyle | undefined;
}

/** Both endpoints are sampled: the last frame of the half-open window is fully resolved. */
export function transitionProgress(frame: number, ramp: TransitionRamp) {
  const progress = Math.max(
    0,
    Math.min(
      1,
      (frame - ramp.startFrame) / (ramp.endFrame - ramp.startFrame - 1),
    ),
  );
  const style = ramp.style;
  return style && 'easing' in style ? ease(progress, style.easing) : progress;
}

export function transitionOpacity(frame: number, ramp: TransitionRamp) {
  const progress = transitionProgress(frame, ramp);
  return ramp.direction === 'in' ? progress : 1 - progress;
}
