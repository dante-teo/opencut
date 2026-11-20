import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { svgRaster } from './static-svg-raster.js';

const input = process.argv[2]!;
try {
  const png = await svgRaster(sharp, await readFile(input));
  process.stdout.write(png);
} catch (cause) {
  process.stderr.write(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
