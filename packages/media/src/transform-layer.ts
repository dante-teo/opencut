import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import type { Canvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import {
  evaluateVisual,
  drawMediaLayer,
  gradePixels,
  transformTextLayer,
  transitionLayerGeometry,
  transitionProgress,
  visualGeometry,
} from '@opencut/shared';
import type {
  KeyframeTime,
  VisualAnimation,
  VisualTransform,
  ColorGrade,
  SourceWindow,
  TransitionRamp,
} from '@opencut/shared';
import { checkRenderSignal, MediaError } from './process.js';
import { renderToolCommand, trackRenderProcess } from './render-budget.js';
import { sourceWindowFilter } from './source-window.js';
import { indexedSeekArgs } from './video-filter.js';

type TransformSource =
  | { kind: 'text'; rasterize: () => Promise<Buffer>; x: number; y: number }
  | {
      kind: 'graphic';
      still: boolean;
      aspect: number;
      rasterize(frame: number, signal: AbortSignal): Promise<Buffer>;
    }
  | {
      kind: 'media';
      path: string;
      stream: number;
      width: number;
      height: number;
      aspect: number;
      matrix: string;
      window?: SourceWindow;
      /** Project-frame sampling and range filters. Still images need neither. */
      sampling?: {
        filter: string;
        seek?: { seconds: number; fallbackFilter: string };
      };
    };

export interface TransformLayerOptions {
  width: number;
  height: number;
  rate: KeyframeTime;
  startFrame: number;
  frameCount: number;
  visual: VisualTransform;
  animation?: VisualAnimation;
  ramp?: TransitionRamp;
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
    sampling?.filter,
    sampling?.seek ? 'setpts=PTS-STARTPTS' : undefined,
    source.window && sourceWindowFilter(source.window, matrix),
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
      ...(sampling?.seek
        ? ['-copyts', ...indexedSeekArgs(sampling.seek.seconds)]
        : []),
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
  const command = renderToolCommand(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-xerror', ...args],
    !decode,
  );
  const child = spawn(command.tool, command.args, {
    stdio: decode ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
    signal,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  let diagnostics = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-16384);
  });
  const closed = new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    child.on('error', (error) => {
      failure = error;
    });
    const untrack = trackRenderProcess(child.pid, (error) => {
      failure = error;
      child.kill('SIGKILL');
    });
    child.once('close', (code, signal) => {
      untrack();
      if (signal === 'SIGXFSZ' || /File too large/i.test(diagnostics))
        reject(new MediaError('Render exceeded its temporary disk budget.'));
      else if (code === 0 && !failure) resolve();
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

class IncompleteTransformFrames extends MediaError {}

/** Stage one alpha-preserving layer. Only the current input and output frames are held in memory. */
export async function stageTransformLayer(
  options: TransformLayerOptions,
  destination: string,
) {
  const { source, signal } = options;
  try {
    await writeTransformLayer(options, destination);
  } catch (error) {
    if (
      source.kind !== 'media' ||
      !(error instanceof IncompleteTransformFrames)
    )
      throw error;
    const seek = source.sampling?.seek;
    if (!seek) throw error;
    checkRenderSignal(signal);
    // A demuxer can seek by DTS to a keyframe that starts after the requested
    // presentation tick. Discard the short stage and sample from the origin.
    await rm(destination, { force: true });
    await writeTransformLayer(
      {
        ...options,
        source: { ...source, sampling: { filter: seek.fallbackFilter } },
      },
      destination,
    );
  }
}

function transitionTransform(
  ctx: SKRSContext2D,
  ramp: TransitionRamp,
  progress: number,
  width: number,
  height: number,
) {
  const style = ramp.style;
  if (!style) return;
  const incoming = ramp.direction === 'in';
  const { x, y, scale } = transitionLayerGeometry(
    progress,
    ramp,
    width,
    height,
  );
  if (x || y) ctx.translate(x, y);
  if (scale !== 1) {
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-width / 2, -height / 2);
  }
  if (style.kind === 'blur') {
    const radius = style.radius * (incoming ? 1 - progress : progress);
    if (radius > 0) ctx.filter = `blur(${radius}px)`;
  }
}

function finishTransition(
  ctx: SKRSContext2D,
  frame: number,
  ramp: TransitionRamp,
  width: number,
  height: number,
) {
  const { style } = ramp;
  if (
    style?.kind === 'push' ||
    (style?.kind === 'slide' && ramp.direction === 'in')
  )
    return;
  const progress = transitionProgress(frame, ramp);
  const { alpha, clip } = transitionLayerGeometry(
    progress,
    ramp,
    width,
    height,
  );
  ctx.save();
  if (alpha === 0) ctx.clearRect(0, 0, width, height);
  else {
    if (clip.left) ctx.clearRect(0, 0, clip.left, height);
    if (clip.top) ctx.clearRect(0, 0, width, clip.top);
    ctx.clearRect(clip.right, 0, width, height);
    ctx.clearRect(0, clip.bottom, width, height);
    if (alpha !== 1) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = alpha;
      ctx.fillRect(0, 0, width, height);
    }
  }
  if (style?.kind === 'dip-to-color' && ramp.direction === 'out') {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1 - Math.abs(2 * progress - 1);
    ctx.fillStyle = style.color;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

async function writeTransformLayer(
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
  // The default filter can repeat samples at very small fractional offsets.
  if (animation && source.kind !== 'text') ctx.imageSmoothingQuality = 'high';
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

  const decoder = media && ffmpeg(media.args, signal, true);

  async function* frames() {
    const decoded =
      media && decoder
        ? decodedFrames(decoder.child.stdout!, media.pixels.data)
        : null;
    const sourceCtx = media?.canvas.getContext('2d');
    let graphic: Image | Canvas | undefined;
    let graphicBytes: Buffer | undefined;
    for (let i = 0; i < frameCount; i++) {
      signal.throwIfAborted();
      if (media && decoded && (!media.still || i === 0)) {
        if ((await decoded.next()).done)
          throw new IncompleteTransformFrames(
            'FFmpeg returned fewer transform frames than expected.',
          );
        if (options.grade) gradePixels(media.pixels.data, options.grade);
        sourceCtx!.putImageData(media.pixels, 0, 0);
      }
      if (source.kind === 'graphic' && (!graphic || !source.still)) {
        const bytes = await source.rasterize(startFrame + i, signal);
        if (bytes !== graphicBytes) {
          graphicBytes = bytes;
          const image = await loadImage(bytes);
          if (options.grade) {
            const canvas = createCanvas(image.width, image.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            const pixels = ctx.getImageData(0, 0, image.width, image.height);
            gradePixels(pixels.data, options.grade);
            ctx.putImageData(pixels, 0, 0);
            graphic = canvas;
          } else graphic = image;
        }
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
      ctx.save();
      if (options.ramp)
        transitionTransform(
          ctx,
          options.ramp,
          transitionProgress(startFrame + i, options.ramp),
          width,
          height,
        );
      if (raster && source.kind === 'text') {
        ctx.save();
        transformTextLayer(ctx, width, height, sampled);
        ctx.drawImage(raster, source.x, source.y);
        ctx.restore();
      } else {
        const input = media?.canvas ?? graphic;
        if (input) {
          const aspect =
            source.kind === 'graphic' ? source.aspect : media!.aspect;
          const geometry = visualGeometry(
            width,
            height,
            aspect,
            1,
            sampled,
            animation ? 'subpixel' : 'even',
          );
          if (geometry.visible) drawMediaLayer(ctx, input, geometry);
        }
      }
      ctx.restore();
      if (options.ramp)
        finishTransition(ctx, startFrame + i, options.ramp, width, height);
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
    const outcomes = await Promise.allSettled(tasks);
    checkRenderSignal(options.signal);
    if (error instanceof Error && 'code' in error && error.code === 'EPIPE') {
      const root = outcomes.find(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.name === 'MediaError',
      );
      if (root?.status === 'rejected') throw root.reason;
    }
    if (timeout.aborted)
      throw new MediaError('FFmpeg transform layer timed out.');
    throw error;
  }
}
