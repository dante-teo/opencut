import { z } from 'zod';
import { compareTimes, timeSchema } from './time.js';
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

export type AudioFade = z.infer<typeof fadeSchema>;
interface ClipFades {
  fadeIn?: AudioFade | undefined;
  fadeOut?: AudioFade | undefined;
}
export const audioFadeEdges = ['fadeIn', 'fadeOut'] as const;
export type AudioFadeEdge = (typeof audioFadeEdges)[number];
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
