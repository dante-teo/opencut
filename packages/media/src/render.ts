import { decodeStillFrame } from './frame.js';
import {
  canvasColorPattern,
  opaqueCanvasColor,
  visualGeometry,
  sourceColorMatrix,
  usesLayerTransform,
  maximumVisualScale,
  roomEchoes,
} from '@opencut/shared';
import type {
  RenderTimeMapping,
  TextLayer,
  VisualAnimation,
  TransitionRamp,
} from '@opencut/shared';
import {
  access,
  link,
  lstat,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  probeMedia,
  isStillImage,
  videoSourceDuration,
  audioSourceDuration,
} from './probe.js';
import type { MediaMetadata } from './probe.js';
import {
  checkRenderSignal,
  MediaError,
  renderSourceInputArgs,
  runMediaTool,
} from './process.js';
import { renderProgress } from './render-progress.js';
import type { RenderProgress } from './render-progress.js';
import { fitVisual } from './video-filter.js';
import { stageTransformLayer } from './transform-layer.js';
import type { TransformLayerOptions } from './transform-layer.js';
import { rasterizeTextLayer } from './text.js';

interface VisualTimelineProperties {
  crop?: NonNullable<import('@opencut/shared').VisualTransform['crop']>;
  grade?: import('@opencut/shared').ColorGrade;
  clipId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  frameCount: number;
  retiming?: RenderTimeMapping & { sourceOriginNs: number };
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
  animation?: VisualAnimation;
  fit?: 'contain' | 'cover' | 'stretch';
}
export type VisualTimelineClip = VisualTimelineProperties &
  (
    | {
        path: string;
        freezeFrame?: Rational;
        text?: never;
        subtitle?: never;
        subtitleCueId?: never;
      }
    | { text: TextLayer; path?: never; subtitle?: true; subtitleCueId?: string }
  );

type TransitionLayer = Extract<VisualTimelineClip, { path: string }> & {
  ramp: TransitionRamp;
};
interface VisualTransition {
  afterClipId: string;
  layers: TransitionLayer[];
}

export const renderQualities = ['draft', 'balanced', 'high'] as const;
export const renderResolutions = ['project', '720p', '1080p'] as const;
export const renderCodecs = ['h264', 'hevc'] as const;
export type RenderCodec = (typeof renderCodecs)[number];
export type RenderQuality = (typeof renderQualities)[number];
export type RenderResolution = (typeof renderResolutions)[number];
export interface RenderControls {
  /** Trim the finished composition on the project grid; end is exclusive. */
  range?: { startFrame: number; endFrame: number } | undefined;
  /** Preview-only downscale of the finished canvas, never individual layers. */
  maxDimension?: number | undefined;
  codec?: RenderCodec | undefined;
  /** Resample the finished composition; source selection stays on the project grid. */
  outputFrameRate?: { numerator: number; denominator: number } | undefined;
  quality?: RenderQuality | undefined;
  resolution?: RenderResolution | undefined;
  outputSize?: { width: number; height: number } | undefined;
  videoBitrateKbps?: number | undefined;
  audioBitrateKbps?: number | undefined;
  audioSampleRate?: 44100 | 48000 | undefined;
  audioChannels?: 1 | 2 | undefined;
  overwrite?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (progress: RenderProgress) => void;
}

interface RenderAudioFade {
  duration: { numerator: number; denominator: number };
  from: number;
  to: number;
}

export interface VideoTimelineOptions extends RenderControls {
  /** Metadata already probed for this render invocation, indexed by resolved source path. */
  sourceMetadata?: ReadonlyMap<string, MediaMetadata>;
  /** Allow a desktop host to do text shaping off its main thread. */
  rasterizeText?: typeof rasterizeTextLayer;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  backgroundColor?: string;
  visualClips?: VisualTimelineClip[];
  visualTransitions?: VisualTransition[];
  /** Legacy sequential plan; supply either segments or visualClips. */
  segments?: Array<
    | { kind: 'gap'; frameCount: number }
    | {
        kind: 'clip';
        clipId: string;
        path: string;
        sourceStartFrame: number;
        frameCount: number;
      }
  >;
  audioClips?: Array<{
    clipId: string;
    path: string;
    timelineStartFrame: number;
    sourceStartFrame: number;
    frameCount: number;
    retiming?: RenderTimeMapping;
    tempoRunId?: string;
    volume: number;
    muted: boolean;
    fadeIn?: RenderAudioFade;
    fadeOut?: RenderAudioFade;
    gainKeys?: { time: Rational; value: number }[];
    effects?: Array<
      | { type: 'eq'; frequency: number; db: number }
      | { type: 'compressor'; threshold: number; ratio: number }
      | { type: 'limiter'; ceiling: number }
      | { type: 'de-esser'; amount: number }
      | { type: 'reverb'; mix: number }
    >;
    required: boolean;
    padAudio?: true;
  }>;
  output: string;
}

export interface VideoTimelineResult {
  codec: RenderCodec;
  quality: RenderQuality;
  resolution: RenderResolution;
  path: string;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  durationSeconds: number;
  metadata: MediaMetadata;
  warnings?: string[];
}

