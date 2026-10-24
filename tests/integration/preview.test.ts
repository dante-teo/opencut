import { describe, expect, it } from 'vitest';
import {
  distribution,
  frameAt,
  frameTarget,
  lastFrameIndex,
} from '../../apps/desktop/src/renderer/preview.js';

describe('preview timing and statistics', () => {
  it('uses a nominal zero-based frame and seeks inside its display interval', () => {
    for (const fps of [24, 25, 30, 30000 / 1001, 60000 / 1001]) {
      for (const frame of [0, 1, 17, 63]) {
        const target = frameTarget(frame, fps, 10);
        expect(Math.floor(target * fps)).toBe(frame);
        expect(frameAt(frame / fps, fps)).toBe(frame);
      }
    }
  });
  it('clamps stepping before the first frame and beyond the last', () => {
    expect(frameTarget(-1, 30, 3)).toBe(0.5 / 30);
    expect(lastFrameIndex(3, 30)).toBe(89);
    expect(frameTarget(90, 30, 3)).toBe(89.5 / 30);
    expect(frameTarget(1, 30, 0.01)).toBeLessThan(0.01);
    // ffprobe rounds duration to microseconds; do not invent an extra final frame.
    expect(lastFrameIndex(9.993317, 60000 / 1001)).toBe(598);
    expect(frameTarget(599, 60000 / 1001, 9.993317)).toBeCloseTo(
      598.5 / (60000 / 1001),
    );
  });
  it('reports arithmetic median and nearest-rank p95 without mutating samples', () => {
    const samples = [4, 1, 3, 2];
    expect(distribution(samples)).toEqual({ median: 2.5, p95: 4 });
    expect(samples).toEqual([4, 1, 3, 2]);
    expect(
      distribution(Array.from({ length: 20 }, (_, index) => index + 1)),
    ).toEqual({ median: 10.5, p95: 19 });
    expect(() => distribution([])).toThrow();
    expect(() => distribution([NaN])).toThrow();
  });
});
