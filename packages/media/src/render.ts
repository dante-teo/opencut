import { prepareProfessionalMix } from './professional-mix.js';
import type { AudioMixCache } from './professional-mix.js';
import type { AudioMixReport } from './audio-mastering.js';
import {
  audioSampleAtFrame,
  buildAudioGraph,
  centeredChannelWarnings,
} from './audio-graph.js';
import type { AudioRenderClip } from './audio-graph.js';
import { decodeStillFrame } from './frame.js';
import {
  canvasColorPattern,
  opaqueCanvasColor,
  visualGeometry,
  sourceColorMatrix,
  usesLayerTransform,
  maximumVisualScale,
} from '@opencut/shared';
import type {
  RenderTimeMapping,
  ProfessionalMix,
  TextLayer,
  VisualAnimation,
  TransitionRamp,
} from '@opencut/shared';
import {
  access,
  copyFile,
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
import type { Stats } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import {
  probeMedia,
  isStillImage,
  sameFrameRate,
  videoSourceDuration,
} from './probe.js';
import type { MediaMetadata } from './probe.js';
import { checkRenderSignal, MediaError, runMediaTool } from './process.js';
import {
  findSourceChange,
  sourceIdentity,
  SourceChangedError,
} from './source-integrity.js';
import { accountRenderBytes, accountRenderFile } from './render-budget.js';
import { renderQualities } from '@opencut/shared';
import type { RenderQuality } from '@opencut/shared';
import { renderProgress } from './render-progress.js';
import type { RenderProgress } from './render-progress.js';
import { encoderArguments, selectRenderEncoder } from './render-encoder.js';
import type { RenderEncoder, RenderEncoderReport } from './render-encoder.js';
import {
  orientedSource,
  resolveSourceWindow,
  sourceWindowFilter,
} from './source-window.js';
import { fitVisual, indexedSeekArgs } from './video-filter.js';
import { pictureSeekCheck } from './picture-seek.js';
import { stageTransformLayer } from './transform-layer.js';
import type { GraphicLayer } from './graphics.js';
import {
  describeEncodedPicture,
  inspectPicturePackets,
  PictureTimestampError,
  verifyDeliveryStreamTiming,
  verifyMuxedPictureTiming,
} from './revision-media.js';
import type { TransformLayerOptions } from './transform-layer.js';
import { rasterizeTextLayer } from './text.js';
import {
  cachePicture,
  encodedPictureKey,
  planPictureRanges,
  saveEncodedPicture,
} from './picture-cache.js';
import type { PictureCache, PictureRange } from './picture-cache.js';
import { prepareMusicComparison } from './music-comparison.js';
import type { MusicLoudnessReport } from './music-comparison.js';

import {
  boundPictureInputs,
  maxPictureInputs,
  selectPictureInputs,
} from './bounded-picture.js';
import { maxRenderedSubtitleCues, maxTimelineClips } from '@opencut/shared';
import { compositeGroup, transparentGroupSurface } from './visual-group.js';
import type { GroupSurfaces } from './visual-group.js';
import type { VisualGroup } from '@opencut/shared';

interface VisualTimelineProperties {
  trackId?: string;
  sourceWindow?: import('@opencut/shared').SourceWindow;
  crop?: NonNullable<import('@opencut/shared').VisualTransform['crop']>;
  grade?: import('@opencut/shared').ColorGrade;
  clipId: string;
  timelineStartFrame: number;
  sourceStartFrame: number;
  frameCount: number;
  retiming?: RenderTimeMapping & {
    sourceOriginNs: number;
    localSourceOriginNs?: number;
  };
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
        graphic?: GraphicLayer;
        text?: never;
        subtitle?: never;
        subtitleCueId?: never;
      }
    | {
        text: TextLayer;
        path?: never;
        graphic?: never;
        subtitle?: true;
        subtitleCueId?: string;
      }
  );

type TransitionLayer = Extract<VisualTimelineClip, { path: string }> & {
  ramp: TransitionRamp;
};
interface VisualTransition {
  afterClipId: string;
  layers: TransitionLayer[];
}

export const renderResolutions = ['project', '720p', '1080p'] as const;
export const renderCodecs = ['h264', 'hevc'] as const;
export type RenderCodec = (typeof renderCodecs)[number];
export type RenderResolution = (typeof renderResolutions)[number];
const maxDeliveryPixels = 2880 * 3840;
const pictureColor = {
  colorRange: 'tv',
  colorSpace: 'bt709',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
} as const;
/** Composition surfaces are full-range RGB. Convert once before caching or delivery. */
const deliveryColorFilter =
  'format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
const deliveryColorArgs = [
  '-color_range',
  pictureColor.colorRange,
  '-colorspace',
  pictureColor.colorSpace,
  '-color_primaries',
  pictureColor.colorPrimaries,
  '-color_trc',
  pictureColor.colorTransfer,
];
export interface RenderControls {
  /** Trim the finished composition on the project grid; end is exclusive. */
  range?: { startFrame: number; endFrame: number } | undefined;
  /** Preview-only downscale of the finished canvas, never individual layers. */
  maxDimension?: number | undefined;
  codec?: RenderCodec | undefined;
  encoder?: RenderEncoder | undefined;
  /** Resample the finished composition; source selection stays on the project grid. */
  outputFrameRate?: { numerator: number; denominator: number } | undefined;
  quality?: RenderQuality | undefined;
  resolution?: RenderResolution | undefined;
  outputSize?: { width: number; height: number } | undefined;
  videoBitrateKbps?: number | undefined;
  keyframeInterval?: number | undefined;
  audioBitrateKbps?: number | undefined;
  audioSampleRate?: 44100 | 48000 | undefined;
  audioChannels?: 1 | 2 | undefined;
  audioComparison?: 'before' | 'after' | undefined;
  overwrite?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (progress: RenderProgress) => void;
}

export interface VideoTimelineOptions extends RenderControls {
  /** Preflight-verified picture on the exact output time grid. */
  pictureFrom?:
    | {
        path: string;
        identity: string;
        packetHash: string;
        timingHash: string;
      }
    | undefined;
  /** Serialize build provenance in a custom MP4 format tag. */
  buildMetadata?: string;
  pictureCache?: PictureCache | undefined;
  pictureVersion?: string | undefined;
  /** Parent for private scratch on the destination filesystem. */
  scratchDirectory?: string;
  /** Record a verified file before publication so a caller can reconcile a crash. */
  onVerifiedOutput?: (
    staged: string,
    encodedPicture?: ReturnType<typeof describeEncodedPicture>,
  ) => Promise<void>;
  /** Metadata already probed for this render invocation, indexed by resolved source path. */
  sourceMetadata?: ReadonlyMap<string, MediaMetadata>;
  /** Identity associated with the compiled metadata, when the host supplies it. */
  boundSourceIdentity?: (sourcePath: string) => string | undefined;
  /** Stage inputs on first decode. For a ranged preview, omit visual layers outside that range. */
  snapshotSource?: (sourcePath: string, stage?: string) => Promise<string>;
  /** Allow a desktop host to do text shaping off its main thread. */
  rasterizeText?: typeof rasterizeTextLayer;
  renderGraphic?: (
    clip: Extract<VisualTimelineClip, { path: string }> & {
      graphic: GraphicLayer;
    },
    frame: number,
    signal?: AbortSignal,
    onCacheHit?: () => void,
  ) => Promise<Buffer>;
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  backgroundColor?: string;
  visualClips?: VisualTimelineClip[];
  visualGroups?: readonly VisualGroup[];
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
  audioClips?: AudioRenderClip[];
  professionalMix?: ProfessionalMix;
  musicComparison?: {
    candidates: string[];
    selected: string;
    matchLoudness: boolean;
  };
  audioMixCache?: AudioMixCache;
  output: string;
}