function validateOptions(options: VideoTimelineOptions): void {
  const {
    width,
    height,
    frameRate: { numerator, denominator },
    frameCount,
  } = options;
  const segments = options.segments ?? [];
  if (
    ![width, height, numerator, denominator, frameCount].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    width < 2 ||
    height < 2 ||
    width > 3840 ||
    height > 3840 ||
    width * height > 3840 * 2160 ||
    width % 2 ||
    height % 2 ||
    numerator > 2147483647 ||
    denominator > 2147483647 ||
    numerator < denominator ||
    numerator > 120 * denominator ||
    BigInt(frameCount) * BigInt(denominator) > 600n * BigInt(numerator) ||
    (options.backgroundColor !== undefined &&
      !canvasColorPattern.test(options.backgroundColor)) ||
    (options.visualClips !== undefined && options.segments !== undefined) ||
    (options.visualClips === undefined &&
      (segments.length === 0 ||
        segments.length > 128 ||
        segments.some(
          (s) =>
            !Number.isSafeInteger(s.frameCount) ||
            s.frameCount <= 0 ||
            (s.kind !== 'gap' &&
              (s.kind !== 'clip' ||
                !Number.isSafeInteger(s.sourceStartFrame) ||
                s.sourceStartFrame < 0 ||
                !Number.isSafeInteger(s.sourceStartFrame + s.frameCount))),
        ) ||
        segments.reduce((sum, s) => sum + s.frameCount, 0) !== frameCount)) ||
    (options.visualClips !== undefined &&
      (options.visualClips.filter((clip) => !clip.subtitle).length > 64 ||
        options.visualClips.some(
          (clip) =>
            !Number.isSafeInteger(clip.timelineStartFrame) ||
            clip.timelineStartFrame < 0 ||
            !Number.isSafeInteger(clip.sourceStartFrame) ||
            clip.sourceStartFrame < 0 ||
            !Number.isSafeInteger(clip.frameCount) ||
            clip.frameCount <= 0 ||
            (clip.retiming !== undefined &&
              (!validRetiming(clip.retiming) ||
                !Number.isInteger(clip.retiming.sourceOriginNs))) ||
            !Number.isSafeInteger(clip.sourceStartFrame + clip.frameCount) ||
            !Number.isSafeInteger(clip.timelineStartFrame + clip.frameCount) ||
            clip.timelineStartFrame + clip.frameCount > frameCount ||
            !Number.isFinite(clip.x ?? 0) ||
            Math.abs(clip.x ?? 0) > 32768 ||
            !Number.isFinite(clip.y ?? 0) ||
            Math.abs(clip.y ?? 0) > 32768 ||
            !Number.isFinite(clip.scale ?? 1) ||
            (clip.scale ?? 1) < 0.01 ||
            (clip.scale ?? 1) > 4 ||
            !Number.isFinite(clip.rotation ?? 0) ||
            Math.abs(clip.rotation ?? 0) > 36000 ||
            (!clip.text &&
              Math.max(width, height) *
                maximumVisualScale(clip, clip.animation?.keyframes) >
                8192) ||
            !Number.isFinite(clip.opacity ?? 1) ||
            (clip.opacity ?? 1) < 0 ||
            (clip.opacity ?? 1) > 1 ||
            !['contain', 'cover', 'stretch'].includes(clip.fit ?? 'contain'),
        ))) ||
    (options.audioClips?.length ?? 0) > 64 ||
    options.audioClips?.some(
      (clip) =>
        !Number.isSafeInteger(clip.timelineStartFrame) ||
        clip.timelineStartFrame < 0 ||
        !Number.isSafeInteger(clip.sourceStartFrame) ||
        clip.sourceStartFrame < 0 ||
        !Number.isSafeInteger(clip.frameCount) ||
        clip.frameCount < (clip.retiming ? 0 : 1) ||
        (clip.retiming !== undefined && !validRetiming(clip.retiming)) ||
        !Number.isSafeInteger(clip.sourceStartFrame + clip.frameCount) ||
        clip.timelineStartFrame + clip.frameCount > frameCount ||
        !Number.isFinite(clip.volume) ||
        clip.volume < 0 ||
        clip.volume > 1 ||
        typeof clip.muted !== 'boolean' ||
        typeof clip.required !== 'boolean' ||
        !validAudioFades(clip, numerator, denominator),
    )
  )
    throw new MediaError(
      'Invalid video render plan: use positive integer frame counts, even sides up to 3840 (at most 3840x2160 pixels), 1–120 fps, at most 64 non-subtitle visual/audio clips (or 128 legacy segments), valid transforms and #RRGGBB[AA]/transparent background, and 600 seconds.',
    );
}

type Rational = RenderTimeMapping['sourceIn'];

function gainExpression(keys: { sample: number; value: number }[]) {
  const first = keys[0]!;
  const intervals = [{ end: first.sample, value: String(first.value) }];
  for (let i = 1; i < keys.length; i++) {
    const left = keys[i - 1]!;
    const right = keys[i]!;
    if (right.sample > left.sample)
      intervals.push({
        end: right.sample,
        value: `${left.value}+(${right.value}-${left.value})*(n-${left.sample})/${right.sample - left.sample}`,
      });
  }
  intervals.push({ end: Infinity, value: String(keys.at(-1)!.value) });
  function build(start: number, end: number): string {
    if (end - start === 1) return intervals[start]!.value;
    const middle = Math.floor((start + end) / 2);
    return `if(lt(n,${intervals[middle - 1]!.end}),${build(start, middle)},${build(middle, end)})`;
  }
  return build(0, intervals.length);
}

function validRational(time: Rational | undefined): time is Rational {
  return (
    !!time &&
    Number.isSafeInteger(time.numerator) &&
    time.numerator >= 0 &&
    Number.isSafeInteger(time.denominator) &&
    time.denominator > 0
  );
}

function seconds(time: Rational): number {
  return time.numerator / time.denominator;
}

function timeDifference(a: Rational, b: Rational): bigint {
  return (
    BigInt(a.numerator) * BigInt(b.denominator) -
    BigInt(b.numerator) * BigInt(a.denominator)
  );
}

function validRetiming(timing: RenderTimeMapping): boolean {
  return (
    !!timing &&
    [
      timing.timelineStart,
      timing.timelineEnd,
      timing.sourceIn,
      timing.sourceOut,
      timing.speed,
    ].every(validRational) &&
    timeDifference(timing.speed, { numerator: 1, denominator: 4 }) >= 0n &&
    timeDifference(timing.speed, { numerator: 4, denominator: 1 }) <= 0n &&
    timeDifference(timing.timelineStart, timing.timelineEnd) < 0n &&
    timeDifference(timing.timelineEnd, { numerator: 600, denominator: 1 }) <=
      0n &&
    timeDifference(timing.sourceIn, timing.sourceOut) < 0n
  );
}

function validAudioFades(
  {
    fadeIn,
    fadeOut,
    frameCount,
    retiming,
  }: NonNullable<VideoTimelineOptions['audioClips']>[number],
  numerator: number,
  denominator: number,
): boolean {
  const fades = [fadeIn, fadeOut];
  for (const fade of fades) {
    if (fade === undefined) continue;
    if (
      !validRational(fade?.duration) ||
      fade.duration.numerator === 0 ||
      ![fade.from, fade.to].every(
        (gain) => Number.isFinite(gain) && gain >= 0 && gain <= 1,
      )
    )
      return false;
  }
  const a = BigInt(fadeIn?.duration.numerator ?? 0);
  const b = BigInt(fadeIn?.duration.denominator ?? 1);
  const c = BigInt(fadeOut?.duration.numerator ?? 0);
  const d = BigInt(fadeOut?.duration.denominator ?? 1);
  const { timelineStart: start, timelineEnd: end } = retiming ?? {};
  const frames =
    start && end
      ? timeDifference(end, start)
      : BigInt(frameCount) * BigInt(denominator);
  const rate =
    start && end
      ? BigInt(start.denominator) * BigInt(end.denominator)
      : BigInt(numerator);
  return (
    (a * d + c * b) * rate <= frames * b * d &&
    (!fadeIn ||
      (fadeIn.from <= fadeIn.to &&
        (fadeIn.to === 1 || a * rate === frames * b))) &&
    (!fadeOut ||
      (fadeOut.from >= fadeOut.to &&
        (fadeOut.from === 1 || c * rate === frames * d)))
  );
}

