import { describe, expect, it } from 'vitest';
import { compareTimes, frameTime } from './index.js';

describe('exact rational time', () => {
  it.each([
    [0, { numerator: 0, denominator: 1 }],
    [1, { numerator: 1001, denominator: 30000 }],
    [30, { numerator: 1001, denominator: 1000 }],
    [30000, { numerator: 1001, denominator: 1 }],
  ])('converts frame %i at 30000/1001 without rounding', (frame, expected) => {
    expect(frameTime(frame, { numerator: 30000, denominator: 1001 })).toEqual(
      expected,
    );
  });

  it('supports integral and other fractional frame rates', () => {
    expect(frameTime(1, { numerator: 24, denominator: 1 })).toEqual({
      numerator: 1,
      denominator: 24,
    });
    expect(frameTime(1, { numerator: 60000, denominator: 1001 })).toEqual({
      numerator: 1001,
      denominator: 60000,
    });
    expect(frameTime(48000, { numerator: 48000, denominator: 1 })).toEqual({
      numerator: 1,
      denominator: 1,
    });
  });

  it('compares unreduced fractions exactly', () => {
    expect(
      compareTimes(
        { numerator: 2, denominator: 4 },
        { numerator: 1, denominator: 2 },
      ),
    ).toBe(0);
    expect(
      compareTimes(
        { numerator: 3, denominator: 4 },
        { numerator: 1, denominator: 2 },
      ),
    ).toBe(1);
  });

  it('does not lose precision in large intermediate products', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(
      compareTimes(
        { numerator: max, denominator: max - 1 },
        { numerator: max - 1, denominator: max - 2 },
      ),
    ).toBe(-1);
    expect(frameTime(max, { numerator: max, denominator: max - 1 })).toEqual({
      numerator: max - 1,
      denominator: 1,
    });
    expect(() => frameTime(max, { numerator: 2, denominator: 3 })).toThrow(
      RangeError,
    );
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid frame index %s',
    (frame) => {
      expect(() =>
        frameTime(frame, { numerator: 30, denominator: 1 }),
      ).toThrow();
    },
  );

  it.each([
    { numerator: 0, denominator: 1 },
    { numerator: 30, denominator: 0 },
    { numerator: -30, denominator: 1 },
    { numerator: 29.97, denominator: 1 },
    { numerator: 30, denominator: Infinity },
  ])('rejects invalid frame rate %j', (rate) => {
    expect(() => frameTime(1, rate)).toThrow();
  });
});
