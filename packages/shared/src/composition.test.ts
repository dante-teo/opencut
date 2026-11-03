import { expect, it } from 'vitest';
import {
  canvasColorPattern,
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