function sameFrameRate(
  actual: string | null,
  numerator: number,
  denominator: number,
): boolean {
  const parts = actual?.match(/^(\d+)\/(\d+)$/);
  return (
    !!parts &&
    BigInt(parts[1]!) * BigInt(denominator) ===
      BigInt(numerator) * BigInt(parts[2]!) &&
    BigInt(parts[2]!) > 0n
  );
}

interface StagedInput {
  filename: string;
  argumentIndex: number;
  write: (destination: string) => Promise<void>;
}

type HeldFrame = { path: string; width: number; height: number };
const maxBurnedSubtitleCues = 256;

export function validateSubtitleBurnIn(
  clips: readonly Pick<
    VisualTimelineClip,
    'subtitle' | 'subtitleCueId' | 'clipId'
  >[],
) {
  const ids = new Set<string>();
  for (const clip of clips) {
    if (clip.subtitle) ids.add(clip.subtitleCueId ?? clip.clipId);
    if (ids.size > maxBurnedSubtitleCues)
      throw new MediaError(
        `Burn-in supports up to ${maxBurnedSubtitleCues} visible subtitle cues per render. Shorten the render range or export a sidecar.`,
      );
  }
}

/** Prepare filters and stage unique held frames when executing a render. */
async function prepareTimeline(
  options: VideoTimelineOptions,
  png = false,
  scratch?: ReturnType<typeof renderScratch>,
) {
  checkRenderSignal(options.signal);
  validateOptions(options);
  const codec = options.codec ?? 'h264';
  const quality = options.quality ?? 'balanced';
  const resolution = options.resolution ?? 'project';
  if (
    !renderCodecs.includes(codec) ||
    !renderQualities.includes(quality) ||
    !renderResolutions.includes(resolution)
  )
    throw new MediaError('Unknown render codec, quality or resolution preset.');
  const encoding = {
    draft: { preset: 'ultrafast', crf: '28' },
    balanced: { preset: 'veryfast', crf: '20' },
    high: { preset: 'medium', crf: '16' },
  }[quality];
  const { width, height, frameRate, frameCount } = options;
  const { outputSize, videoBitrateKbps } = options;
  const audioBitrateKbps = options.audioBitrateKbps ?? 192;
  const audioSampleRate = options.audioSampleRate ?? 48000;
  const audioChannels = options.audioChannels ?? 2;
  if (
    outputSize &&
    (options.maxDimension !== undefined ||
      resolution !== 'project' ||
      ![outputSize.width, outputSize.height].every(
        (side) =>
          Number.isInteger(side) && side >= 2 && side <= 3840 && side % 2 === 0,
      ) ||
      outputSize.width * outputSize.height > 3840 * 2160)
  )
    throw new MediaError(
      'Custom dimensions must be even, 2–3840 per side, within 3840×2160 pixels, and use project resolution mode.',
    );
  if (
    videoBitrateKbps !== undefined &&
    (!Number.isInteger(videoBitrateKbps) ||
      videoBitrateKbps < 100 ||
      videoBitrateKbps > 100000)
  )
    throw new MediaError('Video bitrate must be 100–100000 kb/s.');
  if (
    !Number.isInteger(audioBitrateKbps) ||
    audioBitrateKbps < 32 ||
    audioBitrateKbps > 320 ||
    ![44100, 48000].includes(audioSampleRate) ||
    ![1, 2].includes(audioChannels)
  )
    throw new MediaError(
      'AAC requires 32–320 kb/s, 44.1 or 48 kHz, and mono or stereo.',
    );
  // Scale the finished canvas, preserving project-space transforms and layout.
  const longSide = resolution === '720p' ? 1280 : 1920;
  const shortSide = resolution === '720p' ? 720 : 1080;
  const maxWidth = width < height ? shortSide : longSide;
  const maxHeight = width < height ? longSide : shortSide;
  // Keep the scale as an integer ratio until the final division, so exact even
  // dimensions cannot lose two pixels through floating-point multiplication.
  let [scaleNumerator, scaleDenominator]: [number, number] =
    resolution === 'project'
      ? [1, 1]
      : maxWidth * height <= maxHeight * width
        ? [maxWidth, width]
        : [maxHeight, height];
  if (options.maxDimension !== undefined) {
    const size = options.maxDimension;
    if (!Number.isSafeInteger(size) || size < 64 || size > 1920)
      throw new MediaError(
        'Preview size must be an integer between 64 and 1920.',
      );
    const longest = Math.max(width, height);
    scaleNumerator = Math.min(size, longest);
    scaleDenominator = longest;
  }
  const outputWidth =
    outputSize?.width ??
    Math.max(
      2,
      Math.floor((width * scaleNumerator) / (2 * scaleDenominator)) * 2,
    );
  const outputHeight =
    outputSize?.height ??
    Math.max(
      2,
      Math.floor((height * scaleNumerator) / (2 * scaleDenominator)) * 2,
    );
  const startFrame = options.range?.startFrame ?? 0;
  const endFrame = options.range?.endFrame ?? frameCount;
  if (
    ![startFrame, endFrame].every(Number.isSafeInteger) ||
    startFrame < 0 ||
    endFrame <= startFrame ||
    endFrame > frameCount ||
    (options.range && options.outputFrameRate)
  )
    throw new MediaError(
      'Preview range must satisfy 0 <= start < end <= timeline frame count; range and outputFrameRate cannot be combined.',
    );
  if (png && endFrame - startFrame !== 1)
    throw new MediaError('PNG rendering requires exactly one project frame.');
  if (codec === 'hevc' && (outputWidth < 16 || outputHeight < 16))
    throw new MediaError(
      'HEVC requires output dimensions of at least 16 × 16 pixels.',
    );
  let cursor = 0;
  const visualClips: VisualTimelineClip[] =
    options.visualClips ??
    (options.segments ?? []).flatMap((segment) => {
      const timelineStartFrame = cursor;
      cursor += segment.frameCount;
      return segment.kind === 'gap' ? [] : [{ ...segment, timelineStartFrame }];
    });
  const { numerator, denominator } = frameRate;
  const rate = `${numerator}/${denominator}`;
  const outputRate = options.outputFrameRate ?? frameRate;
  if (
    ![outputRate.numerator, outputRate.denominator].every(
      (value) =>
        Number.isSafeInteger(value) && value > 0 && value <= 2147483647,
    ) ||
    outputRate.numerator < outputRate.denominator ||
    outputRate.numerator > 120 * outputRate.denominator
  )
    throw new MediaError('Output frame rate must be between 1 and 120 fps.');
  const ticks =
    BigInt(endFrame - startFrame) *
    BigInt(denominator) *
    BigInt(outputRate.numerator);
  const divisor = BigInt(numerator) * BigInt(outputRate.denominator);
  const outputFrameCount = Number((ticks + divisor - 1n) / divisor);
  const durationSeconds =
    (outputFrameCount * outputRate.denominator) / outputRate.numerator;
  const path = resolve(options.output);
  if (extname(path).toLowerCase() !== (png ? '.png' : '.mp4'))
    throw new MediaError(
      `Render output must have a ${png ? '.png' : '.mp4'} extension.`,
    );
  try {
    const existing = await lstat(path);
    if (!options.overwrite || !existing.isFile())
      throw new MediaError(
        `Refusing to overwrite existing output '${path}'. Use --overwrite for a regular file.`,
      );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  try {
    if (!(await stat(dirname(path))).isDirectory())
      throw new Error('Not a directory');
    await access(dirname(path), constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new MediaError(
      'Cannot create render output; use an existing writable directory.',
      {
        cause,
      },
    );
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-xerror',
    '-nostats',
    '-stats_period',
    '0.25',
    '-progress',
    'pipe:1',
  ];
  const warnings: string[] = [];
  const stagedInputs: StagedInput[] = [];
  const encoders = new Set([codec === 'h264' ? 'libx264' : 'libx265', 'aac']);
  const prepared = {
    args,
    path,
    quality,
    resolution,
    codec,
    outputWidth,
    outputHeight,
    frameRate: outputRate,
    frameCount: outputFrameCount,
    durationSeconds,
    warnings,
    stagedInputs,
    encoders,
  };
  const filters: string[] = [];
  const sources = new Map(options.sourceMetadata);
  const inputs = new Map<string, number>();
  const readSource = async (clip: { path: string; clipId: string }) => {
    checkRenderSignal(options.signal);
    if (options.overwrite) {
      // Never let explicit replacement target any source, including aliases.
      const existing = await stat(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      const original = await stat(clip.path).catch(() => null);
      if (
        existing &&
        original &&
        existing.dev === original.dev &&
        existing.ino === original.ino
      )
        throw new MediaError(
          `Render output must not replace source media '${clip.path}'.`,
        );
    }
    let source = sources.get(clip.path);
    if (!source) {
      try {
        source = await probeMedia(clip.path, options.signal);
      } catch (cause) {
        checkRenderSignal(options.signal);
        throw new MediaError(
          `Clip '${clip.clipId}' cannot read/probe media '${clip.path}'. Restore a readable source file. ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      sources.set(clip.path, source);
    }
    return source;
  };
  let input = 0;
  const registerInput = (filename: string, write: StagedInput['write']) => {
    const argumentIndex = args.push('-threads', '1', '-i', filename) - 1;
    stagedInputs.push({ filename, argumentIndex, write });
    return input++;
  };
  filters.push(
    `color=c=${opaqueCanvasColor(options.backgroundColor ?? '#000000')}:s=${width}x${height}:r=${rate},` +
      `format=rgba,trim=end_frame=${frameCount},settb=1/${numerator},setpts=N*${denominator}[canvas0]`,
  );
  const transitions = options.visualTransitions ?? [];
  const byOwner = new Map<string, VisualTransition[]>();
  const windows = new Map<string, TransitionRamp[]>();
  for (const transition of transitions) {
    const [first, second] = transition.layers;
    const ramp = first?.ramp;
    if (
      !ramp ||
      transition.layers.length > 2 ||
      transition.layers.at(-1)?.clipId !== transition.afterClipId ||
      (second &&
        (ramp.direction !== 'out' ||
          second.ramp.direction !== 'in' ||
          first.clipId === second.clipId)) ||
      !Number.isSafeInteger(ramp.startFrame) ||
      !Number.isSafeInteger(ramp.endFrame) ||
      ramp.startFrame < 0 ||
      ramp.endFrame > frameCount ||
      ramp.endFrame - ramp.startFrame < 2 ||
      transition.layers.some(
        (layer) =>
          !visualClips.some(({ clipId }) => clipId === layer.clipId) ||
          !layer.retiming ||
          !validRetiming(layer.retiming) ||
          !Number.isInteger(layer.retiming.sourceOriginNs) ||
          layer.timelineStartFrame !== ramp.startFrame ||
          layer.frameCount !== ramp.endFrame - ramp.startFrame ||
          layer.ramp.startFrame !== ramp.startFrame ||
          layer.ramp.endFrame !== ramp.endFrame ||
          !['in', 'out'].includes(layer.ramp.direction),
      )
    )
      throw new MediaError('Invalid video transition render plan.');
    const owned = byOwner.get(transition.afterClipId) ?? [];
    owned.push(transition);
    byOwner.set(transition.afterClipId, owned);
    for (const layer of transition.layers) {
      const ranges = windows.get(layer.clipId) ?? [];
      ranges.push(ramp);
      windows.set(layer.clipId, ranges);
    }
  }
  const visibleClips = visualClips.filter(
    (clip) =>
      !clip.subtitle ||
      (clip.timelineStartFrame < endFrame &&
        clip.timelineStartFrame + clip.frameCount > startFrame),
  );
  validateSubtitleBurnIn(visibleClips);
  const heldFrames = new Map<string, HeldFrame>();
  const framesync = 'eof_action=pass:repeatlast=0';
  const prepareLayer = async (
    clip: VisualTimelineClip,
    label: string,
    scratchName: string,
    ramp?: TransitionRamp,
  ) => {
    const transformed =
      Boolean(ramp || clip.grade || clip.crop) ||
      usesLayerTransform(clip.rotation, !!clip.animation);
    const first = Math.max(startFrame, clip.timelineStartFrame);
    const last = Math.min(endFrame, clip.timelineStartFrame + clip.frameCount);
    const transform = (source: TransformLayerOptions['source']) => {
      if (first >= last) return;
      encoders.add('ffv1');
      const hold =
        !clip.animation && (source.kind === 'text' || !source.sampling);
      const layerInput = registerInput(`${scratchName}.nut`, (destination) =>
        stageTransformLayer(
          {
            width,
            height,
            rate: frameRate,
            startFrame: first,
            frameCount: hold ? 1 : last - first,
            visual: clip,
            ...(clip.grade && { grade: clip.grade }),
            source,
            ...(clip.animation && { animation: clip.animation }),
            ...(ramp && { ramp }),
            signal: options.signal,
          },
          destination,
        ),
      );
      filters.push(
        `[${layerInput}:v]format=rgba,settb=1/${numerator},setpts=(N+${first})*${denominator}[${label}]`,
      );
      return { x: 0, y: 0, sync: hold ? 'repeatlast=1' : framesync };
    };
    if (clip.text) {
      const text = clip.text;
      const rasterize = () =>
        (options.rasterizeText ?? rasterizeTextLayer)(
          width,
          height,
          text,
          clip,
          options.signal,
          transformed,
        );
      checkRenderSignal(options.signal);
      const { x, y, png, warning } = await rasterize();
      checkRenderSignal(options.signal);
      if (warning) warnings.push(`Clip '${clip.clipId}': ${warning}`);
      if (!png) return;
      // Let the text raster cache own the bytes between preparation and staging.
      const readRaster = async () => {
        const { png } = await rasterize();
        if (!png)
          throw new MediaError(
            `Clip '${clip.clipId}' lost its text raster during export.`,
          );
        return png;
      };
      if (transformed)
        return transform({ kind: 'text', rasterize: readRaster, x, y });
      const textInput = registerInput(`${label}.png`, async (destination) =>
        writeFile(destination, await readRaster(), {
          flag: 'wx',
          signal: options.signal,
        }),
      );
      // Hold the static image from time zero and gate it to the clip interval.
      filters.push(
        `[${textInput}:v]format=rgba,settb=1/${numerator},setpts=0[${label}]`,
      );
      return { x, y, sync: 'repeatlast=1' };
    }
    const source = await readSource(clip);
    const { video } = source;
    const duration = videoSourceDuration(source);
    const freeze = clip.freezeFrame;
    const still = !!freeze || isStillImage(source);
    if (!video || video.isAttachedPicture || (!still && !video.frameRate))
      throw new MediaError(
        `Clip '${clip.clipId}' requires timed video or a still image on the video track.`,
      );
    if (ramp && still)
      throw new MediaError(
        `Transition clip '${clip.clipId}' requires timed video.`,
      );
    let held: HeldFrame | undefined;
    if (freeze) {
      if (
        isStillImage(source) ||
        !video.frameRate ||
        !validRational(freeze) ||
        (duration !== null && seconds(freeze) >= duration)
      )
        throw new MediaError(
          `Clip '${clip.clipId}' requires a freeze time inside a timed video.`,
        );
      if (first >= last) return;
      const inputStart = source.startTimeSeconds ?? 0;
      const timestamp =
        seconds(freeze) + ((video.startTimeSeconds ?? inputStart) - inputStart);
      const key = JSON.stringify([
        await realpath(source.path),
        video.index,
        timestamp,
      ]);
      held = heldFrames.get(key);
      if (!held) {
        const bytes = await decodeStillFrame(
          source,
          timestamp,
          true,
          options.signal,
        );
        // Preflight checks decoding and geometry without creating files.
        const path = scratch
          ? join(await scratch.open(), `freeze-${heldFrames.size}.png`)
          : `freeze-${heldFrames.size}.png`;
        if (scratch)
          await writeFile(path, bytes, { flag: 'wx', signal: options.signal });
        held = {
          path,
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        };
        heldFrames.set(key, held);
      }
    }
    // A held PNG already has square pixels and its display orientation.
    const rotated = !held && Math.abs(video.rotation ?? 0) % 180 === 90;
    const pixelWidth = held?.width ?? video.width ?? width;
    const pixelHeight = held?.height ?? video.height ?? height;
    const displayWidth =
      pixelWidth * (held ? 1 : (video.sampleAspectRatio ?? 1));
    const displayHeight = pixelHeight;
    const stream = held ? 0 : video.index;
    // Follow the same RGB conversion as the existing media pipeline.
    const matrix = held
      ? sourceColorMatrix(null, pixelWidth, pixelHeight, 'png')
      : sourceColorMatrix(
          video.colorSpace,
          video.width ?? 0,
          video.height ?? 0,
          video.codec,
        );
    const sourceEnd = clip.sourceStartFrame + clip.frameCount;
    const sourceOutSeconds = clip.retiming
      ? seconds(clip.retiming.sourceOut)
      : (sourceEnd * denominator) / numerator;
    if (
      !still &&
      (duration === null ||
        duration <= 0 ||
        sourceOutSeconds > duration + 0.000001)
    )
      throw new MediaError(
        `Clip '${clip.clipId}' source out exceeds the current video duration or its duration is unknown. Re-import the media and trim to a known video range.`,
      );
    // Sample before trimming so source selection is invariant under splitting.
    // A source frame first covers the project tick at or after its PTS.
    // Rounding down or to nearest can show a frame before its presentation time.
    const { retiming } = clip;
    const frameSampling = `fps=${rate}:start_time=0:round=${retiming ? 'near' : 'up'}:eof_action=pass,tpad=stop_mode=clone:stop=1,`;
    // Pick an absolute project frame before shifting to this piece's local clock.
    // Two source ns cover PTS rounding and truncation of the shared source origin.
    const frameNs = `(1000000000*${denominator}/${numerator})`;
    const sampling = still
      ? `loop=loop=-1:size=1:start=0,trim=end_frame=${clip.frameCount}`
      : retiming
        ? 'setpts=PTS-STARTPTS,settb=1/1000000000,' +
          `setpts=(ceil((PTS-(${retiming.sourceOriginNs})-2)*${retiming.speed.denominator}/${retiming.speed.numerator}/${frameNs})-${clip.timelineStartFrame})*${frameNs},` +
          frameSampling +
          `trim=end_frame=${clip.frameCount}`
        : 'setpts=PTS-STARTPTS,' +
          frameSampling +
          `trim=start_frame=${clip.sourceStartFrame}:end_frame=${sourceEnd}`;
    const inputPath = held?.path ?? source.path;
    if (transformed) {
      return transform({
        kind: 'media',
        path: inputPath,
        stream,
        width: rotated ? pixelHeight : pixelWidth,
        height: rotated ? pixelWidth : pixelHeight,
        aspect: rotated
          ? displayHeight / displayWidth
          : displayWidth / displayHeight,
        matrix,
        ...(!still && {
          sampling: `${sampling},trim=start_frame=${first - clip.timelineStartFrame}:end_frame=${last - clip.timelineStartFrame}`,
        }),
      });
    }
    const geometry = visualGeometry(
      width,
      height,
      rotated ? displayHeight : displayWidth,
      rotated ? displayWidth : displayHeight,
      clip,
    );
    args.push('-threads', '1', ...renderSourceInputArgs(), '-i', inputPath);
    if (!held) inputs.set(clip.clipId, input);
    filters.push(
      `[${input++}:${stream}]${sampling},` +
        `${fitVisual(geometry, matrix)},format=rgba,` +
        ((clip.opacity ?? 1) === 1 ? '' : `lut=a=val*${clip.opacity},`) +
        `settb=1/${numerator},setpts=(N+${clip.timelineStartFrame})*${denominator}[${label}]`,
    );
    return { x: geometry.x, y: geometry.y, sync: framesync };
  };

  const enabled = (start: number, end: number) =>
    `gte(n,${start})*lt(n,${end})`;
  let canvas = 0;
  const overlay = (
    label: string,
    { x, y, sync }: { x: number; y: number; sync: string },
    gate: string,
  ) => {
    filters.push(
      `[canvas${canvas}][${label}]overlay=x=${x}:y=${y}:${sync}:format=rgb:alpha=straight:enable='${gate}'[canvas${canvas + 1}]`,
    );
    canvas++;
  };
  for (const [index, clip] of visibleClips.entries()) {
    const label = `layer${index}`;
    const placement = await prepareLayer(clip, label, `layer-${index}`);
    if (placement) {
      const gate = enabled(
        clip.timelineStartFrame,
        clip.timelineStartFrame + clip.frameCount,
      );
      const replaced = (windows.get(clip.clipId) ?? [])
        .map(
          ({ startFrame, endFrame }) => `*(1-${enabled(startFrame, endFrame)})`,
        )
        .join('');
      overlay(label, placement, gate + replaced);
    }
    for (const [j, transition] of (byOwner.get(clip.clipId) ?? []).entries()) {
      const group = `transition${index}_${j}`;
      const [first, second] = transition.layers;
      const { startFrame: start, endFrame: end } = first!.ramp;
      if (start >= endFrame || end <= startFrame) continue;
      const gate = enabled(start, end);
      if (!second) {
        const placement = await prepareLayer(first!, group, group, first!.ramp);
        if (placement) overlay(group, placement, gate);
        continue;
      }
      await prepareLayer(first!, group + 'out', group + '-out', first!.ramp);
      await prepareLayer(second, group + 'in', group + '-in', second.ramp);
      // Both inputs are fitted to the canvas. Blend weighted premultiplied color
      // and alpha, then composite the result once at this track's position.
      filters.push(
        `[${group}out]format=gbrap,premultiply=inplace=1[${group}a]`,
        `[${group}in]format=gbrap,premultiply=inplace=1[${group}b]`,
        `[${group}a][${group}b]blend=all_mode=addition:shortest=1,unpremultiply=inplace=1,format=rgba[${group}]`,
      );
      overlay(group, { x: 0, y: 0, sync: framesync }, gate);
    }
  }
  filters.push(
    `[canvas${canvas}]trim=start_frame=${startFrame}:end_frame=${endFrame},settb=1/${numerator},setpts=N*${denominator},scale=${outputWidth}:${outputHeight}:out_color_matrix=bt709,setsar=1,` +
      (options.outputFrameRate
        ? `fps=${outputRate.numerator}/${outputRate.denominator}:round=up:eof_action=pass,tpad=stop_mode=clone:stop=1,trim=end_frame=${outputFrameCount},settb=1/${outputRate.numerator},setpts=N*${outputRate.denominator},`
        : '') +
      `format=${png ? 'rgb24' : 'yuv420p'}[video]`,
  );
  if (png) {
    args.push(
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[video]',
      '-an',
      '-frames:v',
      '1',
      '-c:v',
      'png',
      '-threads',
      '1',
      '-f',
      'image2',
    );
    return prepared;
  }
  // Round absolute project boundaries to the nearest 48 kHz sample. Never sum
  // independently rounded durations: fractional frame rates must not accumulate drift.
  const sample = (
    frame: number,
    rate = frameRate,
    offset?: RenderAudioFade['duration'],
    sign = 1n,
  ) => {
    const scale = BigInt(offset?.denominator ?? 1);
    const divisor = BigInt(rate.numerator) * scale;
    const n =
      (BigInt(frame) * BigInt(rate.denominator) * scale +
        sign * BigInt(offset?.numerator ?? 0) * BigInt(rate.numerator)) *
      48000n;
    return Number((2n * n + divisor) / (2n * divisor));
  };
  const sampleTime = (time: Rational, offset?: Rational, sign = 1n) =>
    sample(
      time.numerator,
      { numerator: time.denominator, denominator: 1 },
      offset,
      sign,
    );
  const totalSamples = options.range
    ? sample(frameCount)
    : sample(outputFrameCount, outputRate);
  const audioLabels = ['[silence]'];
  filters.push(
    `anullsrc=r=48000:cl=stereo,atrim=end_sample=${totalSamples},asettb=1/48000,asetpts=N[silence]`,
  );
  type AudioClip = NonNullable<VideoTimelineOptions['audioClips']>[number];
  const timelineSample = (
    clip: AudioClip,
    edge: 'start' | 'end',
    fade?: Rational,
  ) => {
    const sign = edge === 'start' ? 1n : -1n;
    if (clip.retiming) {
      const time =
        edge === 'start'
          ? clip.retiming.timelineStart
          : clip.retiming.timelineEnd;
      return sampleTime(time, fade, sign);
    }
    const frame =
      clip.timelineStartFrame + (edge === 'start' ? 0 : clip.frameCount);
    return sample(frame, frameRate, fade, sign);
  };
  const effectChain = (clip: AudioClip, count: number) => {
    const filters: string[] = [];
    const linear = (db: number) => 10 ** (db / 20);
    for (const effect of clip.effects ?? []) {
      switch (effect.type) {
        case 'eq':
          filters.push(
            `equalizer=f=${effect.frequency}:width_type=q:w=1:g=${effect.db}`,
          );
          break;
        case 'compressor':
          filters.push(
            `acompressor=threshold=${linear(effect.threshold)}:ratio=${effect.ratio}:attack=5:release=100`,
          );
          break;
        case 'limiter':
          filters.push(
            `alimiter=limit=${linear(effect.ceiling)}:level=0:latency=1`,
          );
          break;
        case 'de-esser':
          if (effect.amount)
            filters.push(`deesser=i=${effect.amount}:m=0.5:f=0.5`);
          break;
        case 'reverb':
          if (effect.mix)
            filters.push(
              `aecho=1:1:${roomEchoes.map((echo) => echo.seconds * 1000).join('|')}:${roomEchoes.map((echo) => echo.gain * effect.mix).join('|')}`,
              `atrim=end_sample=${count}`,
            );
          break;
      }
    }
    return filters.length ? filters.join(',') + ',' : '';
  };
  const envelope = (clip: AudioClip, start: number, end: number) => {
    const filters: string[] = [];
    if (clip.fadeIn) {
      const length =
        timelineSample(clip, 'start', clip.fadeIn.duration) - start;
      if (length > 0)
        filters.push(
          `afade=t=in:ss=0:ns=${length}:c=tri:silence=${clip.fadeIn.from}:unity=${clip.fadeIn.to}`,
        );
    }
    if (clip.fadeOut) {
      const release = timelineSample(clip, 'end', clip.fadeOut.duration);
      if (end > release)
        filters.push(
          `afade=t=out:ss=${release - start}:ns=${end - release}:c=tri:silence=${clip.fadeOut.to}:unity=${clip.fadeOut.from}`,
        );
    }
    filters.push(`volume=${clip.muted ? 0 : clip.volume}`);
    if (clip.gainKeys?.length) {
      const keys = clip.gainKeys.map(({ time, value }) => ({
        sample: timelineSample(clip, 'start', time) - start,
        value,
      }));
      const expression = gainExpression(keys);
      filters.push(
        `aeval='val(0)*${expression}|val(1)*${expression}':c=stereo`,
      );
    }
    return filters.join(',');
  };
  const runs: AudioClip[][] = [];
  for (const clip of options.audioClips ?? []) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run &&
      previous?.retiming &&
      clip.retiming &&
      clip.tempoRunId !== undefined &&
      clip.tempoRunId === previous.tempoRunId &&
      clip.path === previous.path &&
      clip.required === previous.required &&
      clip.padAudio === previous.padAudio &&
      JSON.stringify(clip.effects ?? []) ===
        JSON.stringify(previous.effects ?? []) &&
      timeDifference(
        previous.retiming.timelineEnd,
        clip.retiming.timelineStart,
      ) === 0n &&
      timeDifference(previous.retiming.sourceOut, clip.retiming.sourceIn) ===
        0n &&
      timeDifference(previous.retiming.speed, clip.retiming.speed) === 0n
    )
      run.push(clip);
    else runs.push([clip]);
  }
  for (const [index, run] of runs.entries()) {
    const first = run[0]!;
    const last = run.at(-1)!;
    const source = await readSource(first);
    const { audio, video } = source;
    if (!audio) {
      if (first.required)
        throw new MediaError(
          `Clip '${first.clipId}' requires an audio stream. Re-import or relink the audio asset.`,
        );
      continue;
    }
    const origin =
      video?.startTimeSeconds ??
      audio.startTimeSeconds ??
      source.startTimeSeconds ??
      0;
    const offset = (audio.startTimeSeconds ?? origin) - origin;
    const duration = audioSourceDuration(source);
    if (
      last.required &&
      !last.padAudio &&
      (duration === null ||
        (last.retiming
          ? seconds(last.retiming.sourceOut)
          : ((last.sourceStartFrame + last.frameCount) * denominator) /
            numerator) >
          duration + 0.000001)
    )
      throw new MediaError(
        `Clip '${last.clipId}' source out exceeds the current audio duration or its duration is unknown. Re-import the media and trim to a known audio range.`,
      );
    const pieces = run
      .map((clip) => ({
        clip,
        start: timelineSample(clip, 'start'),
        end: timelineSample(clip, 'end'),
      }))
      .filter(({ start, end }) => end > start);
    if (!pieces.some(({ clip }) => !clip.muted && clip.volume > 0)) continue;

    const start = pieces[0]!.start;
    const count = pieces.at(-1)!.end - start;
    const sourceStart = first.retiming
      ? sampleTime(first.retiming.sourceIn)
      : sample(first.sourceStartFrame);
    const sourceEnd = last.retiming
      ? sampleTime(last.retiming.sourceOut)
      : sourceStart + count;
    if (sourceEnd <= sourceStart) continue;
    let audioInput = inputs.get(first.clipId);
    if (audioInput === undefined) {
      audioInput = input++;
      args.push('-threads', '1', ...renderSourceInputArgs(), '-i', source.path);
    }
    const speed = first.retiming ? seconds(first.retiming.speed) : 1;
    // Keep one tempo filter across contiguous pieces. Only the run tail needs
    // padding to drain the tempo window, and each atempo pass stays within 0.5–2.
    const tempo =
      speed === 1
        ? ''
        : 'apad=pad_len=4800,' +
          (speed < 0.5
            ? `atempo=0.5,atempo=${speed * 2},`
            : speed > 2
              ? `atempo=2,atempo=${speed / 2},`
              : `atempo=${speed},`);
    const fitDuration = first.retiming
      ? `apad,atrim=end_sample=${count},asettb=1/48000,asetpts=N,`
      : '';
    const inputFilter =
      `[${audioInput}:${audio.index}]asetpts=PTS-STARTPTS+(${offset.toFixed(9)})/TB,` +
      'aresample=48000:async=1:min_hard_comp=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
      `apad,atrim=start_sample=${sourceStart}:end_sample=${sourceEnd},asettb=1/48000,asetpts=N,` +
      tempo +
      fitDuration +
      effectChain(first, count);
    const delay = `adelay=${start}S:all=1[a${index}]`;
    if (pieces.length === 1) {
      const piece = pieces[0]!;
      filters.push(
        inputFilter +
          envelope(piece.clip, piece.start, piece.end) +
          ',' +
          delay,
      );
    } else {
      // Route each sample to its piece once, apply that piece's envelope, then
      // join on the sample clock before mixing with other tracks.
      const labels = pieces.map((_, i) => `[run${index}p${i}]`);
      const boundaries = pieces.slice(1).map((piece) => piece.start - start);
      filters.push(
        inputFilter +
          `asegment=samples=${boundaries.join('|')}` +
          labels.join(''),
      );
      const adjusted = pieces.map((piece, i) => {
        const label = `[run${index}g${i}]`;
        filters.push(
          labels[i]! +
            'asettb=1/48000,asetpts=N,' +
            envelope(piece.clip, piece.start, piece.end) +
            label,
        );
        return label;
      });
      filters.push(
        adjusted.join('') +
          `concat=n=${pieces.length}:v=0:a=1,asettb=1/48000,asetpts=N,` +
          delay,
      );
    }
    audioLabels.push(`[a${index}]`);
  }
  // Stable linear gains, independent of the number of active sources. Match the
  // existing composer limiter, including latency compensation for sync markers.
  filters.push(
    `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:normalize=0,` +
      `alimiter=limit=0.95:level=0:latency=1,atrim=start_sample=${sample(startFrame)}:end_sample=${options.range ? sample(endFrame) : totalSamples},asettb=1/48000,asetpts=N[audio]`,
  );
  checkRenderSignal(options.signal);
  args.push(
    '-filter_complex_threads',
    '1',
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[video]',
    '-map',
    '[audio]',
    '-map_metadata',
    '-1',
    '-c:v',
    codec === 'h264' ? 'libx264' : 'libx265',
    '-preset',
    encoding.preset,
    ...(videoBitrateKbps === undefined
      ? ['-crf', encoding.crf]
      : ['-b:v', `${videoBitrateKbps}k`]),
    ...(codec === 'hevc'
      ? ['-x265-params', 'pools=2:log-level=error', '-tag:v', 'hvc1']
      : []),
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-fps_mode',
    'passthrough',
    '-enc_time_base:v',
    `1/${outputRate.numerator}`,
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-video_track_timescale',
    String(outputRate.numerator),
    '-c:a',
    'aac',
    '-b:a',
    `${audioBitrateKbps}k`,
    '-ar',
    String(audioSampleRate),
    '-ac',
    String(audioChannels),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
  );
  return prepared;
}

/** Full preflight uses the exact same plan, media probes and filters as execution. */
export async function validateVideoTimeline(options: VideoTimelineOptions) {
  const prepared = await prepareTimeline(options);
  const encoders = (
    await runMediaTool(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-encoders'],
      4 * 1024 * 1024,
      60_000,
      { signal: options.signal },
    )
  ).toString('utf8');
  for (const encoder of prepared.encoders) {
    if (!new RegExp(`\\b${encoder}\\b`).test(encoders))
      throw new MediaError(
        `Required encoder '${encoder}' is unavailable in this FFmpeg installation.`,
      );
  }
  return {
    width: prepared.outputWidth,
    height: prepared.outputHeight,
    frameRate: prepared.frameRate,
    frameCount: prepared.frameCount,
    durationSeconds: prepared.durationSeconds,
    codec: prepared.codec,
  };
}

/** Stage generated overlays beside the temporary output, on the same filesystem. */
function renderScratch(output: string, prefix: string) {
  const directory = dirname(resolve(output));
  let temporary: string | undefined;
  const open = async () => {
    try {
      return (temporary ??= await mkdtemp(join(directory, prefix)));
    } catch (cause) {
      throw new MediaError(
        `Cannot create render output in '${directory}'; use an existing writable directory.`,
        { cause },
      );
    }
  };
  return {
    open,
    async stage(
      { args, stagedInputs }: { args: string[]; stagedInputs: StagedInput[] },
      signal?: AbortSignal,
    ) {
      for (const { filename, argumentIndex, write } of stagedInputs) {
        checkRenderSignal(signal);
        const destination = join(await open(), filename);
        try {
          await write(destination);
        } catch (error) {
          checkRenderSignal(signal);
          throw error;
        }
        args[argumentIndex] = destination;
      }
      checkRenderSignal(signal);
    },
    async close() {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    },
  };
}

/** Execute the shared headless pipeline and publish only a verified, complete file. */
export async function renderVideoTimeline(
  options: VideoTimelineOptions,
): Promise<VideoTimelineResult> {
  const scratch = renderScratch(options.output, '.opencut-render-');
  try {
    const prepared = await prepareTimeline(options, false, scratch);
    await scratch.stage(prepared, options.signal);
    const {
      args,
      path,
      quality,
      resolution,
      codec,
      outputWidth,
      outputHeight,
      frameRate,
      frameCount,
      durationSeconds,
      warnings,
    } = prepared;
    const { numerator, denominator } = frameRate;
    const rendered = join(await scratch.open(), 'render.mp4');
    args.push(rendered);
    const progress = renderProgress(frameCount, options.onProgress);
    progress.start();
    checkRenderSignal(options.signal);
    await runMediaTool('ffmpeg', args, 4 * 1024 * 1024, 600_000, {
      signal: options.signal,
      onStdout: progress.chunk,
    });
    checkRenderSignal(options.signal);
    progress.verifying();
    const metadata = await probeMedia(rendered, options.signal);
    const video = metadata.video;
    // Decode/count output frames, rather than trusting container duration alone.
    const frameProbe = await runMediaTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'json',
        rendered,
      ],
      4 * 1024 * 1024,
      600_000,
      { signal: options.signal },
    );
    const counted = JSON.parse(frameProbe.toString('utf8')) as {
      streams?: { nb_read_frames?: string }[];
    };
    if (
      video?.codec !== codec ||
      metadata.streams.length !== 2 ||
      metadata.audio?.codec !== 'aac' ||
      metadata.audio.sampleRate !== (options.audioSampleRate ?? 48000) ||
      metadata.audio.channels !== (options.audioChannels ?? 2) ||
      metadata.audio.startTimeSeconds !== 0 ||
      metadata.audio.durationSeconds === null ||
      Math.abs(metadata.audio.durationSeconds - durationSeconds) > 0.0011 ||
      video.width !== outputWidth ||
      video.height !== outputHeight ||
      !sameFrameRate(video.frameRateRatio, numerator, denominator) ||
      video.durationSeconds === null ||
      Math.abs(video.durationSeconds - durationSeconds) > 0.000002 ||
      metadata.durationSeconds === null ||
      Math.abs(metadata.durationSeconds - durationSeconds) > 0.0011 ||
      video.startTimeSeconds !== 0 ||
      Number(counted.streams?.[0]?.nb_read_frames) !== frameCount
    )
      throw new MediaError(
        'Render verification failed: unexpected codec, dimensions, frame rate, duration or decoded frame count. Check source decodability and trim ranges.',
      );
    checkRenderSignal(options.signal);
    try {
      if (options.overwrite) {
        const destination = await lstat(path).catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return null;
          throw error;
        });
        if (destination && !destination.isFile())
          throw new MediaError(
            `Refusing to overwrite non-regular output '${path}'.`,
          );
        checkRenderSignal(options.signal);
        // Same-filesystem rename replaces a complete file atomically.
        await rename(rendered, path);
      } else await link(rendered, path);
    } catch (cause) {
      if (cause instanceof MediaError) throw cause;
      throw new MediaError(
        cause instanceof Error && 'code' in cause && cause.code === 'EEXIST'
          ? `Refusing to overwrite existing output '${path}'.`
          : `Cannot publish render '${path}'; check destination permissions and filesystem support for ${options.overwrite ? 'atomic rename' : 'hard links'}.`,
        { cause },
      );
    }
    return {
      path,
      quality,
      codec,
      resolution,
      width: outputWidth,
      height: outputHeight,
      frameRate,
      frameCount,
      durationSeconds,
      metadata: { ...metadata, path },
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    await scratch.close();
  }
}

/** Lossless frame output from the same RGB compositor used by video exports. */
export async function renderTimelineFrame(options: VideoTimelineOptions) {
  const scratch = renderScratch(options.output, '.opencut-frame-');
  try {
    const prepared = await prepareTimeline(options, true, scratch);
    await scratch.stage(prepared, options.signal);
    const rendered = join(await scratch.open(), 'frame.png');
    await runMediaTool(
      'ffmpeg',
      [...prepared.args, '-update', '1', rendered],
      4 * 1024 * 1024,
      600_000,
      { signal: options.signal },
    );
    const metadata = await probeMedia(rendered, options.signal);
    if (
      metadata.video?.codec !== 'png' ||
      metadata.video.width !== prepared.outputWidth ||
      metadata.video.height !== prepared.outputHeight
    )
      throw new MediaError(
        'Frame verification failed: unexpected PNG dimensions or codec.',
      );
    checkRenderSignal(options.signal);
    await link(rendered, prepared.path).catch((cause: unknown) => {
      throw new MediaError(
        `Cannot publish frame '${prepared.path}'; use a new path in a writable directory.`,
        { cause },
      );
    });
    return {
      path: prepared.path,
      width: prepared.outputWidth,
      height: prepared.outputHeight,
    };
  } finally {
    await scratch.close();
  }
}
