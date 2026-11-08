import { describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
import { rasterizeTextLayer, type TextRaster } from './text.js';

async function ink(raster: TextRaster) {
  const { data, info } = await sharp(raster.png!)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const points: { x: number; y: number; alpha: number }[] = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3]!;
      if (alpha > 8) points.push({ x: raster.x + x, y: raster.y + y, alpha });
    }
  }
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  return {
    points,
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

describe('shared text rasters', () => {
  it('bounds shaping work when wrapping a long CJK line', async () => {
    const prototype = Object.getPrototypeOf(
      createCanvas(1, 1).getContext('2d'),
    );
    const measure = vi.spyOn(prototype, 'measureText');
    try {
      const raster = await rasterizeTextLayer(
        3840,
        2160,
        { content: '中'.repeat(4096), fontSize: 1, wrapWidth: 3840 },
        {},
      );
      expect(raster.png?.length).toBeGreaterThan(100);
      expect(measure.mock.calls.length).toBeGreaterThan(1);
      expect(measure.mock.calls.length).toBeLessThan(100);
    } finally {
      measure.mockRestore();
    }
  });
  it('shapes Latin, Chinese and emoji with independent glyphs, line breaks and weight', async () => {
    const draw = (content: string, fontWeight = 400) =>
      rasterizeTextLayer(360, 240, { content, fontSize: 40, fontWeight }, {});
    const mixed = await draw('Hello\n字幕😀');
    const { points } = await ink(mixed);
    expect(points.filter(({ y }) => y < 120).length).toBeGreaterThan(150);
    expect(points.filter(({ y }) => y > 120).length).toBeGreaterThan(150);
    expect((await draw('字幕')).png).not.toEqual(
      (await draw('\u{10ffff}\u{10ffff}')).png,
    );
    expect((await draw('😀')).png).not.toEqual((await draw('\u{10ffff}')).png);
    expect((await draw('Hello', 700)).png).not.toEqual(
      (await draw('Hello')).png,
    );
    expect((await draw('\u{10ffff}')).png?.length).toBeGreaterThan(100);
  });

  it('uses shared wrap width and alignment before translating, rotating and applying opacity', async () => {
    const content = 'OpenCut OpenCut\n中文测试文字';
    const draw = (alignment: 'left' | 'right', wrapWidth?: number) =>
      rasterizeTextLayer(
        400,
        300,
        { content, alignment, wrapWidth, fontSize: 28 },
        {},
      );
    const left = await ink(await draw('left', 128));
    const right = await ink(await draw('right', 128));
    const unwrapped = await ink(await draw('left'));
    expect(left.bottom - left.top).toBeGreaterThan(
      unwrapped.bottom - unwrapped.top + 30,
    );
    expect(right.right).toBeGreaterThan(left.right);

    const text = { content: 'Hello 字幕', fontSize: 34 };
    const base = await ink(await rasterizeTextLayer(400, 300, text, {}));
    const moved = await ink(
      await rasterizeTextLayer(400, 300, text, { x: 17, y: -23, opacity: 0.5 }),
    );
    expect(moved.left - base.left).toBe(17);
    expect(moved.top - base.top).toBe(-23);
    expect(Math.max(...moved.points.map(({ alpha }) => alpha))).toBe(128);
    const rotated = await ink(
      await rasterizeTextLayer(
        400,
        300,
        {
          ...text,
          rotation: 90,
          stroke: { color: '#882211', width: 2 },
          shadow: { color: '#000000', x: 4, y: 6, blur: 4 },
          background: { color: '#336699', padding: 6 },
        },
        { scale: 1.25 },
      ),
    );
    expect(rotated.bottom - rotated.top).toBeGreaterThan(
      rotated.right - rotated.left,
    );
  });

  it('substitutes the bundled face for an unavailable family and skips off-canvas ink', async () => {
    const text = { content: 'English 中文' };
    const fallback = await rasterizeTextLayer(
      360,
      240,
      { ...text, fontFamily: 'OpenCut Missing Test Face' },
      {},
    );
    expect(fallback.warning).toContain('Using Noto Sans SC');
    expect(fallback.png).toEqual(
      (await rasterizeTextLayer(360, 240, text, {})).png,
    );
    expect(
      (await rasterizeTextLayer(360, 240, text, { x: -32768 })).png,
    ).toBeNull();
  });
});
