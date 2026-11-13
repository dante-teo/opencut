import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import {
  evaluateVisual,
  drawMediaLayer,
  gradePixels,
  transformTextLayer,
  visualGeometry,
} from '@opencut/shared';
import type {
  KeyframeTime,
  VisualAnimation,
  VisualTransform,
  ColorGrade,
} from '@opencut/shared';
import { checkRenderSignal, MediaError } from './process.js';

type TransformSource =
  | { kind: 'text'; rasterize: () => Promise<Buffer>; x: number; y: number }
  | {
      kind: 'media';
      path: string;
      stream: number;
      width: number;
      height: number;
      aspect: number;
      matrix: string;
      /** Project-frame sampling and range filters. Still images need neither. */
      sampling?: string;
    };

export interface TransformLayerOptions {
  width: number;
  height: number;
  rate: KeyframeTime;
  startFrame: number;
  frameCount: number;
  visual: VisualTransform;
  animation?: VisualAnimation;
  grade?: ColorGrade;
  source: TransformSource;
  signal?: AbortSignal | undefined;
}

function rawSource(
  source: Extract<TransformSource, { kind: 'media' }>,
  frames: number,
) {
  const { path, stream, width, height, matrix, sampling } = source;
  const limit = Math.min(
    1,
    8192 / width,
    8192 / height,
    Math.sqrt((3840 * 2160) / (width * height)),
  );
  const decodeWidth = Math.max(1, Math.floor(width * limit));
  const decodeHeight = Math.max(1, Math.floor(height * limit));
  const filters = [
    sampling,
    `scale=${decodeWidth}:${decodeHeight}:in_color_matrix=${matrix}`,
    'format=rgba',
  ];
  return {
    width: decodeWidth,
    height: decodeHeight,
    still: !sampling,
    aspect: source.aspect,
    args: [
      '-threads',
      '1',
      '-i',
      path,
      '-map',
      `0:${stream}`,
      '-vf',
      filters.filter(Boolean).join(','),
      '-frames:v',
      String(sampling ? frames : 1),
      '-an',
      '-fps_mode',
      'passthrough',
      '-threads',
      '1',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
  };
}

function ffmpeg(args: string[], signal: AbortSignal, decode: boolean) {
  const child = spawn(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-xerror', ...args],
    {
      stdio: decode ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
      windowsHide: true,
    },
  );
  let diagnostics = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-16384);
  });
  const closed = new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (code === 0 && !failure) resolve();
      else
        reject(
          new MediaError(
            `FFmpeg transform ${decode ? 'decode' : 'encode'} failed: ${diagnostics.trim() || failure?.message || code}`,
          ),
        );
    });
  });
  return { child, closed };
}

async function* decodedFrames(
  stream: NodeJS.ReadableStream,
  pixels: Uint8ClampedArray,
) {
  let used = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(chunk.length - offset, pixels.length - used);
      pixels.set(chunk.subarray(offset, offset + count), used);
      used += count;
      offset += count;
      if (used === pixels.length) {
        yield;
        used = 0;
      }
    }
  }
  if (used) throw new MediaError('FFmpeg returned a partial transform frame.');
}

/** Stage one alpha-preserving layer. Only the current input and output frames are held in memory. */
export async function stageTransformLayer(
  options: TransformLayerOptions,
  destination: string,
) {
  checkRenderSignal(options.signal);
  const { createCanvas, ImageData, loadImage } =
    await import('@napi-rs/canvas');
  const {
    width,
    height,
    rate,
    source,
    frameCount,
    startFrame,
    visual,
    animation,
  } = options;
  const output = createCanvas(width, height);
  const ctx = output.getContext('2d');
  const raster =
    source.kind === 'text' ? await loadImage(await source.rasterize()) : null;
  const raw = source.kind === 'media' ? rawSource(source, frameCount) : null;
  const media = raw && {
    ...raw,
    canvas: createCanvas(raw.width, raw.height),
    pixels: new ImageData(raw.width, raw.height),
  };
  checkRenderSignal(options.signal);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(600_000);
  const signal = AbortSignal.any([
    controller.signal,
    timeout,
    ...(options.signal ? [options.signal] : []),
  ]);
  const decoder = media && ffmpeg(media.args, signal, true);
  const encoder = ffmpeg(
    [
      '-n',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgba',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      `${rate.numerator}/${rate.denominator}`,
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'bgra',
      '-threads',
      '2',
      '-f',
      'nut',
      destination,
    ],
    signal,
    false,
  );

  async function* frames() {
    const decoded =
      media && decoder
        ? decodedFrames(decoder.child.stdout!, media.pixels.data)
        : null;
    const sourceCtx = media?.canvas.getContext('2d');
    for (let i = 0; i < frameCount; i++) {
      signal.throwIfAborted();
      if (media && decoded && (!media.still || i === 0)) {
        if ((await decoded.next()).done)
          throw new MediaError(
            'FFmpeg returned fewer transform frames than expected.',
          );
        if (options.grade) gradePixels(media.pixels.data, options.grade);
        sourceCtx!.putImageData(media.pixels, 0, 0);
      }
      const sampled = evaluateVisual(
        visual,
        animation?.keyframes,
        {
          numerator: (startFrame + i) * rate.denominator,
          denominator: rate.numerator,
        },
        animation?.start,
      );
      ctx.clearRect(0, 0, width, height);
      if (raster && source.kind === 'text') {
        ctx.save();
        transformTextLayer(ctx, width, height, sampled);
        ctx.drawImage(raster, source.x, source.y);
        ctx.restore();
      } else if (media) {
        const geometry = visualGeometry(
          width,
          height,
          media.aspect,
          1,
          sampled,
        );
        if (geometry.visible) drawMediaLayer(ctx, media.canvas, geometry);
      }
      const pixels = ctx.getImageData(0, 0, width, height).data;
      yield Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    if (decoded && !(await decoded.next()).done)
      throw new MediaError('FFmpeg returned extra transform frames.');
  }

  const transfer = pipeline(frames(), encoder.child.stdin!, { signal });
  const tasks = [
    encoder.closed,
    ...(decoder ? [decoder.closed] : []),
    transfer,
  ];
  try {
    await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    checkRenderSignal(options.signal);
    if (timeout.aborted)
      throw new MediaError('FFmpeg transform layer timed out.');
    throw error;
  }
}
