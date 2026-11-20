import type sharp from 'sharp';

export function svgRaster(engine: typeof sharp, bytes: Buffer) {
  return engine(bytes, {
    failOn: 'warning',
    unlimited: false,
    limitInputPixels: 3840 * 2160,
  })
    .timeout({ seconds: 10 })
    .ensureAlpha()
    .png()
    .toBuffer();
}
