import { z } from 'zod';
import { compareTimes, subtractTimes, timeSchema } from './time.js';
import type { RationalTime } from './time.js';

const gain = z.number().finite().min(0).max(1);
export const trackAudioShape = {
  volume: gain.optional(),
  muted: z.boolean().optional(),
};
const fadeSchema = z.strictObject({
  duration: timeSchema.refine(
    (value) => value.numerator > 0,
    'Fade duration must be positive.',
  ),
  from: gain.optional(),
  to: gain.optional(),
});
export const clipAudioShape = {
  ...trackAudioShape,
  fadeIn: fadeSchema.optional(),
  fadeOut: fadeSchema.optional(),
};
export type AudioFade = z.infer<typeof fadeSchema>;
interface ClipFades {
  fadeIn?: AudioFade | undefined;
  fadeOut?: AudioFade | undefined;
}
export const audioFadeEdges = ['fadeIn', 'fadeOut'] as const;
export type AudioFadeEdge = (typeof audioFadeEdges)[number];
const zero: RationalTime = { numerator: 0, denominator: 1 };
const timeSeconds = (time: RationalTime) => time.numerator / time.denominator;

export function resolveAudioFade(edge: AudioFadeEdge, fade: AudioFade) {
  return {
    duration: fade.duration,
    from: fade.from ?? (edge === 'fadeIn' ? 0 : 1),
    to: fade.to ?? (edge === 'fadeIn' ? 1 : 0),
  };
}

function linearFadeGain(from: number, to: number, progress: number): number {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  return from + (to - from) * progress;
}

export function audioFadeGain(
  fades: ClipFades,
  duration: RationalTime,
  offset: RationalTime,
): number {
  if (fades.fadeIn && compareTimes(offset, fades.fadeIn.duration) <= 0) {
    const { from, to, duration } = resolveAudioFade('fadeIn', fades.fadeIn);
    return linearFadeGain(
      from,
      to,
      timeSeconds(offset) / timeSeconds(duration),
    );
  }
  if (fades.fadeOut) {
    const {
      from,
      to,
      duration: release,
    } = resolveAudioFade('fadeOut', fades.fadeOut);
    // The query and duration may both be representable while their difference
    // is too precise for the persisted rational format. Keep it in bigint
    // until converting the final interpolation ratio.
    const remaining =
      BigInt(duration.numerator) * BigInt(offset.denominator) -
      BigInt(offset.numerator) * BigInt(duration.denominator);
    const scale = BigInt(duration.denominator) * BigInt(offset.denominator);
    const progress =
      Number(remaining * BigInt(release.denominator)) /
      Number(scale * BigInt(release.numerator));
    return linearFadeGain(to, from, progress);
  }
  return 1;
}

export function baseAudioGain(clip: {
  volume: number;
  muted: boolean;
  trackVolume?: number | undefined;
  trackMuted?: boolean | undefined;
  audioPresence: 'present' | 'absent' | 'unknown';
}): number {
  return clip.muted || clip.trackMuted || clip.audioPresence === 'absent'
    ? 0
    : clip.volume * (clip.trackVolume ?? 1);
}

/** Keep only the part of each linear ramp intersecting a split piece. */
export function sliceAudioFades(
  fades: ClipFades,
  duration: RationalTime,
  start: RationalTime,
  end: RationalTime,
): ClipFades {
  const result: ClipFades = {};
  for (const edge of audioFadeEdges) {
    const fade = fades[edge];
    if (!fade) continue;
    const ramp = resolveAudioFade(edge, fade);
    const rampStart =
      edge === 'fadeIn' ? zero : subtractTimes(duration, ramp.duration);
    const rampEnd = edge === 'fadeIn' ? ramp.duration : duration;
    const first = compareTimes(start, rampStart) > 0 ? start : rampStart;
    const last = compareTimes(end, rampEnd) < 0 ? end : rampEnd;
    if (compareTimes(first, last) >= 0) continue;
    const gainAt = (time: RationalTime) =>
      linearFadeGain(
        ramp.from,
        ramp.to,
        timeSeconds(subtractTimes(time, rampStart)) /
          timeSeconds(ramp.duration),
      );
    const from =
      compareTimes(first, rampStart) === 0 ? fade.from : gainAt(first);
    const to = compareTimes(last, rampEnd) === 0 ? fade.to : gainAt(last);
    result[edge] = {
      duration: subtractTimes(last, first),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  }
  return result;
}
