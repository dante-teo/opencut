import { describe, expect, it } from 'vitest';
import {
  clipTimelineEnd,
  createProject,
  frameTime,
  validateProject,
  type TimelineClip,
} from '@opencut/core';
import {
  frameIndex,
  indexTimeline,
  MAX_SCROLL_WIDTH,
  pixelTime,
  relativePixels,
  rulerTicks,
  scrollGeometry,
  snapToFrame,
  sourceToTimeline,
  timelineTimecode,
  timelineToSource,
  visibleClips,
  zoomScroll,
} from '../../apps/desktop/src/renderer/timeline-geometry.js';

const rate = { numerator: 30000, denominator: 1001 };
const clip: TimelineClip = {
  id: 'clip',
  trackId: 'v1',
  assetId: 'av',
  timelineStart: frameTime(300, rate),
  sourceIn: frameTime(30, rate),
  sourceOut: frameTime(90, rate),
};
describe('timeline geometry and transport', () => {
  it('keeps rational boundaries exact and converts only the final delta to pixels', () => {
    expect(
      relativePixels(clipTimelineEnd(clip), clip.timelineStart, 80),
    ).toBeCloseTo(160.16, 10);
    const distant = {
      ...clip,
      timelineStart: { numerator: 1_000_000_000, denominator: 1 },
    };
    expect(
      relativePixels(clipTimelineEnd(distant), distant.timelineStart, 80),
    ).toBeCloseTo(160.16, 10);
    expect(snapToFrame(pixelTime(160.16, 80), rate)).toEqual(
      frameTime(60, rate),
    );
    expect(frameIndex(frameTime(100_000_001, rate), rate)).toBe(100_000_001n);
    expect(
      relativePixels(
        { numerator: 1, denominator: 9_007_199_254_740_991 },
        { numerator: 1, denominator: 640_000 },
        640,
      ),
    ).toBeCloseTo(-0.001, 10);
  });
  it('labels fractional project rates without floating-point frame-boundary errors', () => {
    expect(timelineTimecode(frameTime(1800, rate), rate)).toBe('00:01:00:00');
    expect(timelineTimecode(frameTime(1799, rate), rate)).toBe('00:00:59:29');
    expect(timelineTimecode(frameTime(2_592_001, rate), rate)).toBe(
      '24:00:00:01',
    );
    expect(
      timelineTimecode(frameTime(24, { numerator: 24, denominator: 1 }), {
        numerator: 24,
        denominator: 1,
      }),
    ).toBe('00:00:01:00');
  });
  it('retains insertion order, indexes existing clips without mutation and includes clips spanning the viewport', () => {
    const project = createProject({ name: 'Index' });
    project.tracks = [
      { id: 'v1', name: 'Video', type: 'video' },
      { id: 'a1', name: 'Audio', type: 'audio' },
    ];
    project.clips = [
      clip,
      { ...clip, id: 'later', timelineStart: frameTime(600, rate) },
      { ...clip, id: 'audio', trackId: 'a1' },
    ];
    const original = JSON.stringify(project);
    const indexed = indexTimeline(project);
    expect(indexed.tracks.get('v1')![0]!.clip).toBe(clip);
    expect(
      visibleClips(
        indexed.tracks.get('v1')!,
        frameTime(320, rate),
        frameTime(340, rate),
      ).map(({ clip }) => clip.id),
    ).toEqual(['clip']);
    expect(
      visibleClips(
        indexed.tracks.get('v1')!,
        frameTime(360, rate),
        frameTime(600, rate),
      ),
    ).toEqual([]);
    expect(indexed.end).toEqual(frameTime(660, rate));
    expect(JSON.stringify(project)).toBe(original);
    expect(indexTimeline(undefined).end).toEqual({
      numerator: 0,
      denominator: 1,
    });
  });
  it('includes the declared closing gap and preserves later markers in seek bounds', () => {
    const project = createProject({
      name: 'Declared duration',
      settings: {
        width: 320,
        height: 180,
        frameRate: rate,
        durationFrames: 480,
      },
    });
    project.clips = [clip];
    expect(indexTimeline(project).end).toEqual(frameTime(480, rate));
    project.markers = [
      { id: 'review-marker', frame: 500, name: 'Review marker' },
    ];
    expect(indexTimeline(project).end).toEqual(frameTime(500, rate));
  });
  it('indexes a large subtitle track and queries only cues intersecting the viewport', () => {
    const project = createProject({ name: 'Long subtitle list' });
    const at = (numerator: number) => ({ numerator, denominator: 1 });
    project.subtitles = {
      style: {},
      cues: Array.from({ length: 10_000 }, (_, i) => ({
        id: 'cue-' + i,
        start: at(i * 2),
        end: at(i * 2 + 3),
        text: 'English\n中文字幕',
      })),
    };
    const indexed = indexTimeline(project);
    expect(indexed.rows).toHaveLength(2);
    expect(indexed.end).toEqual(at(20001));
    const visible = indexed.rows.flatMap(({ id }) =>
      visibleClips(indexed.tracks.get(id)!, at(18000), at(18005)).map(
        ({ clip }) => clip.id,
      ),
    );
    expect(visible.sort()).toEqual([
      'cue-8999',
      'cue-9000',
      'cue-9001',
      'cue-9002',
    ]);
  });
  it('scales scrollbars beyond browser dimension limits and preserves the time at a zoom anchor', () => {
    const end = { numerator: 864_000, denominator: 1 };
    const geometry = scrollGeometry(end, 640, 1000);
    expect(geometry.physicalWidth).toBe(MAX_SCROLL_WIDTH);
    expect(geometry.ratio).toBeGreaterThan(1);
    expect((geometry.physicalWidth - 1000) * geometry.ratio).toBeCloseTo(
      geometry.logicalWidth - 1000,
    );
    const next = zoomScroll(2000, 375, 80, 320);
    expect((next + 375) / 320).toBe((2000 + 375) / 80);
  });
  it('bounds ruler work and keeps ticks aligned across zooms and distant origins', () => {
    for (const zoom of [5, 80, 640]) {
      const origin = pixelTime(86400 * zoom + 17, zoom);
      const ticks = rulerTicks(origin, 1200, zoom, rate);
      expect(ticks.length).toBeLessThan(20);
      for (const tick of ticks) {
        const time = frameTime(Number(tick.frame), rate);
        expect(tick.x).toBe(relativePixels(time, origin, zoom));
        expect(tick.label).toBe(timelineTimecode(time, rate));
      }
      expect(ticks.at(-1)!.x).toBeLessThanOrEqual(1200);
    }
  });
  it('maps trimmed source ranges to timeline positions, clamps source playback, and excludes the out boundary', () => {
    expect(timelineToSource(clip, clip.timelineStart)).toBeCloseTo(1.001);
    expect(timelineToSource(clip, frameTime(330, rate))).toBeCloseTo(2.002);
    expect(timelineToSource(clip, frameTime(299, rate))).toBeUndefined();
    expect(timelineToSource(clip, clipTimelineEnd(clip))).toBeUndefined();
    expect(sourceToTimeline(clip, 0)).toEqual(clip.timelineStart);
    expect(sourceToTimeline(clip, 100)).toEqual(clipTimelineEnd(clip));
    expect(sourceToTimeline(clip, 2.002)).toEqual(frameTime(330, rate));
    expect(sourceToTimeline(clip, 2.001999, rate)).toEqual(
      frameTime(330, rate),
    );
  });
  it('maps valid coprime and long timeline times without overflowing intermediate JSON fractions', () => {
    const fractionalStart = {
      ...clip,
      timelineStart: { numerator: 1, denominator: 1_000_000_000_039 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 1, denominator: 1 },
    };
    expect(timelineToSource(fractionalStart, frameTime(15, rate))).toBeCloseTo(
      0.5005,
      10,
    );
    expect(sourceToTimeline(fractionalStart, 0.5005, rate)).toEqual(
      frameTime(15, rate),
    );
    const longStart = {
      ...fractionalStart,
      timelineStart: { numerator: 10_000_000_000, denominator: 1 },
    };
    expect(() => sourceToTimeline(longStart, 0.500499, rate)).not.toThrow();
  });
  it('queries a large clip collection without rendering offscreen clips', () => {
    const project = createProject({ name: 'Large' });
    project.clips = Array.from({ length: 50_000 }, (_, n) => ({
      ...clip,
      id: `clip-${n}`,
      timelineStart: { numerator: n * 4, denominator: 1 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 2, denominator: 1 },
    }));
    const index = indexTimeline(project);
    expect(
      visibleClips(
        index.tracks.get('v1')!,
        { numerator: 100_001, denominator: 1 },
        { numerator: 100_020, denominator: 1 },
      ).map(({ clip }) => clip.id),
    ).toEqual([
      'clip-25000',
      'clip-25001',
      'clip-25002',
      'clip-25003',
      'clip-25004',
    ]);
  });
});

