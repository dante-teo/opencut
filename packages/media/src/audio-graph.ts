import { roomEchoes } from '@opencut/shared';
import type {
  AudioRole,
  MixGainPoint,
  RenderTimeMapping,
} from '@opencut/shared';
import { audioSourceDuration } from './probe.js';
import type { MediaMetadata } from './probe.js';
import { MediaError } from './process.js';
import type { VideoTimelineOptions } from './render.js';

type Rational = RenderTimeMapping['sourceIn'];

interface RenderAudioFade {
  duration: Rational;
  from: number;
  to: number;
}

export interface AudioRenderClip {
  trackId?: string;
  role?: AudioRole;
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

export function audioSampleAtFrame(
  frame: number,
  rate: VideoTimelineOptions['frameRate'],
  offset?: Rational,
  sign = 1n,
) {
  const scale = BigInt(offset?.denominator ?? 1);
  const divisor = BigInt(rate.numerator) * scale;
  const n =
    (BigInt(frame) * BigInt(rate.denominator) * scale +
      sign * BigInt(offset?.numerator ?? 0) * BigInt(rate.numerator)) *
    48000n;
  return Number((2n * n + divisor) / (2n * divisor));
}
const sampleTime = (time: Rational, offset?: Rational, sign = 1n) =>
  audioSampleAtFrame(
    time.numerator,
    { numerator: time.denominator, denominator: 1 },
    offset,
    sign,
  );
export function audioClipSample(
  frameRate: VideoTimelineOptions['frameRate'],
  clip: AudioRenderClip,
  edge: 'start' | 'end',
  fade?: Rational,
) {
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
  return audioSampleAtFrame(frame, frameRate, fade, sign);
}

export interface StagedDialogue {
  path: string;
  pre: number;
  fadeIn: { offset: number; length: number } | undefined;
  fadeOut: { offset: number; length: number } | undefined;
  toneDb: number;
  gain: MixGainPoint[];
}

export function audioSourceSamples(
  clip: AudioRenderClip,
  frameRate: VideoTimelineOptions['frameRate'],
) {
  const start = clip.retiming
    ? sampleTime(clip.retiming.sourceIn)
    : audioSampleAtFrame(clip.sourceStartFrame, frameRate);
  const end = clip.retiming
    ? sampleTime(clip.retiming.sourceOut)
    : start +
      audioClipSample(frameRate, clip, 'end') -
      audioClipSample(frameRate, clip, 'start');
  return { start, end };
}

function mixCurve(keys: MixGainPoint[], offset = 0) {
  const expr = gainExpression(
    keys.map(({ sample, db }) => ({ sample: sample + offset, value: db })),
  );
  return `aeval='val(0)*pow(10,(${expr})/20)|val(1)*pow(10,(${expr})/20)':c=stereo`;
}

export function groupAudioRuns(
  clips: AudioRenderClip[],
  accepts: (previous: AudioRenderClip, clip: AudioRenderClip) => boolean,
) {
  const runs: AudioRenderClip[][] = [];
  for (const clip of clips) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run &&
      previous?.retiming &&
      accepts(previous, clip) &&
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
  return runs;
}

export async function buildAudioGraph(
  options: Pick<VideoTimelineOptions, 'frameRate' | 'audioClips'>,
  {
    filters,
    readSource,
    inputPathFor,
    openInput,
  }: {
    filters: string[];
    readSource: (clip: AudioRenderClip) => Promise<MediaMetadata>;
    inputPathFor: (path: string) => string | Promise<string>;
    openInput: (clip: AudioRenderClip, path: string) => number;
  },
  {
    total: totalSamples,
    from,
    to,
  }: { total: number; from: number; to: number },
  mode?:
    | { isolate: { pre: number; post: number } }
    | {
        dialogue?: ReadonlyMap<string, StagedDialogue>;
        music?: MixGainPoint[];
      },
) {
  const { frameRate } = options;
  const { numerator, denominator } = frameRate;
  const isolate = mode && 'isolate' in mode ? mode.isolate : undefined;
  const mix = mode && !('isolate' in mode) ? mode : undefined;
  const musicKeys = mix?.music;
  const timelineSample = (
    clip: AudioRenderClip,
    edge: 'start' | 'end',
    fade?: Rational,
  ) => audioClipSample(frameRate, clip, edge, fade);
  const audioLabels = ['[silence]'];
  const musicLabels: string[] = [];
  if (!isolate)
    filters.push(
      `anullsrc=r=48000:cl=stereo,atrim=end_sample=${totalSamples},asettb=1/48000,asetpts=N[silence]`,
    );
  const effectChain = (clip: AudioRenderClip, count: number) => {
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
  const envelope = (
    clip: AudioRenderClip,
    start: number,
    end: number,
    pre = 0,
  ) => {
    const filters: string[] = [];
    if (clip.fadeIn) {
      const length =
        timelineSample(clip, 'start', clip.fadeIn.duration) - start;
      if (length > 0)
        filters.push(
          `afade=t=in:ss=${pre}:ns=${length}:c=tri:silence=${clip.fadeIn.from}:unity=${clip.fadeIn.to}`,
        );
    }
    if (clip.fadeOut) {
      const release = timelineSample(clip, 'end', clip.fadeOut.duration);
      if (end > release)
        filters.push(
          `afade=t=out:ss=${release - start + pre}:ns=${end - release}:c=tri:silence=${clip.fadeOut.to}:unity=${clip.fadeOut.from}`,
        );
    }
    filters.push(`volume=${clip.muted ? 0 : clip.volume}`);
    if (clip.gainKeys?.length) {
      const keys = clip.gainKeys.map(({ time, value }) => ({
        sample: timelineSample(clip, 'start', time) - start + pre,
        value,
      }));
      const expression = gainExpression(keys);
      filters.push(
        `aeval='val(0)*${expression}|val(1)*${expression}':c=stereo`,
      );
    }
    return filters.join(',');
  };
  const runs = groupAudioRuns(
    options.audioClips ?? [],
    (previous, clip) =>
      !mix ||
      (clip.role === previous.role &&
        !mix.dialogue?.has(clip.clipId) &&
        !mix.dialogue?.has(previous.clipId)),
  );
  for (const [index, run] of runs.entries()) {
    const first = run[0]!;
    const last = run.at(-1)!;
    const staged = mix?.dialogue?.get(first.clipId);
    if (staged) {
      const start = timelineSample(first, 'start');
      const end = timelineSample(first, 'end');
      const input = openInput(first, staged.path);
      const chain = [
        ...toneMatchFilters(staged.toneDb),
        envelope(first, start, end, staged.pre),
      ];
      if (staged.gain.length) chain.push(mixCurve(staged.gain, staged.pre));
      for (const [edge, fade] of [
        ['in', staged.fadeIn],
        ['out', staged.fadeOut],
      ] as const)
        if (fade?.length)
          chain.push(
            `afade=t=${edge}:ss=${fade.offset}:ns=${fade.length}:c=qsin`,
          );
      chain.push(`adelay=${start - staged.pre}S:all=1`);
      filters.push(`[${input}:a:0]${chain.join(',')}[a${index}]`);
      audioLabels.push(`[a${index}]`);
      continue;
    }
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
    const count =
      pieces.at(-1)!.end - start + (isolate?.pre ?? 0) + (isolate?.post ?? 0);
    const sourceStart =
      audioSourceSamples(first, frameRate).start - (isolate?.pre ?? 0);
    const sourceEnd =
      audioSourceSamples(last, frameRate).end + (isolate?.post ?? 0);
    if (sourceEnd <= sourceStart) continue;
    const audioInput = openInput(first, await inputPathFor(source.path));
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
    const fitDuration =
      first.retiming || isolate
        ? `apad,atrim=end_sample=${count},asettb=1/48000,asetpts=N,`
        : '';
    const inputFilter =
      `[${audioInput}:${audio.index}]asetpts=PTS-STARTPTS+(${offset.toFixed(9)})/TB,` +
      'aresample=48000:async=1:min_hard_comp=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
      `apad,atrim=start_sample=${sourceStart}:end_sample=${sourceEnd},asettb=1/48000,asetpts=N,` +
      tempo +
      fitDuration +
      effectChain(first, count);
    if (isolate) {
      filters.push(inputFilter + 'anull[audio]');
      return;
    }
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
    const bus =
      musicKeys?.length && first.role === 'music' ? musicLabels : audioLabels;
    bus.push(`[a${index}]`);
  }
  if (isolate)
    throw new MediaError('Dialogue clip contains no renderable audio.');
  if (musicLabels.length && musicKeys?.length) {
    filters.push(
      `${musicLabels.join('')}amix=inputs=${musicLabels.length}:duration=longest:normalize=0,${mixCurve(musicKeys)}[music]`,
    );
    audioLabels.push('[music]');
  }
  // Stable linear gains, independent of the number of active sources. Match the
  // existing composer limiter, including latency compensation for sync markers.
  filters.push(
    `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first:normalize=0,` +
      (mix ? '' : 'alimiter=limit=0.95:level=0:latency=1,') +
      `atrim=start_sample=${from}:end_sample=${to},asettb=1/48000,asetpts=N[audio]`,
  );
}

function toneMatchFilters(db: number) {
  if (Math.abs(db) < 0.05) return [];
  return [`lowshelf=f=280:g=${-db / 2}`, `highshelf=f=2300:g=${db / 2}`];
}