export interface VideoTimelineResult {
  codec: RenderCodec;
  encoder: RenderEncoderReport;
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
  pictureRanges?: PictureRange[];
  pictureFrameRate?: VideoTimelineOptions['frameRate'];
  pictureStartFrame?: number;
  pictureVersion?: { id: string; status: 'saved' | 'reused' };
  pictureReuse?: {
    baseline: string;
    packetHash: string;
    pictureFramesRendered: 0;
  };
  audioMix?: AudioMixReport;
  musicLoudness?: MusicLoudnessReport;
  audioChannelRouting?: {
    centeredTracks: string[];
    comparison: 'before' | 'after';
    outputChannels: 1 | 2;
  };
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
      (options.visualClips.filter((clip) => !clip.subtitle).length >
        maxTimelineClips ||
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
                !validSourceOrigin(clip.retiming))) ||
            !Number.isSafeInteger(clip.sourceStartFrame + clip.frameCount) ||
            !Number.isSafeInteger(clip.timelineStartFrame + clip.frameCount) ||
            clip.timelineStartFrame + clip.frameCount > frameCount ||
            (clip.sourceWindow !== undefined &&
              (clip.fit === undefined || !!clip.text || !!clip.graphic)) ||
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
    (options.audioClips?.length ?? 0) > maxTimelineClips ||
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
        (clip.channelMode !== undefined &&
          clip.channelMode !== 'mono-center') ||
        !validAudioFades(clip, numerator, denominator),
    )
  )
    throw new MediaError(
      'Invalid video render plan: use positive integer frame counts, even sides up to 3840 (at most 3840x2160 pixels), 1–120 fps, at most 128 non-subtitle visual or audio clips (or 128 legacy segments), valid transforms and #RRGGBB[AA]/transparent background, and 600 seconds.',
    );
}

type Rational = RenderTimeMapping['sourceIn'];

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

function validSourceOrigin(
  retiming: NonNullable<VisualTimelineClip['retiming']>,
) {
  return (
    Number.isInteger(retiming.sourceOriginNs) &&
    (retiming.localSourceOriginNs === undefined ||
      Number.isInteger(retiming.localSourceOriginNs))
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

interface StagedInput {
  filename: string;
  argumentIndex: number;
  write: (destination: string) => Promise<void>;
}

type HeldFrame = { path: string; width: number; height: number };

export function validateSubtitleBurnIn(
  clips: readonly Pick<
    VisualTimelineClip,
    'subtitle' | 'subtitleCueId' | 'clipId'
  >[],
) {
  const ids = new Set<string>();
  for (const clip of clips) {
    if (clip.subtitle) ids.add(clip.subtitleCueId ?? clip.clipId);
    if (ids.size > maxRenderedSubtitleCues)
      throw new MediaError(
        `Burn-in supports up to ${maxRenderedSubtitleCues} visible subtitle cues per render. Shorten the render range or export a sidecar.`,
      );
  }
}

async function existingOutput(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
}

async function protectSourceFiles(
  options: VideoTimelineOptions,
  destination: Stats | null,
  cachedPicture?: string,
) {
  if (!options.overwrite || !destination) return;
  const paths = new Set<string>();
  if (cachedPicture) paths.add(cachedPicture);
  for (const clip of options.visualClips ?? options.segments ?? [])
    if ('path' in clip && clip.path) paths.add(clip.path);
  for (const transition of options.visualTransitions ?? [])
    for (const layer of transition.layers) paths.add(layer.path);
  for (const clip of options.audioClips ?? []) paths.add(clip.path);
  for (const path of paths) {
    checkRenderSignal(options.signal);
    const source = await stat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    });
    if (source?.dev === destination.dev && source.ino === destination.ino)
      throw new MediaError(
        `Render output must not replace source media '${path}'.`,
      );
  }
}

export interface TimelinePlan {
  ranges: {
    startFrame: number;
    endFrame: number;
    key?: string;
    pending?: string[];
  }[];
  savedKey: string | undefined;
  textRasterKeys: ReadonlyMap<string, string>;
  requiresFfv1: boolean;
  encoder: RenderEncoderReport;
  outputWidth: number;
  outputHeight: number;
  outputFrameCount: number;
  durationSeconds: number;
  warnings: string[];
}

interface TimelineInspection {
  cache?: Pick<PictureCache, 'backend' | 'sourceIdentity'> | undefined;
  pendingSources: ReadonlyMap<string, string>;
}

