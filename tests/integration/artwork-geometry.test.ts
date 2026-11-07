import { describe, expect, it } from 'vitest';
import {
  filmstripTiles,
  waveformPath,
  waveformTiles,
} from '../../apps/desktop/src/renderer/artwork-geometry.js';

describe('visible timeline artwork', () => {
  it('anchors filmstrips to the trim, adapting sample density without sampling the out boundary', () => {
    const initial = filmstripTiles(0, 300, 80, 2, 8);
    const scrolled = filmstripTiles(150, 100, 80, 2, 8);
    expect(scrolled[0]!.start).toBe(initial[0]!.start);
    expect(scrolled[0]!.x).toBe(-150);
    expect(scrolled[0]!.count).toBe(4);
    expect(filmstripTiles(0, 576, 160, 2, 5.6)).toHaveLength(2);
    for (const tile of filmstripTiles(0, 576, 160, 2, 5.6))
      expect(tile.start + (tile.count - 1) * tile.interval).toBeLessThan(5.6);
    expect(filmstripTiles(0, 300, 80, 1, 1.9)).toEqual([
      { index: 0, x: 0, width: 72, count: 1, interval: 0, start: 1 },
    ]);
  });

  it('reuses the same source waveform chunks through zoom, scrolling and splits', () => {
    const tiles = waveformTiles(500, 400, 80, 8, 18);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({
      start: 0,
      x: 0,
      width: 140,
      from: 14.25,
      to: 16,
    });
    expect(tiles[1]).toMatchObject({
      start: 16,
      x: 140,
      width: 160,
      from: 0,
      to: 2,
    });
    const split = waveformTiles(0, 800, 160, 16.5, 18);
    expect(split[0]).toMatchObject({
      start: 16,
      x: 0,
      width: 240,
      from: 0.5,
      to: 2,
    });
  });

  it('keeps transients at coarse zoom and excludes peaks outside the trim or split', () => {
    const peaks = new Uint8Array(1600);
    peaks[0] = 255;
    peaks[50] = 255;
    peaks[100] = 255;
    const wide = waveformTiles(0, 100, 640, 0.004, 1.004)[0]!;
    const coarse = waveformTiles(0, 100, 5, 0.004, 1.004)[0]!;
    expect(waveformPath(peaks, wide, 640, 32)).toBe('');
    expect(waveformPath(peaks, coarse, 5, 32)).toBe(
      'M1.98 0.50H2.98V31.50H1.98Z',
    );
    const split = waveformTiles(0, 100, 80, 0.4, 1.005)[0]!;
    expect(waveformPath(peaks, split, 80, 10)).toBe(
      'M8.00 0.50H8.80V9.50H8.00Z',
    );
  });

  it('bounds work by viewport width even for distant clips', () => {
    expect(filmstripTiles(1e9, 1000, 80, 0, 1e10).length).toBeLessThanOrEqual(
      15,
    );
    const tiles = waveformTiles(1e9, 1000, 5, 0, 1e10);
    expect(tiles.length).toBeLessThanOrEqual(14);
    expect(tiles[0]!.start).toBe(200_000_000);
  });
});
