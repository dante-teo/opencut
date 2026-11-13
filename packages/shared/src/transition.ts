export interface TransitionRamp {
  startFrame: number;
  endFrame: number;
  direction: 'in' | 'out';
}

/** Both endpoints are sampled: the last frame of the half-open window is fully resolved. */
export function transitionOpacity(frame: number, ramp: TransitionRamp) {
  const progress = Math.max(
    0,
    Math.min(
      1,
      (frame - ramp.startFrame) / (ramp.endFrame - ramp.startFrame - 1),
    ),
  );
  return ramp.direction === 'in' ? progress : 1 - progress;
}