describe('timeline frame representability', () => {
  const preciseRate = {
    numerator: 3_000_000_000_000_001,
    denominator: 100_000_000_000_000,
  };

  it('renders ticks for a valid rate whose frame-time numerator exceeds safe JSON integers', () => {
    const project = createProject({
      name: 'Rational ticks',
      settings: { width: 1920, height: 1080, frameRate: preciseRate },
    });
    expect(validateProject(project).success).toBe(true);
    const ticks = rulerTicks(
      { numerator: 0, denominator: 1 },
      660,
      80,
      preciseRate,
    );
    expect(ticks.map((tick) => tick.label)).toEqual([
      '00:00:00:00',
      '00:00:01:20',
      '00:00:03:10',
      '00:00:05:00',
      '00:00:06:20',
    ]);
    expect(ticks[2]!.x).toBeCloseTo(
      800_000_000_000_000_000 / 3_000_000_000_000_001,
      12,
    );
    expect(ticks.every((tick) => Number.isFinite(tick.x))).toBe(true);
  });

  it('snaps an unrepresentable frame boundary to a bounded rational approximation', () => {
    const snapped = snapToFrame({ numerator: 10, denominator: 3 }, preciseRate);
    expect(Number.isSafeInteger(snapped.numerator)).toBe(true);
    expect(Number.isSafeInteger(snapped.denominator)).toBe(true);
    expect(frameIndex(snapped, preciseRate)).toBe(100n);
    expect(
      BigInt(snapped.numerator) * BigInt(preciseRate.numerator),
    ).toBeGreaterThanOrEqual(
      100n * BigInt(preciseRate.denominator) * BigInt(snapped.denominator),
    );
    expect(snapped.numerator / snapped.denominator).toBeCloseTo(10 / 3, 14);
  });

  it('keeps source playback moving and bounded when its snapped frame time is unrepresentable', () => {
    const trimmed = {
      ...clip,
      timelineStart: { numerator: 10, denominator: 1 },
      sourceIn: { numerator: 1, denominator: 1 },
      sourceOut: { numerator: 11, denominator: 1 },
    };
    const mapped = sourceToTimeline(trimmed, 5, preciseRate);
    expect(Number.isSafeInteger(mapped.numerator)).toBe(true);
    expect(Number.isSafeInteger(mapped.denominator)).toBe(true);
    expect(frameIndex(mapped, preciseRate)).toBe(420n);
    expect(mapped.numerator / mapped.denominator).toBeCloseTo(14, 12);
    expect(sourceToTimeline(trimmed, 0, preciseRate)).toEqual(
      trimmed.timelineStart,
    );
    expect(sourceToTimeline(trimmed, 11, preciseRate)).toEqual(
      clipTimelineEnd(trimmed),
    );
  });

  it('keeps ruler and source playback working beyond the safe frame-count API', () => {
    const distant = {
      ...clip,
      timelineStart: { numerator: 5_000_000_000_000_001, denominator: 1 },
      sourceIn: { numerator: 0, denominator: 1 },
      sourceOut: { numerator: 10, denominator: 1 },
    };
    const rate = { numerator: 2, denominator: 1 };
    const ticks = rulerTicks(distant.timelineStart, 660, 80, rate);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => Number.isFinite(tick.x))).toBe(true);
    expect(sourceToTimeline(distant, 5, rate)).toEqual({
      numerator: 5_000_000_000_000_006,
      denominator: 1,
    });
  });

  it('retains exact reduced boundaries when a large unreduced rate still fits the model', () => {
    const equivalentRate = {
      numerator: 6_000_000_000_000_000,
      denominator: 200_000_000_000_000,
    };
    expect(
      snapToFrame({ numerator: 10, denominator: 3 }, equivalentRate),
    ).toEqual({ numerator: 10, denominator: 3 });
  });
});
