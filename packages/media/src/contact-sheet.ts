import { link, lstat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { renderTimelineFrame } from './render.js';
import type { VideoTimelineOptions } from './render.js';
import { runMediaTool, checkRenderSignal, MediaError } from './process.js';
import type { Mp4FrameIndex } from './media-frame-index.js';

/** Assemble only already-composited frames; sharp never renders project layers. */
export async function renderContactSheet(
  options: VideoTimelineOptions,
  frames: number[],
  columns: number,
) {
  if (
    options.overwrite ||
    frames.some((frame) => frame < 0 || frame >= options.frameCount)
  )
    throw new MediaError(
      'Contact sheets require in-range frames and a new .png output.',
    );
  const size = options.maxDimension ?? 320;
  return assembleContactSheet(
    options.output,
    frames.map((frame) => ({
      frame,
      seconds:
        (frame * options.frameRate.denominator) / options.frameRate.numerator,
    })),
    columns,
    size,
    options.signal,
    async (directory) => {
      const paths: string[] = [];
      let width = 0;
      let height = 0;
      for (const [i, frame] of frames.entries()) {
        const result = await renderTimelineFrame({
          ...options,
          output: join(directory, `${i}.png`),
          maxDimension: size,
          range: { startFrame: frame, endFrame: frame + 1 },
        });
        ({ width, height } = result);
        paths.push(result.path);
      }
      return { paths, width, height };
    },
  );
}

export async function renderMp4ContactSheet(
  index: Mp4FrameIndex,
  frames: number[],
  columns: number,
  output: string,
  size = 320,
  signal?: AbortSignal,
) {
  if (
    frames.some(
      (frame, i) =>
        !Number.isSafeInteger(frame) ||
        frame < 0 ||
        frame >= index.ticks.length ||
        (i > 0 && frame <= frames[i - 1]!),
    )
  )
    throw new MediaError(
      'Use unique, increasing MP4 frame indices within the video.',
    );
  const displayWidth = index.width * index.sar;
  const scale = Math.min(1, size / Math.max(displayWidth, index.height));
  const width = Math.max(1, Math.round(displayWidth * scale));
  const height = Math.max(1, Math.round(index.height * scale));
  const { numerator, denominator } = index.timeBase;
  return assembleContactSheet(
    output,
    frames.map((frame) => ({
      frame,
      seconds: (index.ticks[frame]! * numerator) / denominator,
    })),
    columns,
    size,
    signal,
    (directory) =>
      decodeMp4Tiles(index, frames, directory, width, height, signal),
  );
}

/** Decode exact presentation-order indices with the contact-sheet sampling path. */
export async function decodeMp4Tiles(
  index: Mp4FrameIndex,
  frames: readonly number[],
  directory: string,
  width: number,
  height: number,
  signal?: AbortSignal,
) {
  const select = frames.map((frame) => `eq(n,${frame})`).join('+');
  await index.checkSource();
  await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-threads',
      '2',
      '-i',
      index.path,
      '-map',
      `0:${index.stream}`,
      '-vf',
      `select='${select}',scale=${width}:${height}:reset_sar=1`,
      '-frames:v',
      String(frames.length),
      '-fps_mode',
      'passthrough',
      '-c:v',
      'png',
      '-threads',
      '1',
      '-start_number',
      '0',
      join(directory, 'tile-%d.png'),
    ],
    undefined,
    600_000,
    { signal, writesFile: true, stage: 'decoding selected MP4 frames' },
  );
  await index.checkSource();
  return {
    paths: frames.map((_, i) => join(directory, `tile-${i}.png`)),
    width,
    height,
  };
}

async function assembleContactSheet(
  output: string,
  frames: { frame: number; seconds: number }[],
  columns: number,
  size: number,
  signal: AbortSignal | undefined,
  renderTiles: (
    directory: string,
  ) => Promise<{ paths: string[]; width: number; height: number }>,
) {
  if (
    !frames.length ||
    frames.length > 16 ||
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > frames.length ||
    frames.some(({ frame }) => !Number.isSafeInteger(frame) || frame < 0)
  )
    throw new MediaError(
      'Contact sheets require 1–16 in-range frame indices and 1–sample-count columns.',
    );
  if (extname(output).toLowerCase() !== '.png')
    throw new MediaError('Contact sheets require a new .png output.');
  if (!Number.isSafeInteger(size) || size < 64 || size > 640)
    throw new MediaError('Contact-sheet tile size must be between 64 and 640.');
  const path = resolve(output);
  try {
    await lstat(path);
    throw new MediaError(`Refusing to overwrite existing output '${path}'.`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  checkRenderSignal(signal);
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
    const labelHeight = 32;
    const {
      paths,
      width: tileWidth,
      height: tileHeight,
    } = await renderTiles(temporary);
    const cellWidth = Math.max(96, tileWidth);
    const tiles = paths.map((input, index) => ({
      input,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * (tileHeight + labelHeight),
    }));
    const rows = Math.ceil(frames.length / columns);
    const width = columns * cellWidth;
    const height = rows * (tileHeight + labelHeight);
    // Numeric labels only: no project text or user-supplied SVG is interpreted.
    const labels = frames
      .map(({ frame, seconds }, index) => {
        const x = (index % columns) * cellWidth + 4;
        const y =
          Math.floor(index / columns) * (tileHeight + labelHeight) + tileHeight;
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
    checkRenderSignal(signal);
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
