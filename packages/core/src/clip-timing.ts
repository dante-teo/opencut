import type { z } from 'zod';
import {
  addTimes,
  compareTimes,
  frameRateSchema,
  rationalTime,
} from './time.js';
import type { RationalTime } from './time.js';

export const clipSpeedSchema = frameRateSchema.refine(
  (speed) =>
    compareTimes(speed, { numerator: 1, denominator: 4 }) >= 0 &&
    compareTimes(speed, { numerator: 4, denominator: 1 }) <= 0,
  'Clip speed must be between 0.25× and 4×.',
);
export type ClipSpeed = z.infer<typeof clipSpeedSchema>;

const normalSpeed: Readonly<ClipSpeed> = Object.freeze({
  numerator: 1,
  denominator: 1,
});

interface ClipTiming {
  timelineStart: RationalTime;
  sourceIn: RationalTime;
  sourceOut: RationalTime;
  speed?: ClipSpeed | undefined;
}

export function clipSpeed(
  clip: Pick<ClipTiming, 'speed'>,
): Readonly<ClipSpeed> {
  return clip.speed ?? normalSpeed;
}

const zero = { numerator: 0, denominator: 1 };

/** Keep intermediate clock arithmetic exact even when it exceeds JSON precision. */
function mapPosition(
  time: RationalTime,
  from: RationalTime,
  to: RationalTime,
  rate: ClipSpeed,
) {
  const timeDenominator = BigInt(time.denominator);
  const fromDenominator = BigInt(from.denominator);
  const toDenominator = BigInt(to.denominator);
  const offsetDenominator =
    timeDenominator * fromDenominator * BigInt(rate.denominator);
  return {
    numerator:
      (BigInt(time.numerator) * fromDenominator -
        BigInt(from.numerator) * timeDenominator) *
        BigInt(rate.numerator) *
        toDenominator +
      BigInt(to.numerator) * offsetDenominator,
    denominator: offsetDenominator * toDenominator,
  };
}

export function clipDuration(clip: ClipTiming): RationalTime {
  const { numerator, denominator } = clipSpeed(clip);
  const duration = mapPosition(clip.sourceOut, clip.sourceIn, zero, {
    numerator: denominator,
    denominator: numerator,
  });
  return rationalTime(duration.numerator, duration.denominator);
}

export function clipTimelineEnd(clip: ClipTiming): RationalTime {
  return addTimes(clip.timelineStart, clipDuration(clip));
}

export function clipSourcePosition(
  clip: ClipTiming,
  timelineTime: RationalTime,
) {
  return mapPosition(
    timelineTime,
    clip.timelineStart,
    clip.sourceIn,
    clipSpeed(clip),
  );
}

export function clipSourceTime(
  clip: ClipTiming,
  timelineTime: RationalTime,
): RationalTime {
  const { numerator, denominator } = clipSourcePosition(clip, timelineTime);
  return rationalTime(numerator, denominator);
}

/** Device sampling can approximate positions too precise for a JSON fraction. */
export function sampleClipSourceTime(
  clip: ClipTiming,
  timelineTime: RationalTime,
): RationalTime {
  const { numerator, denominator } = clipSourcePosition(clip, timelineTime);
  try {
    return rationalTime(numerator, denominator);
  } catch (error) {
    if (!(error instanceof RangeError) || numerator < 0n) throw error;
    const limit =
      BigInt(Number.MAX_SAFE_INTEGER) / (numerator / denominator + 1n);
    const scale = limit < 1_000_000_000n ? limit || 1n : 1_000_000_000n;
    return rationalTime(
      (2n * numerator * scale + denominator) / (2n * denominator),
      scale,
    );
  }
}

/** Parse a decimal multiplier or a numerator/denominator ratio without floating-point rounding. */
export function parseClipSpeed(value: string): ClipSpeed {
  const input = value.trim();
  const ratio = /^(\d+)\/(\d+)$/.exec(input);
  const decimal = /^(\d*)(?:\.(\d+))?$/.exec(input);
  const fraction = decimal?.[2] ?? '';
  if (input.length > 64 || (!ratio && (!decimal || (!decimal[1] && !fraction))))
    throw new RangeError(
      'Enter a speed between 0.25 and 4 as a decimal or ratio.',
    );
  const numerator = BigInt(ratio ? ratio[1]! : decimal![1] + fraction);
  const denominator = ratio
    ? BigInt(ratio[2]!)
    : 10n ** BigInt(fraction.length);
  if (
    denominator === 0n ||
    numerator * 4n < denominator ||
    numerator > denominator * 4n
  )
    throw new RangeError('Clip speed must be between 0.25× and 4×.');
  return rationalTime(numerator, denominator);
}
