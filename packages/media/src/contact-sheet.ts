import { link, lstat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { renderTimelineFrame } from './render.js';
import type { VideoTimelineOptions } from './render.js';
import { checkRenderSignal, MediaError } from './process.js';

/** Assemble only already-composited frames; sharp never renders project layers. */
export async function renderContactSheet(
  options: VideoTimelineOptions,
  frames: number[],
  columns: number,
) {
  if (
    !frames.length ||
    frames.length > 16 ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > frames.length ||
    frames.some(
      (frame) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= options.frameCount,
    )
  )
    throw new MediaError(
      'Contact sheets require 1–16 in-range frame indices and 1–sample-count columns.',
    );
  if (options.overwrite || extname(options.output).toLowerCase() !== '.png')
    throw new MediaError('Contact sheets require a new .png output.');
  const size = options.maxDimension ?? 320;
  if (!Number.isSafeInteger(size) || size < 64 || size > 640)
    throw new MediaError('Contact-sheet tile size must be between 64 and 640.');
  const path = resolve(options.output);
  try {
    await lstat(path);
    throw new MediaError(`Refusing to overwrite existing output '${path}'.`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  checkRenderSignal(options.signal);
  const temporary = await mkdtemp(join(dirname(path), '.opencut-sheet-')).catch(
    (cause: unknown) => {
      throw new MediaError(
        'Cannot create contact sheet; use a new .png path in an existing writable directory.',
        { cause },
      );
    },
  );
  try {
    const { default: sharp } = await import('sharp');
    const tiles = [];
    const labelHeight = 32;
    let tileWidth = 0,
      tileHeight = 0;
    let cellWidth = 0;
    for (const [index, frame] of frames.entries()) {
      checkRenderSignal(options.signal);
      const result = await renderTimelineFrame({
        ...options,
        output: join(temporary, `${index}.png`),
        maxDimension: size,
        range: { startFrame: frame, endFrame: frame + 1 },
      });
      tileWidth = result.width;
      tileHeight = result.height;
      cellWidth = Math.max(96, tileWidth);
      tiles.push({
        input: result.path,
        left: (index % columns) * cellWidth,
        top: Math.floor(index / columns) * (tileHeight + labelHeight),
      });
    }
    const rows = Math.ceil(frames.length / columns);
    const width = columns * cellWidth;
    const height = rows * (tileHeight + labelHeight);
    // Numeric labels only: no project text or user-supplied SVG is interpreted.
    const labels = frames
      .map((frame, index) => {
        const x = (index % columns) * cellWidth + 4;
        const y =
          Math.floor(index / columns) * (tileHeight + labelHeight) + tileHeight;
        const seconds =
          (frame * options.frameRate.denominator) / options.frameRate.numerator;
        return `<text x="${x}" y="${y + 13}">f${frame}</text><text x="${x}" y="${y + 27}">${seconds.toFixed(3)}s</text>`;
      })
      .join('');
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="sans-serif" font-size="12" fill="white">${labels}</g></svg>`,
    );
    const rendered = join(temporary, 'sheet.png');
    await sharp({
      create: { width, height, channels: 3, background: '#181818' },
      limitInputPixels: 16_000_000,
    })
      .composite([...tiles, { input: svg, left: 0, top: 0 }])
      .png()
      .toFile(rendered);
    checkRenderSignal(options.signal);
    await link(rendered, path).catch((cause: unknown) => {
      throw new MediaError(
        `Cannot publish contact sheet '${path}'; use a new path in a writable directory.`,
        { cause },
      );
    });
    return {
      path,
      width,
      height,
      columns,
      rows,
      tileWidth,
      cellWidth,
      tileHeight,
      labelHeight,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