/** Prepare filters and stage unique held frames when executing a render. */
async function prepareTimeline(
  options: VideoTimelineOptions,
  mode: 'mp4' | 'png' | 'picture' = 'mp4',
  scratch?: ReturnType<typeof renderScratch>,
  checkPictureSeek?: ReturnType<typeof pictureSeekCheck>,
  onPictureRange?: (endFrame: number) => void,
  inspect?: TimelineInspection,
) {
  const png = mode === 'png';
  checkRenderSignal(options.signal);
  validateOptions(options);
  const codec = options.codec ?? 'h264';
  const quality = options.quality ?? 'quality';
  const resolution = options.resolution ?? 'project';
  if (
    !renderCodecs.includes(codec) ||
    !renderQualities.includes(quality) ||
    !renderResolutions.includes(resolution)
  )
    throw new MediaError('Unknown render codec, quality or resolution preset.');
  const { width, height, frameRate, frameCount } = options;
  const { outputSize, videoBitrateKbps, keyframeInterval } = options;
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
      outputSize.width * outputSize.height > maxDeliveryPixels)
  )
    throw new MediaError(
      'Custom dimensions must be even, 2–3840 per side, within 2880×3840 total pixels, and use project resolution mode.',
    );
  if (
    keyframeInterval !== undefined &&
    (!Number.isSafeInteger(keyframeInterval) ||
      keyframeInterval < 1 ||
      keyframeInterval > 10000)
  )
    throw new MediaError('Keyframe interval must be 1–10000 frames.');
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
  const rangeFrameCount = endFrame - startFrame;
  if (png && rangeFrameCount !== 1)
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
    BigInt(rangeFrameCount) *
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
  const existing = await existingOutput(path);
  if (existing && (!options.overwrite || !existing.isFile()))
    throw new MediaError(
      `Refusing to overwrite existing output '${path}'. Use --overwrite for a regular file.`,
    );
  await protectSourceFiles(options, existing);
  try {
    if (!(await stat(dirname(path))).isDirectory())
      throw new Error('Not a directory');
    await access(
      dirname(path),
      inspect ? constants.X_OK : constants.W_OK | constants.X_OK,
    );
  } catch (cause) {
    throw new MediaError(
      inspect
        ? 'Cannot inspect render output; use an existing directory.'
        : 'Cannot create render output; use an existing writable directory.',
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
  if (outputSize && (outputWidth > width || outputHeight > height))
    warnings.push(
      `Delivery scales the ${width}×${height} composed picture to ${outputWidth}×${outputHeight} with FFmpeg. AI super-resolution only applies to sources with an explicit recipe.`,
    );
  const stagedInputs: StagedInput[] = [];
  const encoder =
    mode === 'mp4'
      ? await selectRenderEncoder(
          options.encoder,
          {
            codec,
            quality,
            width: outputWidth,
            height: outputHeight,
            rate: outputRate,
            bitrate: videoBitrateKbps,
            keyframeInterval,
          },
          options.signal,
        )
      : undefined;
  const external = mode === 'mp4' && options.pictureFrom;
  const encoders = new Set(
    encoder ? (external ? ['aac'] : [encoder.name, 'aac']) : [],
  );
  const prepared = {
    args,
    path,
    quality,
    resolution,
    codec,
    encoder,
    outputWidth,
    outputHeight,
    frameRate: outputRate,
    frameCount: outputFrameCount,
    durationSeconds,
    warnings,
    stagedInputs,
    encoders,
    timelinePlan: undefined as TimelinePlan | undefined,
    pictureRanges: undefined as PictureRange[] | undefined,
    sourcePicture: undefined as
      | (NonNullable<VideoTimelineResult['pictureVersion']> & { path: string })
      | undefined,
    externalPicturePath: undefined as string | undefined,
    savePicture: undefined as
      { key: string; cache: NonNullable<PictureCache['encoded']> } | undefined,
    audioMix: undefined as AudioMixReport | undefined,
    musicLoudness: undefined as MusicLoudnessReport | undefined,
  };
  const filters: string[] = [];
  const sources = new Map(options.sourceMetadata);
  const reportedSources = new Set<string>();
  const inputPathFor = (path: string) => options.snapshotSource?.(path) ?? path;
  const inputs = new Map<string, number>();
  const readSource = async (clip: { path: string; clipId: string }) => {
    checkRenderSignal(options.signal);
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
    if (source.diagnostic && !reportedSources.has(clip.path)) {
      warnings.push(`Media probe for '${clip.path}': ${source.diagnostic}.`);
      reportedSources.add(clip.path);
    }
    return source;
  };
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
          (layer.retiming &&
            (!validRetiming(layer.retiming) ||
              !validSourceOrigin(layer.retiming))) ||
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
  let input = 0;
  const inputStart = args.length;
  const registerInput = (filename: string, write: StagedInput['write']) => {
    const argumentIndex = args.push('-threads', '1', '-i', filename) - 1;
    stagedInputs.push({ filename, argumentIndex, write });
    return input++;
  };
  const overlapsRange = (clip: VisualTimelineClip) =>
    clip.timelineStartFrame < endFrame &&
    clip.timelineStartFrame + clip.frameCount > startFrame;
  const visibleClips = visualClips.filter(
    (clip) => !clip.subtitle || overlapsRange(clip),
  );
  validateSubtitleBurnIn(visibleClips);
  const bounded = boundPictureInputs(visibleClips, transitions, {
    startFrame,
    endFrame,
  });
  let scratchBytes = 0;
  let segmentId = 0;
  const pictureScratch = mode === 'mp4' && !external ? scratch : undefined;
  const temporaryPictureCache: PictureCache | undefined =
    pictureScratch && bounded.length > 1 && !options.pictureCache
      ? {
          backend: 'ffv1-bounded',
          sourceIdentity() {
            throw new MediaError(
              'Temporary picture ranges do not need source hashing.',
            );
          },
          async materialize(_key, encode) {
            const directory = await pictureScratch.open();
            const path = join(directory, `picture-${segmentId++}.mkv`);
            await encode(path);
            scratchBytes += (await stat(path)).size;
            await accountRenderFile(path);
            if (scratchBytes > 8 * 1024 * 1024 * 1024)
              throw new MediaError(
                'Temporary picture ranges exceeded 8 GiB. Render a shorter range.',
              );
            return { path, reused: false };
          },
        }
      : undefined;
  const pictureCache = pictureScratch
    ? (options.pictureCache ?? temporaryPictureCache)
    : undefined;
  const pictureVersion = mode === 'mp4' ? options.pictureVersion : undefined;
  const encodedCache = options.pictureCache?.encoded;
  if (external && pictureVersion)
    throw new MediaError('Choose one picture source for a render.');
  if (
    pictureVersion !== undefined &&
    (!(encodedCache || inspect?.cache) ||
      (pictureVersion !== 'save' &&
        !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(pictureVersion)))
  )
    throw new MediaError(
      'Use a picture cache and select `save` or a saved picture version ID.',
    );
  if (options.pictureCache) encoders.add('ffv1');
  if (!pictureCache && !external)
    filters.push(
      `color=c=${opaqueCanvasColor(options.backgroundColor ?? '#000000')}:s=${width}x${height}:r=${rate},` +
        `format=rgba,trim=end_frame=${rangeFrameCount},settb=1/${numerator},setpts=(N+${startFrame})*${denominator}[canvas0]`,
    );
  const heldFrames = new Map<string, HeldFrame>();
  const framesync = 'eof_action=pass:repeatlast=0';
  const holdLastFrame = 'repeatlast=1';
  const transformsLayer = (clip: VisualTimelineClip) =>
    !!(clip.grade || clip.crop) ||
    usesLayerTransform(clip.rotation, !!clip.animation);
  const rasterize = (
    clip: VisualTimelineClip & { text: TextLayer },
    transformed = transformsLayer(clip),
  ) =>
    (options.rasterizeText ?? rasterizeTextLayer)(
      width,
      height,
      clip.text,
      clip,
      options.signal,
      transformed,
    );
  const planCachedPicture = (
    cache: Pick<PictureCache, 'backend' | 'sourceIdentity'>,
    textRasterKeys?: Map<string, string>,
  ) =>
    planPictureRanges({
      options,
      cache,
      visualClips: visibleClips,
      byOwner,
      startFrame,
      endFrame,
      outputWidth,
      outputHeight,
      warnings,
      ...(textRasterKeys && { textRasterKeys }),
      rasterize,
      ...(inspect && { pendingSources: inspect.pendingSources }),
    });
  const pictureVersionKey = (
    planned: Awaited<ReturnType<typeof planPictureRanges>>,
  ) =>
    encodedPictureKey(planned, [
      codec,
      encoder!.name,
      encoder!.settings,
      outputRate,
      options.outputFrameRate !== undefined,
      outputFrameCount,
    ]);
  if (inspect) {
    const textRasterKeys = new Map<string, string>();
    const cached = inspect.cache
      ? await planCachedPicture(inspect.cache, textRasterKeys)
      : undefined;
    const ranges =
      cached ?? (bounded.length > 1 ? bounded : [{ startFrame, endFrame }]);
    const savedKey =
      cached && !cached.some((range) => range.pending)
        ? pictureVersionKey(cached)
        : undefined;
    // A configured cache needs FFV1 only for misses, which core resolves.
    // Uncached renders use it for staging layer transforms and bounded stacks.
    let requiresFfv1 = false;
    if (!cached) {
      requiresFfv1 =
        bounded.length > 0 ||
        transitions.some(({ layers }) => overlapsRange(layers[0]!));
      for (const clip of visibleClips) {
        if (requiresFfv1) break;
        if (!overlapsRange(clip)) continue;
        requiresFfv1 =
          !!clip.graphic ||
          (transformsLayer(clip) &&
            (!clip.text || !!(await rasterize(clip)).png));
      }
    }
    prepared.timelinePlan = {
      ranges,
      savedKey,
      textRasterKeys,
      requiresFfv1,
      encoder: encoder!,
      outputWidth,
      outputHeight,
      outputFrameCount,
      durationSeconds,
      warnings,
    };
    return prepared;
  }
  const prepareLayer = async (
    clip: VisualTimelineClip,
    label: string,
    scratchName: string,
    ramp?: TransitionRamp,
  ) => {
    const transformed = !!ramp || transformsLayer(clip);
    const first = Math.max(startFrame, clip.timelineStartFrame);
    const last = Math.min(endFrame, clip.timelineStartFrame + clip.frameCount);
    // Direct callers also validate off-range clips. Keep their full source
    // window for preflight, even though the overlay gate excludes them.
    const inRange = first < last;
    const layerStart = inRange ? first : clip.timelineStartFrame;
    const layerFrames = inRange ? last - first : clip.frameCount;
    const transform = (source: TransformLayerOptions['source']) => {
      if (!inRange) return;
      encoders.add('ffv1');
      const hold =
        !ramp &&
        !clip.animation &&
        (source.kind === 'text' ||
          (source.kind === 'media' && !source.sampling) ||
          (source.kind === 'graphic' && source.still));
      const layerInput = registerInput(
        `${scratchName}.nut`,
        async (destination) => {
          const captureFrames = hold ? 1 : layerFrames;
          let cacheHits = 0;
          let captured = 0;
          const graphicProgress =
            source.kind === 'graphic' && options.onProgress
              ? renderProgress(
                  captureFrames,
                  options.onProgress,
                  {
                    stage: 'graphics',
                    clipId: clip.clipId,
                    detail: source.still
                      ? 'graphic-rasterization'
                      : 'browser-capture',
                  },
                  () => cacheHits,
                )
              : undefined;
          const intermediateProgress =
            graphicProgress &&
            renderProgress(captureFrames, options.onProgress, {
              stage: 'graphics',
              detail: 'intermediate-writing',
              clipId: clip.clipId,
            });
          const input =
            source.kind === 'graphic' && graphicProgress
              ? {
                  ...source,
                  async rasterize(frame: number, signal: AbortSignal) {
                    const raster = await source.rasterize(
                      frame,
                      signal,
                      () => cacheHits++,
                    );
                    graphicProgress?.update(++captured);
                    return raster;
                  },
                }
              : source;
          graphicProgress?.start();
          intermediateProgress?.start();
          await stageTransformLayer(
            {
              width,
              height,
              rate: frameRate,
              startFrame: layerStart,
              frameCount: captureFrames,
              visual: clip,
              ...(clip.grade && { grade: clip.grade }),
              source: input,
              ...(intermediateProgress && {
                onIntermediateProgress: intermediateProgress.chunk,
              }),
              ...(clip.animation && { animation: clip.animation }),
              ...(ramp && { ramp }),
              signal: options.signal,
            },
            destination,
          );
          await accountRenderFile(destination);
        },
      );
      filters.push(
        `[${layerInput}:v]format=rgba,settb=1/${numerator},setpts=(N+${layerStart})*${denominator}[${label}]`,
      );
      return { x: 0, y: 0, sync: hold ? holdLastFrame : framesync };
    };
    if (clip.text) {
      checkRenderSignal(options.signal);
      const { x, y, png, warning } = await rasterize(clip, transformed);
      checkRenderSignal(options.signal);
      if (warning) warnings.push(`Clip '${clip.clipId}': ${warning}`);
      if (!png) return;
      // Let the text raster cache own the bytes between preparation and staging.
      const readRaster = async () => {
        const { png } = await rasterize(clip, transformed);
        if (!png)
          throw new MediaError(
            `Clip '${clip.clipId}' lost its text raster during export.`,
          );
        return png;
      };
      if (transformed)
        return transform({ kind: 'text', rasterize: readRaster, x, y });
      const textInput = registerInput(`${label}.png`, async (destination) => {
        const png = await readRaster();
        accountRenderBytes(png.length);
        await writeFile(destination, png, {
          flag: 'wx',
          signal: options.signal,
        });
      });
      // Hold the static image from time zero and gate it to the clip interval.
      filters.push(
        `[${textInput}:v]format=rgba,settb=1/${numerator},setpts=0[${label}]`,
      );
      return { x, y, sync: holdLastFrame };
    }
    const { graphic } = clip;
    if (graphic) {
      const { width, height, durationFrames } = graphic;
      const sourceClip = { ...clip, graphic };
      return transform({
        kind: 'graphic',
        aspect: width / height,
        still: durationFrames === undefined,
        rasterize(frame, signal, onCacheHit) {
          if (!options.renderGraphic)
            throw new MediaError(
              `Clip '${clip.clipId}' requires an OpenCut graphics renderer.`,
            );
          return options.renderGraphic(sourceClip, frame, signal, onCacheHit);
        },
      });
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
    if (ramp && !still && !clip.retiming)
      throw new MediaError(
        `Transition clip '${clip.clipId}' requires timed source mapping for video. Re-import the source if a photo has been replaced with a video.`,
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
      const frozenSource = await inputPathFor(source.path);
      const inputStart = source.startTimeSeconds ?? 0;
      const timestamp =
        seconds(freeze) + ((video.startTimeSeconds ?? inputStart) - inputStart);
      const key = JSON.stringify([
        await realpath(frozenSource),
        video.index,
        timestamp,
        !!clip.sourceWindow,
      ]);
      held = heldFrames.get(key);
      if (!held) {
        const bytes = await decodeStillFrame(
          { ...source, path: frozenSource },
          timestamp,
          true,
          options.signal,
          !!clip.sourceWindow,
        );
        // Preflight checks decoding and geometry without creating files.
        const path = scratch
          ? join(await scratch.open(), `freeze-${heldFrames.size}.png`)
          : `freeze-${heldFrames.size}.png`;
        if (scratch) {
          accountRenderBytes(bytes.length);
          await writeFile(path, bytes, { flag: 'wx', signal: options.signal });
        }
        held = {
          path,
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
        };
        heldFrames.set(key, held);
      }
    }
    const oriented = orientedSource(video);
    const physical = held
      ? { ...held, sar: clip.sourceWindow ? oriented.sar : 1 }
      : {
          width: oriented.width || width,
          height: oriented.height || height,
          sar: oriented.sar,
        };
    const region = resolveSourceWindow(
      physical,
      clip.clipId,
      clip.sourceWindow,
    );
    const displayWidth = region.width * physical.sar;
    const displayHeight = region.height;
    const stream = held ? 0 : video.index;
    // Follow the same RGB conversion as the existing media pipeline.
    const matrix = held
      ? sourceColorMatrix(null, physical.width, physical.height, 'png')
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
    const clipOffset = layerStart - clip.timelineStartFrame;
    const sourceFirst = clip.sourceStartFrame + clipOffset;
    const { retiming } = clip;
    // Keep preroll timestamps so indexed and sequential decoding sample the
    // same source frame even across variable-frame-rate gaps.
    const candidateSeekFrame =
      (png || transformed || checkPictureSeek) &&
      !still &&
      !retiming &&
      inRange &&
      source.startTimeSeconds === 0 &&
      video.startTimeSeconds === 0 &&
      /\.(mp4|mov)$/i.test(source.path)
        ? Math.max(0, sourceFirst - Math.ceil((2 * numerator) / denominator))
        : 0;
    const inputPath = held?.path ?? (await inputPathFor(source.path));
    const seekSeconds = (candidateSeekFrame * denominator) / numerator;
    const useIndexedSeek =
      candidateSeekFrame > 0 &&
      (!checkPictureSeek ||
        (await checkPictureSeek(
          inputPath,
          stream,
          seekSeconds,
          sourceFirst,
          frameRate,
        )));
    const frameSampling = (indexed = false) =>
      `fps=${rate}${indexed ? '' : ':start_time=0'}:round=${retiming ? 'near' : 'up'}:eof_action=pass,tpad=stop_mode=clone:stop=1`;
    const sequentialSampling = `setpts=PTS-STARTPTS,${frameSampling()},trim=start_frame=${sourceFirst}:end_frame=${sourceFirst + layerFrames}`;
    let sampling: string;
    if (still) {
      sampling = 'trim=end_frame=1';
    } else if (retiming) {
      // Sample on the project grid before trimming. Two nanoseconds cover
      // PTS rounding and truncation of the shared source origin.
      const frameNs = `(1000000000*${denominator}/${numerator})`;
      const origin = retiming.localSourceOriginNs ?? retiming.sourceOriginNs;
      const start =
        retiming.localSourceOriginNs === undefined
          ? clip.timelineStartFrame
          : 0;
      sampling =
        'setpts=PTS-STARTPTS,settb=1/1000000000,' +
        `setpts=(ceil((PTS-(${origin})-2)*${retiming.speed.denominator}/${retiming.speed.numerator}/${frameNs})-${start})*${frameNs},` +
        `${frameSampling()},trim=start_frame=${clipOffset}:end_frame=${clipOffset + layerFrames}`;
    } else if (useIndexedSeek) {
      sampling = `${frameSampling(true)},trim=start_pts=${sourceFirst}:end_pts=${sourceFirst + layerFrames}`;
    } else {
      sampling = sequentialSampling;
    }
    if (transformed) {
      return transform({
        kind: 'media',
        path: inputPath,
        stream,
        width: region.width,
        height: region.height,
        aspect: displayWidth / displayHeight,
        matrix,
        ...(clip.sourceWindow && { window: clip.sourceWindow }),
        ...(!still && {
          sampling: {
            filter: sampling,
            ...(useIndexedSeek && {
              seek: {
                seconds: seekSeconds,
                fallbackFilter: sequentialSampling,
              },
            }),
          },
        }),
      });
    }
    const geometry = visualGeometry(
      width,
      height,
      displayWidth,
      displayHeight,
      clip,
    );
    if (useIndexedSeek && !args.includes('-copyts')) args.push('-copyts');
    args.push(
      '-threads',
      '1',
      ...(useIndexedSeek ? indexedSeekArgs(seekSeconds) : []),
      '-i',
      inputPath,
    );
    if (!held) inputs.set(clip.clipId, input);
    filters.push(
      `[${input++}:${stream}]${sampling},` +
        (clip.sourceWindow
          ? sourceWindowFilter(clip.sourceWindow, matrix) + ','
          : '') +
        `${fitVisual(geometry, matrix)},format=rgba,` +
        ((clip.opacity ?? 1) === 1 ? '' : `lut=a=val*${clip.opacity},`) +
        `settb=1/${numerator},setpts=(N+${layerStart})*${denominator}[${label}]`,
    );
    // A fitted still has identical pixels throughout its gated interval.
    return {
      x: geometry.x,
      y: geometry.y,
      sync: still ? holdLastFrame : framesync,
    };
  };

  // Overlay counts from zero while its input timestamps use project time.
  const enabled = (start: number, end: number) =>
    `gte(n,${start - startFrame})*lt(n,${end - startFrame})`;
  let canvas = 'canvas0';
  let canvasId = 0;
  const clock = { start: startFrame, end: endFrame, numerator, denominator };
  const groups = new Map(
    options.visualGroups?.flatMap((style, id) =>
      style.tracks.map((track) => [track, { style, id }] as const),
    ),
  );
  let group: GroupSurfaces | undefined;
  function completeGroup() {
    if (!group) return;
    canvas = compositeGroup(filters, group, width, height, clock);
    group = undefined;
  }
  function groupSurface(
    requested: { style: VisualGroup; id: number },
    trackId: string | undefined,
  ) {
    if (!group) {
      const { style, id } = requested;
      const content = `group${id}content`;
      const matte = style.matte ? `group${id}matte` : undefined;
      filters.push(transparentGroupSurface(content, width, height, clock));
      if (matte)
        filters.push(transparentGroupSurface(matte, width, height, clock));
      group = { style, id, backdrop: canvas, content, matte };
    }
    canvas = trackId === group.style.matte ? group.matte! : group.content;
  }
  const overlay = (
    label: string,
    { x, y, sync }: { x: number; y: number; sync: string },
    gate: string,
  ) => {
    const next = `canvas${++canvasId}`;
    filters.push(
      `[${canvas}][${label}]overlay=x=${x}:y=${y}:${sync}:format=rgb:alpha=straight:enable='${gate}'[${next}]`,
    );
    canvas = next;
  };
  // Save the fully composited backdrop before bringing in another batch of
  // sources. RGB FFV1 preserves the canvas through subsequent blends and mattes.
  function stageBackdrop() {
    encoders.add('ffv1');
    const pass = {
      args: [
        ...args.slice(0, inputStart),
        ...args.splice(inputStart),
        '-filter_complex_threads',
        '1',
        '-filter_complex',
        [...filters.splice(0), `[${canvas}]format=bgr0[backdrop]`].join(';'),
        '-map',
        '[backdrop]',
        '-an',
        '-c:v',
        'ffv1',
        '-threads',
        '2',
        '-fps_mode',
        'passthrough',
        '-enc_time_base:v',
        `1/${numerator}`,
        '-f',
        'nut',
      ],
      stagedInputs: stagedInputs.splice(0),
    };
    inputs.clear();
    input = 0;
    const backdrop = registerInput('backdrop.nut', async (destination) => {
      const staging = renderScratch(
        options.output,
        '.opencut-stack-',
        options.scratchDirectory,
      );
      try {
        await staging.stage(pass, options.signal);
        await runMediaTool(
          'ffmpeg',
          [...pass.args, destination],
          4 * 1024 * 1024,
          600_000,
          {
            signal: options.signal,
            writesFile: true,
          },
        );
        await accountRenderFile(destination);
      } finally {
        await staging.close();
      }
    });
    canvas = `canvas${++canvasId}`;
    filters.push(
      `[${backdrop}:v]format=rgba,settb=1/${numerator},setpts=(N+${startFrame})*${denominator}[${canvas}]`,
    );
  }
  const inputsFor = (clip: VisualTimelineClip) =>
    Number(!options.snapshotSource || overlapsRange(clip)) +
    (byOwner.get(clip.clipId) ?? []).reduce((count, { layers }) => {
      const { startFrame: from, endFrame: to } = layers[0]!.ramp;
      return from < endFrame && startFrame < to ? count + layers.length : count;
    }, 0);
  const inlineClips = pictureCache || external ? [] : visibleClips;
  const groupInputs = new Map<number, number>();
  for (const clip of groups.size ? inlineClips : []) {
    const id = groups.get(clip.trackId ?? '')?.id;
    if (id !== undefined)
      groupInputs.set(id, (groupInputs.get(id) ?? 0) + inputsFor(clip));
  }
  for (const [index, clip] of inlineClips.entries()) {
    const requested = groups.get(clip.trackId ?? '');
    if (group && group.id !== requested?.id) completeGroup();
    if (
      !group &&
      input > 1 &&
      input + (requested ? groupInputs.get(requested.id)! : inputsFor(clip)) >
        maxPictureInputs
    ) {
      if (scratch) stageBackdrop();
      else encoders.add('ffv1');
    }
    if (requested) groupSurface(requested, clip.trackId);
    const label = `layer${index}`;
    // A transition can contribute even when its owner's base clip is off-range.
    const placement =
      !options.snapshotSource || overlapsRange(clip)
        ? await prepareLayer(clip, label, `layer-${index}`)
        : undefined;
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
    if (group) {
      if (clip.trackId === group.style.matte) group.matte = canvas;
      else group.content = canvas;
    }
  }
  completeGroup();
  const scale = `scale=${outputWidth}:${outputHeight}`;
  let picture =
    `[${canvas}]settb=1/${numerator},setpts=N*${denominator},` +
    (png
      ? `${scale},setsar=1,format=rgb24`
      : `${scale}:in_range=pc:out_range=tv:out_color_matrix=bt709,setsar=1,${deliveryColorFilter}`);
  let videoMap = '[video]';
  if (external && scratch) {
    await protectSourceFiles(options, existing, external.path);
    const check = () => {
      const current = sourceIdentity(external.path);
      if (current !== external.identity)
        throw new SourceChangedError(
          external.path,
          'picture reuse',
          external.identity,
          current,
        );
    };
    check();
    const snapshot = join(await scratch.open(), 'external-picture.mp4');
    await copyFile(
      external.path,
      snapshot,
      constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    );
    check();
    await accountRenderFile(snapshot);
    prepared.externalPicturePath = snapshot;
    prepared.sourcePicture = {
      id: external.packetHash,
      path: external.path,
      status: 'reused',
    };
    prepared.pictureRanges = [{ startFrame, endFrame, status: 'reused' }];
    args.push('-i', snapshot);
    videoMap = `${input++}:v:0`;
  }
  if (pictureCache) {
    const planned = temporaryPictureCache
      ? bounded.map((range, index) => ({ ...range, key: String(index) }))
      : await planCachedPicture(pictureCache);
    if (pictureVersion && encodedCache) {
      const key = pictureVersionKey(planned);
      if (pictureVersion === 'save')
        prepared.savePicture = { key, cache: encodedCache };
      else {
        if (!pictureVersion.startsWith(`${key}.`))
          throw new MediaError(
            'Picture or video export settings changed. Rebuild the picture with --picture-version save.',
          );
        const cached = await encodedCache.find(pictureVersion);
        if (!cached)
          throw new MediaError(
            'Saved picture is missing or corrupt. Use the original picture cache or rebuild with --picture-version save.',
          );
        await protectSourceFiles(options, existing, cached);
        prepared.sourcePicture = {
          id: pictureVersion,
          path: cached,
          status: 'reused',
        };
        prepared.pictureRanges = planned.map(({ startFrame, endFrame }) => ({
          startFrame,
          endFrame,
          status: 'reused',
        }));
        onPictureRange?.(endFrame);
        args.push('-i', cached);
        videoMap = `${input++}:v:0`;
      }
    }
    if (!prepared.sourcePicture) {
      const segmentOptions = { ...options };
      delete segmentOptions.segments;
      const checkSeek = pictureSeekCheck(options.signal);
      const persisted: PictureRange[] = [];
      const { concat, ranges } = await cachePicture(
        planned,
        pictureCache,
        frameRate,
        options.signal,
        async (startFrame, endFrame, destination) => {
          const staging = renderScratch(
            options.output,
            '.opencut-picture-',
            options.scratchDirectory,
          );
          try {
            const segment = await prepareTimeline(
              {
                ...segmentOptions,
                ...selectPictureInputs(visualClips, transitions, {
                  startFrame,
                  endFrame,
                }),
                range: { startFrame, endFrame },
                outputFrameRate: undefined,
              },
              'picture',
              staging,
              checkSeek,
            );
            await staging.stage(segment, options.signal);
            await runMediaTool(
              'ffmpeg',
              [...segment.args, destination],
              4 * 1024 * 1024,
              600_000,
              {
                signal: options.signal,
                writesFile: true,
              },
            );
          } finally {
            await staging.close();
          }
        },
        (range) => {
          if (options.pictureCache) persisted.push(range);
          onPictureRange?.(range.endFrame);
        },
      ).catch((error: unknown) => {
        const change = findSourceChange(error);
        if (change && persisted.length)
          change.change.completedPictureRanges = persisted;
        throw error;
      });
      prepared.pictureRanges = ranges;
      args.push('-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file');
      const pictureInput = registerInput('picture.ffconcat', (destination) =>
        writeFile(destination, concat, {
          flag: 'wx',
          signal: options.signal,
        }),
      );
      // Regenerate timestamps and duration on the exact project grid. Matroska
      // rounds each packet duration to milliseconds, including the last frame.
      picture =
        `[${pictureInput}:v]settb=1/${numerator},setpts=N*${denominator},` +
        `fps=${rate}:round=near:eof_action=pass,setsar=1,` +
        deliveryColorFilter;
    }
  }
  if (!prepared.sourcePicture)
    filters.push(
      picture +
        (options.outputFrameRate
          ? `,fps=${outputRate.numerator}/${outputRate.denominator}:round=up:eof_action=pass,tpad=stop_mode=clone:stop=1,trim=end_frame=${outputFrameCount},settb=1/${outputRate.numerator},setpts=N*${outputRate.denominator}`
          : '') +
        '[video]',
    );
  if (mode !== 'mp4') {
    args.push(
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[video]',
    );
    if (png)
      args.push(
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
    else
      args.push(
        '-map_metadata',
        '-1',
        '-an',
        '-c:v',
        'ffv1',
        '-level',
        '3',
        '-threads',
        '2',
        '-fps_mode',
        'passthrough',
        '-enc_time_base:v',
        `1/${numerator}`,
        ...deliveryColorArgs,
        '-f',
        'matroska',
      );
    return prepared;
  }
  const from = audioSampleAtFrame(startFrame, frameRate);
  const to = options.range
    ? from + audioSampleAtFrame(outputFrameCount, outputRate)
    : audioSampleAtFrame(outputFrameCount, outputRate);
  const { professionalMix: mix, snapshotSource } = options;
  const master = scratch && mix && mix.enabled !== false;
  const matchMusic = scratch && options.musicComparison?.matchLoudness;
  const analyzeChannels =
    scratch &&
    options.audioClips?.some(
      ({ channelMode, muted, volume }) =>
        channelMode === 'mono-center' && !muted && volume > 0,
    );
  const analysis =
    master || matchMusic || analyzeChannels
      ? renderProgress(outputFrameCount, options.onProgress, {
          stage: 'audio-analysis',
        })
      : undefined;
  let audioStage = analysis ? 'audio analysis' : 'audio source snapshot';
  const snapshotAudio =
    snapshotSource && ((path: string) => snapshotSource(path, audioStage));
  let audioMap = '[audio]';
  try {
    analysis?.start();
    const music = await prepareMusicComparison(
      { ...options, ...(snapshotAudio && { snapshotSource: snapshotAudio }) },
      readSource,
      matchMusic ? await scratch.open() : undefined,
    );
    prepared.musicLoudness = music.musicLoudness;
    if (music.warnings) warnings.push(...music.warnings);
    if (master) {
      const mastering = renderProgress(outputFrameCount, options.onProgress, {
        stage: 'audio-mastering',
      });
      const result = await prepareProfessionalMix(
        music.options,
        mix,
        await scratch.open(),
        readSource,
        { base: audioSampleAtFrame(frameCount, frameRate), from, to },
        () => {
          analysis?.update(outputFrameCount);
          audioStage = 'audio mastering';
          mastering.start();
        },
      );
      mastering.update(outputFrameCount);
      prepared.audioMix = result.report;
      warnings.push(...result.report.warnings);
      args.push('-i', result.path);
      audioMap = `${input++}:a:0`;
    } else {
      if (scratch)
        warnings.push(
          ...(await centeredChannelWarnings(music.options, readSource)),
        );
      analysis?.update(outputFrameCount);
      audioStage = 'audio source snapshot';
      await buildAudioGraph(
        music.options,
        {
          filters,
          readSource,
          inputPathFor: snapshotAudio ?? inputPathFor,
          openInput: (clip, path) => {
            const existing = inputs.get(clip.clipId);
            if (existing !== undefined) return existing;
            args.push('-threads', '1', '-i', path);
            return input++;
          },
        },
        {
          total: options.range
            ? audioSampleAtFrame(frameCount, frameRate)
            : audioSampleAtFrame(outputFrameCount, outputRate),
          from,
          to: options.range ? audioSampleAtFrame(endFrame, frameRate) : to,
        },
      );
    }
  } catch (error) {
    const change = findSourceChange(error);
    if (change && options.pictureCache && prepared.pictureRanges)
      change.change.completedPictureRanges = prepared.pictureRanges;
    throw error;
  }
  checkRenderSignal(options.signal);
  const metadataInput = options.buildMetadata === undefined ? -1 : input;
  if (options.buildMetadata !== undefined) {
    const escaped = options.buildMetadata.replace(/[\\=;#]/g, '\\$&');
    const bytes = Buffer.from(`;FFMETADATA1\nopencut_build=${escaped}\n`);
    const filename = 'build.ffmetadata';
    args.push('-f', 'ffmetadata', '-i', filename);
    stagedInputs.push({
      filename,
      argumentIndex: args.length - 1,
      async write(destination) {
        accountRenderBytes(bytes.length);
        await writeFile(destination, bytes, {
          flag: 'wx',
          signal: options.signal,
        });
      },
    });
  }
  args.push(
    ...(filters.length
      ? ['-filter_complex_threads', '1', '-filter_complex', filters.join(';')]
      : []),
    '-map',
    videoMap,
    '-map',
    audioMap,
    '-map_metadata',
    String(metadataInput),
    ...(prepared.sourcePicture
      ? ['-c:v', 'copy']
      : [
          ...encoderArguments(encoder!),
          ...(codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
          '-fps_mode',
          'passthrough',
          '-enc_time_base:v',
          `1/${outputRate.numerator}`,
          ...deliveryColorArgs,
        ]),
    '-video_track_timescale',
    String(outputRate.numerator),
    ...(prepared.audioMix
      ? ['-c:a', 'copy']
      : [
          '-c:a',
          'aac',
          '-b:a',
          `${audioBitrateKbps}k`,
          '-ar',
          String(audioSampleRate),
          '-ac',
          String(audioChannels),
        ]),
    '-movflags',
    metadataInput < 0 ? '+faststart' : '+faststart+use_metadata_tags',
    '-f',
    'mp4',
  );
  return prepared;
}

/** Compute the same range keys and encoder settings without staging any media. */
export async function inspectTimelineRender(
  options: VideoTimelineOptions,
  inspection: TimelineInspection,
): Promise<TimelinePlan> {
  const prepared = await prepareTimeline(
    options,
    'mp4',
    undefined,
    undefined,
    undefined,
    inspection,
  );
  return prepared.timelinePlan!;
}

export async function checkRenderEncoders(
  required: Iterable<string>,
  signal?: AbortSignal,
) {
  const listing = (
    await runMediaTool(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-encoders'],
      4 * 1024 * 1024,
      60_000,
      { signal },
    )
  ).toString('utf8');
  const encoders = new Set(
    [...listing.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)].map(
      (match) => match[1],
    ),
  );
  for (const encoder of required) {
    if (!encoders.has(encoder))
      throw new MediaError(
        `Required encoder '${encoder}' is unavailable in this FFmpeg installation.`,
      );
  }
}

/** Validate the composition and required encoders without populating the picture cache. */
export async function validateVideoTimeline(options: VideoTimelineOptions) {
  const prepared = await prepareTimeline(options);
  await checkRenderEncoders(prepared.encoders, options.signal);
  return {
    width: prepared.outputWidth,
    height: prepared.outputHeight,
    frameRate: prepared.frameRate,
    frameCount: prepared.frameCount,
    durationSeconds: prepared.durationSeconds,
    codec: prepared.codec,
    encoder: prepared.encoder!,
  };
}

/** Stage generated overlays beside the temporary output, on the same filesystem. */
function renderScratch(
  output: string,
  prefix: string,
  directory = dirname(resolve(output)),
) {
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
  const scratch = renderScratch(
    options.output,
    '.opencut-render-',
    options.scratchDirectory,
  );
  try {
    checkRenderSignal(options.signal);
    const startFrame = options.range?.startFrame ?? 0;
    const pictureFrames =
      (options.range?.endFrame ?? options.frameCount) - startFrame;
    const composition = options.pictureFrom
      ? undefined
      : renderProgress(Math.max(1, pictureFrames), options.onProgress, {
          stage: 'composition',
        });
    composition?.start();
    const prepared = await prepareTimeline(
      options,
      'mp4',
      scratch,
      undefined,
      composition && ((endFrame) => composition.update(endFrame - startFrame)),
    );
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
    const centeredTracks = [
      ...new Set(
        (options.audioClips ?? [])
          .filter(
            ({ channelMode, muted, volume }) =>
              channelMode === 'mono-center' && !muted && volume > 0,
          )
          .map(({ trackId, clipId }) => trackId ?? clipId),
      ),
    ];
    const rendered = join(await scratch.open(), 'render.mp4');
    args.push(rendered);
    const progress = renderProgress(frameCount, options.onProgress, {
      stage: prepared.sourcePicture ? 'muxing' : 'encoding',
    });
    progress.start();
    checkRenderSignal(options.signal);
    await runMediaTool('ffmpeg', args, 4 * 1024 * 1024, 600_000, {
      signal: options.signal,
      ...(prepared.sourcePicture ? {} : { onStdout: progress.chunk }),
      writesFile: true,
      stage: `encoding ${outputWidth}×${outputHeight} MP4 '${path}' at ${numerator}/${denominator} fps`,
    }).catch((cause: unknown) => {
      if (
        outputWidth * outputHeight > 3840 * 2160 &&
        cause instanceof MediaError &&
        /allocat|memory|SIGKILL|no space|disk budget/i.test(cause.message)
      )
        throw new MediaError(
          `${cause.message} Free memory or disk space, or reduce the export size.`,
          { cause },
        );
      throw cause;
    });
    await accountRenderFile(rendered);
    checkRenderSignal(options.signal);
    progress.update(frameCount);
    if (!prepared.pictureRanges) composition?.update(pictureFrames);
    const verification = renderProgress(frameCount, options.onProgress, {
      stage: 'verification',
    });
    verification.verifying(false);
    const metadata = await probeMedia(rendered, options.signal, {
      stage: 'verifying encoded MP4',
    });
    const video = metadata.video;
    const frameRateRatio = video?.frameRateRatio ?? null;
    const frameRateMatches = sameFrameRate(
      frameRateRatio,
      numerator,
      denominator,
    );
    const actualDuration = metadata.durationSeconds;
    const containerDurationMatches =
      actualDuration !== null &&
      Math.abs(actualDuration - durationSeconds) <= 0.0011;
    if (options.range || options.pictureFrom) {
      verifyDeliveryStreamTiming(metadata, durationSeconds, frameCount);
      if (!frameRateMatches)
        throw new PictureTimestampError({
          field: 'Video frame rate',
          expected: `${numerator}/${denominator}`,
          actual: frameRateRatio,
          unit: 'fps',
        });
      if (!containerDurationMatches)
        throw new PictureTimestampError(
          {
            field: 'Container duration',
            expected: durationSeconds,
            actual: actualDuration,
            unit: 'seconds',
          },
          frameCount - 1,
        );
    }
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
      {
        signal: options.signal,
        stage: `counting decoded frames in '${rendered}'`,
      },
    );
    const counted = JSON.parse(frameProbe.toString('utf8')) as {
      streams?: { nb_read_frames?: string }[];
    };
    if (
      video?.codec !== codec ||
      video.colorRange !== pictureColor.colorRange ||
      video.colorSpace !== pictureColor.colorSpace ||
      video.colorPrimaries !== pictureColor.colorPrimaries ||
      video.colorTransfer !== pictureColor.colorTransfer ||
      metadata.streams.length !== 2 ||
      metadata.audio?.codec !== 'aac' ||
      metadata.audio.sampleRate !== (options.audioSampleRate ?? 48000) ||
      metadata.audio.channels !== (options.audioChannels ?? 2) ||
      metadata.audio.startTimeSeconds !== 0 ||
      metadata.audio.durationSeconds === null ||
      Math.abs(metadata.audio.durationSeconds - durationSeconds) > 0.0011 ||
      video.width !== outputWidth ||
      video.height !== outputHeight ||
      !frameRateMatches ||
      video.durationSeconds === null ||
      Math.abs(video.durationSeconds - durationSeconds) > 0.000002 ||
      !containerDurationMatches ||
      video.startTimeSeconds !== 0 ||
      Number(counted.streams?.[0]?.nb_read_frames) !== frameCount
    )
      throw new MediaError(
        `Render verification failed. Expected ${codec} ${outputWidth}×${outputHeight} BT.709 limited range, ${numerator}/${denominator} fps, ${frameCount} frames and ${durationSeconds}s with AAC ${options.audioSampleRate ?? 48000} Hz /${options.audioChannels ?? 2} channels. ` +
          `Decoded ${video?.codec} ${video?.width}×${video?.height}, ${video?.colorSpace}/${video?.colorPrimaries}/${video?.colorTransfer}/${video?.colorRange}, ${video?.frameRateRatio} fps, ${counted.streams?.[0]?.nb_read_frames} frames, video ${video?.durationSeconds}s, audio ${metadata.audio?.durationSeconds}s ${metadata.audio?.codec} ${metadata.audio?.sampleRate} Hz /${metadata.audio?.channels} channels, container ${metadata.durationSeconds}s. ` +
          'Check source decodability and trim ranges.',
      );
    checkRenderSignal(options.signal);
    let encodedPicture: ReturnType<typeof describeEncodedPicture> | undefined;
    if (options.pictureFrom) {
      const actual = await inspectPicturePackets(rendered, options.signal);
      const timingChanged =
        actual.timingHash !== options.pictureFrom.timingHash;
      if (
        timingChanged ||
        actual.packetHash !== options.pictureFrom.packetHash
      ) {
        if (timingChanged && prepared.externalPicturePath) {
          const expected = await inspectPicturePackets(
            prepared.externalPicturePath,
            options.signal,
          );
          if (expected.timingHash === options.pictureFrom.timingHash)
            verifyMuxedPictureTiming(expected, actual);
        }
        throw new MediaError(
          'Mux changed the encoded video packets or timing.',
        );
      }
      encodedPicture = describeEncodedPicture(actual);
    }
    let picture = prepared.sourcePicture;
    if (prepared.savePicture) {
      const { key, cache } = prepared.savePicture;
      picture = {
        ...(await saveEncodedPicture(
          cache,
          key,
          rendered,
          numerator,
          options.signal,
        )),
        status: 'saved',
      };
    }
    verification.verifying();
    await options.onVerifiedOutput?.(rendered, encodedPicture);
    checkRenderSignal(options.signal);
    try {
      if (options.overwrite) {
        const destination = await existingOutput(path);
        if (destination && !destination.isFile())
          throw new MediaError(
            `Refusing to overwrite non-regular output '${path}'.`,
          );
        await protectSourceFiles(options, destination, picture?.path);
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
      encoder: prepared.encoder!,
      resolution,
      width: outputWidth,
      height: outputHeight,
      frameRate,
      frameCount,
      durationSeconds,
      metadata: { ...metadata, path },
      ...(warnings.length ? { warnings } : {}),
      ...(prepared.pictureRanges && {
        pictureRanges: prepared.pictureRanges,
        pictureFrameRate: options.frameRate,
        pictureStartFrame: startFrame,
      }),
      ...(options.pictureFrom && {
        pictureReuse: {
          baseline: options.pictureFrom.path,
          packetHash: options.pictureFrom.packetHash,
          pictureFramesRendered: 0,
        },
      }),
      ...(picture &&
        !options.pictureFrom && {
          pictureVersion: { id: picture.id, status: picture.status },
        }),
      ...(prepared.audioMix && { audioMix: prepared.audioMix }),
      ...(prepared.musicLoudness && { musicLoudness: prepared.musicLoudness }),
      ...(centeredTracks.length && {
        audioChannelRouting: {
          centeredTracks,
          comparison: options.audioComparison ?? 'after',
          outputChannels: options.audioChannels ?? 2,
        },
      }),
    };
  } finally {
    await scratch.close();
  }
}

/** Analyze and verify a mix without composing or encoding picture. */
export async function analyzeTimelineAudioMix(options: VideoTimelineOptions) {
  validateOptions(options);
  const mix = options.professionalMix;
  if (!mix || mix.enabled === false)
    throw new MediaError('Enable Professional Dialogue Mix before analyzing.');
  const scratch = renderScratch(
    options.output,
    '.opencut-mix-',
    options.scratchDirectory,
  );
  try {
    const base = audioSampleAtFrame(options.frameCount, options.frameRate);
    const sources = new Map(options.sourceMetadata);
    const readSource = async ({ path }: AudioRenderClip) => {
      let metadata = sources.get(path);
      if (!metadata) {
        metadata = await probeMedia(path, options.signal, {
          stage: 'probing audio mix source',
        });
        sources.set(path, metadata);
      }
      return metadata;
    };
    const folder = await scratch.open();
    const music = await prepareMusicComparison(options, readSource, folder);
    const result = await prepareProfessionalMix(
      music.options,
      mix,
      folder,
      readSource,
      { base, from: 0, to: base },
    );
    if (music.warnings) result.report.warnings.push(...music.warnings);
    return result.report;
  } finally {
    await scratch.close();
  }
}

/** Lossless frame output from the same RGB compositor used by video exports. */
export async function renderTimelineFrame(options: VideoTimelineOptions) {
  const scratch = renderScratch(options.output, '.opencut-frame-');
  try {
    const prepared = await prepareTimeline(options, 'png', scratch);
    await scratch.stage(prepared, options.signal);
    const rendered = join(await scratch.open(), 'frame.png');
    await runMediaTool(
      'ffmpeg',
      [...prepared.args, '-update', '1', rendered],
      4 * 1024 * 1024,
      600_000,
      { signal: options.signal },
    );
    const metadata = await probeMedia(rendered, options.signal, {
      stage: 'verifying rendered PNG',
    });
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
