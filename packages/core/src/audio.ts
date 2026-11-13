import { z } from 'zod';
import { addTimes, compareTimes, subtractTimes, timeSchema } from './time.js';
import type { RationalTime } from './time.js';

const gain = z.number().finite().min(0).max(1);
export const audioEffectSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('eq'),
    frequency: z.number().min(40).max(16000),
    db: z.number().min(-18).max(18),
  }),
  z.strictObject({
    type: z.literal('compressor'),
    threshold: z.number().min(-50).max(-1),
    ratio: z.number().min(1).max(20),
  }),
  z.strictObject({
    type: z.literal('limiter'),
    ceiling: z.number().min(-20).max(-1),
  }),
  z.strictObject({
    type: z.literal('de-esser'),
    amount: z.number().min(0).max(1),
  }),
  z.strictObject({
    type: z.literal('reverb'),
    mix: z.number().min(0).max(0.5),
  }),
]);
export type AudioEffect = z.infer<typeof audioEffectSchema>;
export const audioEffectsSchema = z.array(audioEffectSchema).max(12);
export const audioPresets = {
  Dialogue: [
    { type: 'eq', frequency: 300, db: -3 },
    { type: 'de-esser', amount: 0.4 },
    { type: 'compressor', threshold: -18, ratio: 3 },
    { type: 'limiter', ceiling: -2 },
  ],
  Room: [{ type: 'reverb', mix: 0.16 }],
} satisfies Record<string, AudioEffect[]>;
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
  effects: audioEffectsSchema.optional(),
  gainKeys: z
    .array(z.strictObject({ time: timeSchema, value: gain }))
    .min(1)
    .max(128)
    .refine(
      (keys) =>
        keys.every(
          (key, i) => i === 0 || compareTimes(keys[i - 1]!.time, key.time) < 0,
        ),
      'Volume key times must increase.',
    )
    .optional(),
};
export type GainKeys = NonNullable<z.infer<typeof clipAudioShape.gainKeys>>;
export function keyframeGain(keys: GainKeys, time: RationalTime): number {
  const i = keys.findIndex((key) => compareTimes(key.time, time) >= 0);
  if (i < 0) return keys.at(-1)!.value;
  const right = keys[i]!;
  if (i === 0 || compareTimes(right.time, time) === 0) return right.value;
  const left = keys[i - 1]!;
  const ratio =
    (timeSeconds(time) - timeSeconds(left.time)) /
    (timeSeconds(right.time) - timeSeconds(left.time));
  return linearFadeGain(left.value, right.value, ratio);
}

export function sliceGainKeys(
  keys: GainKeys,
  start: RationalTime,
  end: RationalTime,
): GainKeys {
  const sliced = keys
    .filter(
      (key) =>
        compareTimes(key.time, start) >= 0 && compareTimes(key.time, end) <= 0,
    )
    .map((key) => ({ ...key, time: subtractTimes(key.time, start) }));
  const duration = subtractTimes(end, start);
  const first = keys[0]!.time;
  const last = keys.at(-1)!.time;
  const insideCurve = (time: RationalTime) =>
    compareTimes(time, first) > 0 && compareTimes(time, last) < 0;
  if (
    insideCurve(end) &&
    (!sliced.length || compareTimes(sliced.at(-1)!.time, duration) < 0)
  )
    sliced.push({ time: duration, value: keyframeGain(keys, end) });
  if (insideCurve(start) && sliced[0]?.time.numerator !== 0)
    sliced.unshift({ time: zero, value: keyframeGain(keys, start) });
  return sliced.length
    ? sliced
    : [{ time: zero, value: keyframeGain(keys, start) }];
}

export function shiftGainKeys(keys: GainKeys, shift: RationalTime): GainKeys {
  return keys.map((key) => ({ ...key, time: addTimes(key.time, shift) }));
}
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
