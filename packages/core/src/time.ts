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
  return rationalTime(
    BigInt(frame) * BigInt(rate.denominator),
    BigInt(rate.numerator),
  );
}

export function rationalTime(
  numerator: bigint,
  denominator: bigint,
): RationalTime {
  if (numerator < 0n) throw new RangeError('Time must not be negative.');
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  if (
    numerator > BigInt(Number.MAX_SAFE_INTEGER) ||
    denominator > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError('Time cannot be represented by safe JSON integers.');
  }
  return { numerator: Number(numerator), denominator: Number(denominator) };
}

/** Exact, reduced arithmetic; reject negative or unrepresentable results without rounding. */
export function addTimes(a: RationalTime, b: RationalTime): RationalTime {
  timeSchema.parse(a);
  timeSchema.parse(b);
  return rationalTime(
    BigInt(a.numerator) * BigInt(b.denominator) +
      BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
}

export function subtractTimes(a: RationalTime, b: RationalTime): RationalTime {
  timeSchema.parse(a);
  timeSchema.parse(b);
  return rationalTime(
    BigInt(a.numerator) * BigInt(b.denominator) -
      BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
}
