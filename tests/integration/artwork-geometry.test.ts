import { describe, expect, it } from 'vitest';
import { artworkTiles } from '../../apps/desktop/src/renderer/artwork-geometry.js';

describe('visible timeline artwork', () => {
  it('keeps filmstrip samples anchored to the trimmed source while scrolling', () => {
    const initial = artworkTiles(0, 300, 80, 2, 8, false);
    const scrolled = artworkTiles(150, 100, 80, 2, 8, false);
    expect(scrolled[0]!.start).toBe(initial[0]!.start);
    expect(scrolled[0]!.x).toBe(-150);
    expect(scrolled[0]!.count).toBe(4);
    expect(scrolled.at(-1)!.x).toBeLessThan(100);
    expect(scrolled.every((tile) => tile.start >= 2 && tile.start < 8)).toBe(
      true,
    );
  });
  it('covers the visible audio range and preserves the last partial tile duration', () => {
    const tiles = artworkTiles(500, 160, 80, 1, 9, true);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({
      x: -500,
      width: 512,
      start: 1,
      duration: 6.4,
      count: 1,
    });
    expect(tiles[1]!.start).toBeCloseTo(7.4);
    expect(tiles[1]!.width).toBeCloseTo(128);
    expect(tiles[1]!.start + tiles[1]!.duration).toBe(9);
  });
  it('bounds generated work by viewport width even for distant clips', () => {
    expect(
      artworkTiles(1e9, 1000, 80, 0, 1e10, false).length,
    ).toBeLessThanOrEqual(15);
  });
});
