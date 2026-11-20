import { expect, it } from 'vitest';
import {
  canvasColorPattern,
  evaluateVisual,
  opaqueCanvasColor,
  visualGeometry,
} from './index.js';

it('fits display pixels, centers on the even chroma grid, and applies project-pixel offsets', () => {
  expect(
    visualGeometry(640, 360, 120, 240, { scale: 0.5, x: 160, y: -70 }),
  ).toMatchObject({
    x: 434,
    y: 20,
    scaledWidth: 90,
    scaledHeight: 180,
    layerWidth: 90,
    layerHeight: 180,
  });
  expect(
    visualGeometry(640, 360, 120, 240, { scale: 0.5, fit: 'cover' }),
  ).toMatchObject({
    x: 160,
    y: 90,
    scaledWidth: 320,
    scaledHeight: 640,
    cropY: 230,
    layerWidth: 320,
    layerHeight: 180,
  });
  expect(
    visualGeometry(640, 360, 120, 240, { fit: 'stretch', x: -1.9 }),
  ).toMatchObject({
    x: -2,
    y: 0,
    scaledWidth: 640,
    scaledHeight: 360,
  });
  expect(visualGeometry(100, 100, 320, 90)).toMatchObject({
    scaledWidth: 100,
    scaledHeight: 28,
  });
});

it.each([30, 60])(
  'samples fractional zoom and pan on every frame at %i fps',
  (fps) => {
    const end = { numerator: 63, denominator: 20 };
    const base = {
      fit: 'cover' as const,
      crop: { left: 0.1, top: 0.05, right: 0, bottom: 0.05 },
    };
    const keys = (start: number, finish: number) => [
      {
        time: { numerator: 0, denominator: 1 },
        value: start,
        easing: 'linear' as const,
      },
      { time: end, value: finish, easing: 'linear' as const },
    ];
    const keyframes = { scale: keys(1.005, 1.045), x: keys(0, 3) };
    const duration = end.numerator / end.denominator;
    for (let i = 0; i <= Math.floor(duration * fps); i++) {
      const time = { numerator: i, denominator: fps };
      const sample = evaluateVisual(base, keyframes, time);
      const geometry = visualGeometry(1080, 1440, 2, 3, sample, 'subpixel');
      const progress = i / (fps * duration);
      expect(geometry.layerWidth).toBeCloseTo(
        1080 * (1.005 + 0.04 * progress),
        9,
      );
      expect(geometry.centerX).toBeCloseTo(540 + 3 * progress, 9);
      expect(geometry.centerY).toBeCloseTo(720, 9);
      expect(geometry.cropY).toBeCloseTo(
        (geometry.scaledHeight - geometry.layerHeight) / 2,
        9,
      );
      expect(geometry.crop).toEqual(base.crop);
      expect(geometry.visible).toBe(true);
    }
  },
);

it('resolves crop and scaled rectangles before preview resampling and rejects offscreen/zero alpha', () => {
  expect(
    visualGeometry(3840, 2160, 720, 1280, { scale: 0.333, fit: 'cover' }),
  ).toMatchObject({
    layerWidth: 1278,
    layerHeight: 720,
  });
  for (const visual of [{ opacity: 0 }, { x: 641 }, { y: -361 }])
    expect(visualGeometry(640, 360, 640, 360, visual).visible).toBe(false);
  expect(visualGeometry(640, 360, 640, 360, { x: -639 }).visible).toBe(false);
  expect(visualGeometry(640, 360, 640, 360, { x: -638 }).visible).toBe(true);
});

it('accepts explicit canvas alpha and defines opaque export flattening', () => {
  for (const color of ['transparent', '#123456', '#12345680'])
    expect(canvasColorPattern.test(color)).toBe(true);
  for (const color of ['red', '#12345', '#1234567', '#123456;null'])
    expect(canvasColorPattern.test(color)).toBe(false);
  expect(opaqueCanvasColor('transparent')).toBe('#000000');
  expect(opaqueCanvasColor('#ffffff80')).toBe('#808080');
  expect(opaqueCanvasColor('#183048')).toBe('#183048');
});
