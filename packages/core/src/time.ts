import { z } from 'zod';

const natural = z.int().nonnegative();
const positive = z.int().positive();

/** Exact seconds. Components must be safe JSON integers; fractions need not be reduced. */
export const timeSchema = z.strictObject({
  numerator: natural,
  denominator: positive,
});

export const frameRateSchema = z.strictObject({
  numerator: positive,
  denominator: positive,
});

export type RationalTime = z.infer<typeof timeSchema>;
export type FrameRate = z.infer<typeof frameRateSchema>;

/** Cross-multiply with bigint so even large safe-integer components compare exactly. */
export function compareTimes(a: RationalTime, b: RationalTime): -1 | 0 | 1 {
  timeSchema.parse(a);
  timeSchema.parse(b);
  const left = BigInt(a.numerator) * BigInt(b.denominator);
  const right = BigInt(b.numerator) * BigInt(a.denominator);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Zero-based frame boundary in seconds, including fractional rates such as 30000/1001. */
export function frameTime(frame: number, rate: FrameRate): RationalTime {
  natural.parse(frame);
  frameRateSchema.parse(rate);
  let numerator = BigInt(frame) * BigInt(rate.denominator);
  let denominator = BigInt(rate.numerator);
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  if (
    numerator > BigInt(Number.MAX_SAFE_INTEGER) ||
    denominator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(
      'Frame time cannot be represented by safe JSON integers.',
    );
  }
  return { numerator: Number(numerator), denominator: Number(denominator) };
}
