import { describe, expect, it } from 'vitest';
import {
  evaluateVisual,
  maximumVisualScale,
  sampleKeyframes,
} from './keyframes.js';
import type { VisualKeyframe } from './keyframes.js';
import {
  cycleTime,
  ease,
  interpolate,
  interpolateColor,
  sampleMotion,
  seededVariation,
} from './motion.js';
import type { MotionEasing } from './motion.js';

const spring: MotionEasing = {
  type: 'spring',
  mass: 1,
  stiffness: 100,
  damping: 8,
  duration: 2,
};
const time = (numerator: number, denominator = 1) => ({
  numerator,
  denominator,
});

describe('motion and native transform sampling', () => {
  it('extrapolates explicitly, repeats without request history and interpolates sRGB in linear light', () => {
    expect(interpolate(12, [0, 10], [0, 100], { after: 'extend' })).toBe(120);
    expect(interpolate(-2, [0, 10], [0, 100], { before: 'identity' })).toBe(-2);
    expect(cycleTime(13, { mode: 'ping-pong', duration: 10 })).toBe(7);
    const channel = {
      keys: [
        { at: 0, value: 0 },
        { at: 10, value: 100 },
      ],
      cycle: { mode: 'loop' as const, duration: 10 },
    };
    expect([
      sampleMotion(channel, 17),
      sampleMotion(channel, 2),
      sampleMotion(channel, 17),
    ]).toEqual([70, 20, 70]);
    expect(interpolateColor('#000000', '#ffffff', 0.5)).toBe('#bcbcbcff');
    expect(interpolateColor('#ff000000', '#0000ff', 0.5)).toBe('#0000ff80');
    expect(seededVariation(17, 'plate')).toBe(seededVariation(17, 'plate'));
    expect(seededVariation(17, 'plate')).not.toBe(seededVariation(18, 'plate'));
  });

  it('retains native spring overshoot and bounds allocations above all rendered samples', () => {
    const channel: VisualKeyframe[] = [
      { time: time(0), value: 1, easing: spring },
      { time: time(1), value: 2, easing: 'linear' },
    ];
    const all = Array.from({ length: 100 }, (_, i) =>
      sampleKeyframes(channel, time(i, 99)),
    );
    expect(Math.max(...all)).toBeGreaterThan(2.2);
    expect(maximumVisualScale({}, { scale: channel })).toBeGreaterThanOrEqual(
      Math.max(...all),
    );
    expect(
      evaluateVisual(
        {},
        {
          opacity: channel.map((item) => ({ ...item, value: item.value / 2 })),
        },
        time(1, 6),
      ),
    ).toEqual({ opacity: 1 });
    expect(all.at(0)).toBe(1);
    expect(all.at(-1)).toBe(2);
  });

  it('retains an original curve excursion when a spring is trimmed', () => {
    const a = 0.12,
      b = 0.48,
      amplitude = 0.8;
    const cropped: VisualKeyframe[] = [
      {
        time: time(0),
        value: 1 + amplitude * ease(a, spring),
        easing: spring,
        curve: [a, b],
        curveAmplitude: amplitude,
      },
      {
        time: time(1),
        value: 1 + amplitude * ease(b, spring),
        easing: 'linear',
      },
    ];
    expect(sampleKeyframes(cropped, time(3, 8))).toBeCloseTo(
      1 + amplitude * ease(a + ((b - a) * 3) / 8, spring),
      12,
    );
  });
});
