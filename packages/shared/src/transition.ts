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

/** Spatial placement and visible region of one fitted composition layer. */
export function transitionLayerGeometry(
  progress: number,
  ramp: TransitionRamp,
  width: number,
  height: number,
) {
  const style = ramp.style;
  const incoming = ramp.direction === 'in';
  let x = 0;
  let y = 0;
  let scale = 1;
  let alpha = incoming ? progress : 1 - progress;
  let clip = { left: 0, top: 0, right: width, bottom: height };
  if (style?.kind === 'zoom')
    scale += style.amount * (incoming ? 1 - progress : progress);
  if (style?.kind === 'dip-to-color') alpha = Math.max(0, 2 * alpha - 1);
  if (
    style?.kind === 'push' ||
    style?.kind === 'slide' ||
    style?.kind === 'wipe'
  ) {
    const horizontal =
      style.direction === 'left' || style.direction === 'right';
    const positive = style.direction === 'right' || style.direction === 'down';
    if (style.kind === 'push' || (style.kind === 'slide' && incoming)) {
      const distance =
        (positive ? 1 : -1) * (incoming ? progress - 1 : progress);
      x = horizontal ? width * distance : 0;
      y = horizontal ? 0 : height * distance;
      alpha = 1;
    } else {
      const size = horizontal ? width : height;
      const edge = Math.round(size * progress);
      const boundary = positive ? edge : size - edge;
      const takeFirst = positive === incoming;
      clip = horizontal
        ? {
            left: takeFirst ? 0 : boundary,
            top: 0,
            right: takeFirst ? boundary : width,
            bottom: height,
          }
        : {
            left: 0,
            top: takeFirst ? 0 : boundary,
            right: width,
            bottom: takeFirst ? boundary : height,
          };
      alpha = clip.right > clip.left && clip.bottom > clip.top ? 1 : 0;
    }
  }
  return { x, y, scale, alpha, clip };
}
