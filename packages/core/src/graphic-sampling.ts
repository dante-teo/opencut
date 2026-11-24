import type { GraphicLayer, VisualTimelineClip } from '@opencut/media';
import { clipSourceTime, sampleClipSourceFrame } from './clip-timing.js';
import { compareTimes, frameTime, rationalTime } from './time.js';
import type { FrameRate, RationalTime } from './time.js';

type GraphicClip = Extract<VisualTimelineClip, { path: string }> & {
  graphic: GraphicLayer;
};

export function graphicFrameSamples(
  clip: GraphicClip,
  frame: number,
  rate: FrameRate,
): (number | RationalTime)[] {
  const { graphic, retiming, sourceStartFrame, timelineStartFrame } = clip;
  if (graphic.durationFrames === undefined) return [0];
  const local = sourceStartFrame + frame - timelineStartFrame;
  if (graphic.sampling !== 'exact')
    return [retiming ? sampleClipSourceFrame(retiming, frame, rate) : local];
  const time = frameTime(frame, rate);
  const origin = retiming?.timelineStart ?? frameTime(timelineStartFrame, rate);
  const end =
    retiming?.timelineEnd ??
    frameTime(timelineStartFrame + clip.frameCount, rate);
  const mapping = retiming ?? {
    timelineStart: origin,
    sourceIn: frameTime(sourceStartFrame, rate),
    sourceOut: frameTime(sourceStartFrame + clip.frameCount, rate),
  };
  const blur = graphic.motionBlur;
  if (!blur) return [clipSourceTime(mapping, time)];
  const divisor = BigInt(720 * blur.samples);
  const center = BigInt(frame) * divisor;
  const denominator = divisor * BigInt(rate.numerator);
  const projectScale = BigInt(rate.denominator);
  const samples: RationalTime[] = [];
  for (let i = 0; i < blur.samples; i++) {
    const tick =
      center + BigInt((2 * i + 1 - blur.samples) * blur.shutterAngle);
    if (tick < 0n) continue;
    const subframe = rationalTime(tick * projectScale, denominator);
    // Shorten the exposure at a cut so it never reads across the placement.
    if (compareTimes(subframe, origin) < 0 || compareTimes(subframe, end) >= 0)
      continue;
    samples.push(clipSourceTime(mapping, subframe));
  }
  return samples.length ? samples : [clipSourceTime(mapping, time)];
}

/** Reuse only when the entire shutter exposure lies inside one declared hold. */
export function declaredGraphicHold(
  graphic: GraphicLayer,
  samples: readonly (number | RationalTime)[],
  rate: FrameRate,
) {
  if (!graphic.staticRanges || graphic.audioAnalysis || graphic.mediaFrames)
    return;
  return graphic.staticRanges.find(({ startFrame, endFrame }) =>
    samples.every((sample) =>
      typeof sample === 'number'
        ? sample >= startFrame && sample < endFrame
        : compareTimes(sample, frameTime(startFrame, rate)) >= 0 &&
          compareTimes(sample, frameTime(endFrame, rate)) < 0,
    ),
  );
}
