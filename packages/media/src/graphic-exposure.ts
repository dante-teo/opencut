import { srgbToLinear, linearToSrgb } from '@opencut/shared';
import sharp from 'sharp';
import { MediaError } from './process.js';

const linear = Float32Array.from({ length: 256 }, (_, i) =>
  srgbToLinear(i / 255),
);

/** Accumulate one transparent subframe at a time in premultiplied linear sRGB. */
export async function exposeGraphic(
  width: number,
  height: number,
  samples: number,
  capture: (index: number) => Promise<Buffer>,
  signal?: AbortSignal,
) {
  if (samples === 1) return capture(0);
  const length = width * height * 4;
  const accumulation = new Float32Array(length);
  for (let i = 0; i < samples; i++) {
    signal?.throwIfAborted();
    const png = await capture(i);
    const { data, info } = await sharp(png, {
      limitInputPixels: width * height,
    })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4)
      throw new MediaError(
        'Motion blur sample dimensions do not match the graphic.',
      );
    for (let p = 0; p < length; p += 4) {
      const alpha = data[p + 3]! / 255;
      accumulation[p] = accumulation[p]! + linear[data[p]!]! * alpha;
      accumulation[p + 1] =
        accumulation[p + 1]! + linear[data[p + 1]!]! * alpha;
      accumulation[p + 2] =
        accumulation[p + 2]! + linear[data[p + 2]!]! * alpha;
      accumulation[p + 3] = accumulation[p + 3]! + alpha;
    }
  }
  signal?.throwIfAborted();
  const rgba = Buffer.alloc(length);
  for (let p = 0; p < length; p += 4) {
    const alpha = accumulation[p + 3]!;
    if (!alpha) continue;
    for (let c = 0; c < 3; c++) {
      const channel = Math.min(1, Math.max(0, accumulation[p + c]! / alpha));
      rgba[p + c] = Math.round(linearToSrgb(channel) * 255);
    }
    rgba[p + 3] = Math.round((alpha / samples) * 255);
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}
