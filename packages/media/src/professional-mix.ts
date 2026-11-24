import { masterAudioMix, renderAudioFile } from './audio-mastering.js';
import { sourceIdentity, SourceChangedError } from './source-integrity.js';
import type { AudioMixReport } from './audio-mastering.js';
import { localEnhancer } from './deepfilter.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialoguePresetControls } from '@opencut/shared';
import type { ProfessionalMix } from '@opencut/shared';
import {
  audioClipSample,
  audioSourceSamples,
  buildAudioGraph,
  centeredChannelWarnings,
  groupAudioRuns,
} from './audio-graph.js';
import type { AudioRenderClip, StagedDialogue } from './audio-graph.js';
import {
  clamp,
  detectDialogue,
  dialogueCurve,
  musicCurve,
  profileDialogue,
} from './dialogue-analysis.js';
import { audioSourceDuration, probeMedia } from './probe.js';
import type { MediaMetadata } from './probe.js';
import {
  checkRenderSignal,
  MediaError,
  runMediaTool,
  sourceFileStamp,
} from './process.js';
import type { VideoTimelineOptions } from './render.js';

const dbGain = (db: number) => 10 ** (db / 20);
const fixed = (n: number) => Number(n.toFixed(5));
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface AudioMixCache {
  materialize(
    key: string,
    encode: (path: string) => Promise<MediaMetadata>,
  ): Promise<string>;
}
interface Placement {
  pre: number;
  post: number;
  fadeIn?: StagedDialogue['fadeIn'];
  fadeOut?: StagedDialogue['fadeOut'];
}

type SourceReader = (clip: AudioRenderClip) => Promise<MediaMetadata>;

function presetSettings(mix: ProfessionalMix) {
  const preset = dialoguePresetControls[mix.preset];
  return {
    cleanup: mix.cleanup ?? preset.cleanup,
    warmth: mix.warmth ?? preset.warmth,
    clarity: mix.clarity ?? preset.clarity,
    consistency: mix.consistency ?? preset.consistency,
    dialogueLufs: mix.dialogueLufs ?? preset.dialogueLufs,
    ducking: {
      depthDb: mix.ducking?.depthDb ?? preset.duckingDepth,
      attackMs: mix.ducking?.attackMs ?? 180,
      holdMs: mix.ducking?.holdMs ?? 340,
      releaseMs: mix.ducking?.releaseMs ?? 620,
    },
  };
}

export async function renderAudioGraph(
  path: string,
  script: string,
  options: VideoTimelineOptions,
  readSource: SourceReader,
  samples: number,
  mode: NonNullable<Parameters<typeof buildAudioGraph>[3]>,
  sampleRate: number,
  channels: number,
) {
  const args: string[] = [];
  const filters: string[] = [];
  let index = 0;
  await buildAudioGraph(
    options,
    {
      filters,
      readSource,
      inputPathFor: (source) => options.snapshotSource?.(source) ?? source,
      openInput: (_clip, input) => {
        args.push('-protocol_whitelist', 'file', '-threads', '1', '-i', input);
        return index++;
      },
    },
    { total: samples, from: 0, to: samples },
    mode,
  );
  await writeFile(script, filters.join(';'), {
    flag: 'wx',
    signal: options.signal,
  });
  await renderAudioFile(
    [
      ...args,
      '-filter_complex_threads',
      '1',
      '-/filter_complex',
      script,
      '-map',
      '[audio]',
      '-map_metadata',
      '-1',
      '-ar',
      String(sampleRate),
      '-ac',
      String(channels),
      '-c:a',
      'pcm_f32le',
    ],
    path,
    options.signal,
  );
}

function crossfadePlacements(
  clips: AudioRenderClip[],
  sources: ReadonlyMap<string, MediaMetadata>,
  rate: VideoTimelineOptions['frameRate'],
  maximum: number,
) {
  const placements = new Map<string, Placement>(
    clips.map((clip) => [clip.clipId, { pre: 0, post: 0 }]),
  );
  const tracks = new Map<string, AudioRenderClip[]>();
  for (const clip of clips) {
    if (!clip.trackId) continue;
    const track = tracks.get(clip.trackId) ?? [];
    track.push(clip);
    tracks.set(clip.trackId, track);
  }
  const start = (clip: AudioRenderClip) => audioClipSample(rate, clip, 'start');
  const end = (clip: AudioRenderClip) => audioClipSample(rate, clip, 'end');
  const unity = (clip: AudioRenderClip) =>
    !clip.retiming ||
    clip.retiming.speed.numerator === clip.retiming.speed.denominator;
  for (const track of tracks.values()) {
    track.sort((a, b) => start(a) - start(b));
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1]!;
      const b = track[i]!;
      if (end(a) !== start(b) || a.fadeOut || b.fadeIn) continue;
      const previous = placements.get(a.clipId)!;
      const next = placements.get(b.clipId)!;
      const sourceA = audioSourceSamples(a, rate);
      const sourceB = audioSourceSamples(b, rate);
      const lengthA = end(a) - start(a);
      const lengthB = end(b) - start(b);
      if (a.path === b.path && sourceA.end === sourceB.start) continue;
      const length = Math.floor(Math.min(maximum, lengthA / 4, lengthB / 4));
      if (!length) continue;
      const mediaB = sources.get(b.clipId)!;
      const audioOffset =
        (mediaB.audio?.startTimeSeconds ?? 0) -
        (mediaB.video?.startTimeSeconds ?? mediaB.audio?.startTimeSeconds ?? 0);
      const incoming =
        unity(b) &&
        sourceB.start - Math.max(0, Math.ceil(audioOffset * 48000)) >= length;
      const duration = audioSourceDuration(sources.get(a.clipId)!) ?? 0;
      const outgoing =
        unity(a) && Math.floor(duration * 48000) - sourceA.end >= length;
      if (incoming) {
        next.pre = length;
        next.fadeIn = { offset: 0, length };
        previous.fadeOut = { offset: previous.pre + lengthA - length, length };
      } else if (outgoing) {
        previous.post = length;
        previous.fadeOut = { offset: previous.pre + lengthA, length };
        next.fadeIn = { offset: 0, length };
      } else {
        const edge = Math.min(length, 240);
        previous.fadeOut = {
          offset: previous.pre + lengthA - edge,
          length: edge,
        };
        next.fadeIn = { offset: 0, length: edge };
      }
    }
  }
  return placements;
}

function processingFilters(
  mix: ProfessionalMix,
  settings: ReturnType<typeof presetSettings>,
  floor: number,
  noisy: boolean,
  noiseLeadSeconds: number,
) {
  const chain: string[] = [];
  const pass =
    mix.highPassHz ??
    (mix.preset === 'clear-voiceover' ? (noisy ? 75 : 45) : noisy ? 62 : 25);
  if (pass) chain.push(`highpass=f=${pass}:p=1`);
  if (settings.cleanup && noisy && !mix.ai) {
    // afftdn delays its audio by two 600-sample hops at 48 kHz.
    const attenuation = fixed(
      Math.max(0.01, settings.cleanup * (noiseLeadSeconds ? 27 : 17)),
    );
    chain.push(
      'apad=pad_len=1200',
      ...(noiseLeadSeconds
        ? [
            'asendcmd=0 afftdn sn start',
            `asendcmd=${noiseLeadSeconds} afftdn sn stop`,
          ]
        : []),
      `afftdn=nr=${attenuation}:nf=${fixed(clamp(floor - 5, -72, -22))}:tn=1:ad=0.8:gs=5:nl=average`,
      'atrim=start_sample=1200',
      'asettb=1/48000',
      'asetpts=N',
    );
  }
  if (settings.warmth)
    chain.push(`lowshelf=f=240:g=${fixed(settings.warmth * 3)}`);
  if (settings.clarity)
    chain.push(
      `equalizer=f=2800:width_type=q:w=0.8:g=${fixed(settings.clarity * 4)}`,
    );
  for (const eq of mix.eq ?? [])
    chain.push(`equalizer=f=${eq.frequency}:width_type=q:w=${eq.q}:g=${eq.db}`);
  const deEsser =
    mix.deEsser ?? (mix.preset === 'clear-voiceover' ? 0.24 : 0.15);
  if (deEsser) chain.push(`deesser=i=${deEsser}:m=0.35:f=0.5`);
  const tail = mix.dereverb ?? 0;
  const reduction = (noisy ? settings.cleanup * 4 : 0) + tail * 6;
  if (reduction) {
    chain.push(
      `agate=threshold=${dbGain(clamp(floor + 2 + tail * 6, -66, -40))}:range=${dbGain(-reduction)}:ratio=1.6:attack=10:release=240:link=maximum`,
    );
  }
  const compressor =
    mix.compressor ??
    (mix.preset === 'clear-voiceover'
      ? { thresholdDb: -21, ratio: 1.8, attackMs: 16, releaseMs: 210 }
      : { thresholdDb: -17, ratio: 1.35, attackMs: 25, releaseMs: 270 });
  if (compressor.ratio > 1)
    chain.push(
      `acompressor=threshold=${dbGain(compressor.thresholdDb)}:ratio=${compressor.ratio}:attack=${compressor.attackMs}:release=${compressor.releaseMs}:link=maximum`,
    );
  chain.push('alimiter=limit=0.95:level=0:latency=1');
  return chain;
}

function authoredGain(
  clip: AudioRenderClip,
  rate: VideoTimelineOptions['frameRate'],
) {
  const start = audioClipSample(rate, clip, 'start');
  const end = audioClipSample(rate, clip, 'end');
  const fadeIn = clip.fadeIn;
  const fadeOut = clip.fadeOut;
  const attack = fadeIn
    ? audioClipSample(rate, clip, 'start', fadeIn.duration) - start
    : 0;
  const release = fadeOut
    ? audioClipSample(rate, clip, 'end', fadeOut.duration) - start
    : Infinity;
  const keys = clip.gainKeys?.map(({ time, value }) => ({
    sample: audioClipSample(rate, clip, 'start', time) - start,
    value,
  }));
  const lerp = (a: number, b: number, fraction: number) =>
    a + (b - a) * fraction;
  let index = 0;
  return (sample: number) => {
    let gain = clip.volume;
    if (fadeIn && sample < attack)
      gain *= lerp(fadeIn.from, fadeIn.to, sample / attack);
    if (fadeOut && sample > release)
      gain *= lerp(
        fadeOut.from,
        fadeOut.to,
        (sample - release) / (end - start - release),
      );
    if (keys?.length) {
      // Profile and phrase scans can revisit earlier samples.
      while (index && keys[index - 1]!.sample >= sample) index--;
      while (index < keys.length - 1 && keys[index]!.sample < sample) index++;
      const current = keys[index]!;
      const previous = keys[index - 1];
      gain *=
        previous && sample < current.sample
          ? lerp(
              previous.value,
              current.value,
              (sample - previous.sample) / (current.sample - previous.sample),
            )
          : current.value;
    }
    return gain;
  };
}

async function stageDialogue(
  options: VideoTimelineOptions,
  mix: ProfessionalMix,
  readSource: SourceReader,
  folder: string,
  baseSamples: number,
) {
  const settings = presetSettings(mix);
  const backend = (
    await runMediaTool('ffmpeg', ['-version'], undefined, undefined, {
      signal: options.signal,
    })
  ).toString();
  const { frameRate, signal } = options;
  const candidates = (options.audioClips ?? []).filter(
    (clip) =>
      clip.role === 'dialogue' &&
      !clip.muted &&
      clip.volume > 0 &&
      audioClipSample(frameRate, clip, 'end') >
        audioClipSample(frameRate, clip, 'start'),
  );
  const sources = new Map<string, MediaMetadata>();
  for (const clip of candidates) {
    const source = await readSource(clip);
    if (source.audio) sources.set(clip.clipId, source);
  }
  const clips = candidates.filter((clip) => sources.has(clip.clipId));
  const crossfades = crossfadePlacements(
    clips,
    sources,
    frameRate,
    Math.round((mix.crossfadeMs ?? 22) * 48),
  );
  const ai = mix.ai && clips.length ? await localEnhancer(signal) : undefined;
  const dialogue = new Map<string, StagedDialogue>();
  const sample = (clip: AudioRenderClip, edge: 'start' | 'end') =>
    audioClipSample(frameRate, clip, edge);
  const runs = new Map<
    string,
    {
      clips: AudioRenderClip[];
      start: number;
      samples: number;
      sourceIn: number;
      sourceOut: number;
      raw?: string;
    }
  >();
  for (const run of groupAudioRuns(
    options.audioClips ?? [],
    (a, b) => a.role === b.role,
  )) {
    const first = run[0]!;
    const speed = first.retiming?.speed;
    if (
      run.length < 2 ||
      first.role !== 'dialogue' ||
      !speed ||
      speed.numerator === speed.denominator
    )
      continue;
    const start = run.find(
      (clip) => sample(clip, 'end') > sample(clip, 'start'),
    );
    if (!start) continue;
    const last = run.at(-1)!;
    const origin = sample(start, 'start');
    const shared = {
      clips: run,
      start: origin,
      samples: sample(last, 'end') - origin,
      sourceIn: audioSourceSamples(first, frameRate).start,
      sourceOut: audioSourceSamples(last, frameRate).end,
    };
    for (const clip of run) runs.set(clip.clipId, shared);
  }
  const analyses = [];
  for (const [index, clip] of clips.entries()) {
    checkRenderSignal(signal);
    const start = sample(clip, 'start');
    const length = sample(clip, 'end') - start;
    const placement = crossfades.get(clip.clipId)!;
    const { pre, post, fadeIn, fadeOut } = placement;
    const samples = pre + length + post;
    const directory = join(folder, `dialogue-${index}`);
    await mkdir(directory);
    const raw = join(directory, 'raw.wav');
    const stamp =
      options.boundSourceIdentity?.(clip.path) ??
      (await sourceFileStamp(clip.path));
    const bound = await (options.snapshotSource?.(clip.path) ?? clip.path);
    const observed = sourceIdentity(clip.path);
    if (observed !== stamp)
      throw new SourceChangedError(
        clip.path,
        'dialogue analysis',
        stamp,
        observed,
      );
    const source = sources.get(clip.clipId)!;
    const run = runs.get(clip.clipId);
    const key = digest([
      'dialogue-v1',
      backend,
      stamp,
      source.audio!.index,
      source.audio!.startTimeSeconds,
      source.video?.startTimeSeconds,
      source.startTimeSeconds,
      audioSourceSamples(clip, frameRate),
      clip.retiming?.speed,
      samples,
      pre,
      post,
      clip.effects,
      ...(clip.channelMode ? [clip.channelMode] : []),
      ...(run
        ? [[run.sourceIn, run.sourceOut, run.samples, start - run.start]]
        : []),
    ]);
    const isolate = (
      output: string,
      audioClips: AudioRenderClip[],
      count: number,
      handles: { pre: number; post: number },
    ) =>
      renderAudioGraph(
        output,
        output + '.ffscript',
        {
          ...options,
          audioClips,
          snapshotSource: async () => bound,
        },
        readSource,
        count,
        { isolate: handles },
        48000,
        2,
      );
    if (run) {
      // Drain the tempo filter once at the end of the contiguous source range.
      if (!run.raw) {
        const shared = join(directory, 'run.wav');
        await isolate(shared, run.clips, run.samples, { pre: 0, post: 0 });
        run.raw = shared;
      }
      const from = start - run.start;
      await renderAudioFile(
        [
          '-i',
          run.raw,
          '-af',
          `atrim=start_sample=${from}:end_sample=${from + length},asetpts=PTS-STARTPTS`,
          '-c:a',
          'pcm_f32le',
        ],
        raw,
        signal,
      );
    } else {
      await isolate(raw, [clip], samples, placement);
    }
    const rawProfile = await profileDialogue(raw, key, signal);
    const gainAt = authoredGain(clip, frameRate);
    const rawActivity = detectDialogue(rawProfile, pre, length, () => 1);
    const contrast = rawActivity.level - rawProfile.floor;
    const noisy =
      rawProfile.floor > -56 &&
      (contrast < 18 || (rawProfile.floor > -46 && contrast < 31));
    const lead = ((rawActivity.phrases[0]?.from ?? 0) + pre) / 48000 - 0.065;
    const noiseLeadSeconds = lead >= 0.2 ? fixed(Math.min(0.45, lead)) : 0;
    const chain = processingFilters(
      mix,
      settings,
      rawProfile.floor,
      noisy,
      noiseLeadSeconds,
    );
    const wetKey = digest([key, chain, ai?.key]);
    const encode = async (destination: string) => {
      const enhanced = ai
        ? await ai.enhance(raw, directory, join(directory, 'enhanced'))
        : raw;
      if (ai) {
        const info = await probeMedia(enhanced, signal);
        if (
          info.audio?.sampleRate !== 48000 ||
          info.audio.channels !== 2 ||
          !info.audio.durationSeconds ||
          info.audio.durationSeconds * 48000 < samples - 1
        )
          throw new MediaError(
            'DeepFilterNet returned audio outside the original sample grid.',
          );
      }
      await renderAudioFile(
        [
          '-i',
          enhanced,
          '-map',
          '0:a:0',
          '-af',
          [
            ...chain,
            `apad,atrim=end_sample=${samples},asettb=1/48000,asetpts=N`,
          ].join(','),
          '-c:a',
          'pcm_f32le',
        ],
        destination,
        signal,
      );
      return probeMedia(destination, signal);
    };
    let wet = join(directory, 'processed.wav');
    if (ai && options.audioMixCache)
      wet = await options.audioMixCache.materialize(wetKey, encode);
    else await encode(wet);
    const profile = await profileDialogue(wet, wetKey, signal);
    const activity = detectDialogue(profile, pre, length, gainAt);
    dialogue.set(clip.clipId, {
      path: wet,
      pre,
      fadeIn,
      fadeOut,
      gain: [],
      toneDb: 0,
    });
    analyses.push({ clip, start, activity, profile, pre, length, gainAt });
  }
  const matching = mix.matching ?? { amount: 0.4 };
  const usable = analyses.filter(({ activity }) =>
    Number.isFinite(activity.level),
  );
  const tones = usable
    .map(({ activity }) => activity.tone)
    .sort((a, b) => a - b);
  const reference = usable.find(
    ({ clip }) => clip.clipId === matching.referenceClip,
  )?.activity;
  const anchor =
    reference?.tone ??
    (matching.referenceClip ? undefined : tones[Math.floor(tones.length / 2)]);
  const warnings = [];
  if (matching.referenceClip && !reference && matching.amount)
    warnings.push(
      `Reference clip '${matching.referenceClip}' has no active dialogue for matching.`,
    );
  const target =
    mix.dialogueLufs ??
    (reference
      ? settings.dialogueLufs +
        clamp(reference.level - settings.dialogueLufs, -10, 10) *
          matching.amount
      : settings.dialogueLufs);
  const stored = mix.automation?.dialogue;
  for (const { clip, activity, profile, pre, length, gainAt } of analyses) {
    const staged = dialogue.get(clip.clipId)!;
    if (anchor !== undefined && Number.isFinite(activity.level))
      staged.toneDb = fixed(
        clamp(anchor - activity.tone, -5, 5) * matching.amount,
      );
    staged.gain =
      stored && Object.hasOwn(stored, clip.clipId)
        ? stored[clip.clipId]!
        : dialogueCurve(
            profile,
            activity,
            target,
            settings.consistency,
            pre,
            length,
            gainAt,
          );
    if (staged.gain.some(({ sample }) => sample > length))
      throw new MediaError(
        `Mix automation for '${clip.clipId}' extends beyond its clip.`,
      );
  }
  const music =
    mix.automation?.music ??
    musicCurve(
      analyses.flatMap(({ start, activity }) =>
        activity.phrases.map(({ from, to }) => ({
          from: start + from,
          to: start + to,
        })),
      ),
      settings.ducking,
      baseSamples,
    );
  if (music.some(({ sample }) => sample > baseSamples))
    throw new MediaError('Music automation extends beyond the project.');
  return { dialogue, music, warnings };
}

export async function prepareProfessionalMix(
  options: VideoTimelineOptions,
  mix: ProfessionalMix,
  folder: string,
  readSource: SourceReader,
  { base, from, to }: { base: number; from: number; to: number },
  beginMastering?: () => void,
) {
  const { dialogue, music, warnings } = await stageDialogue(
    options,
    mix,
    readSource,
    folder,
    base,
  );
  warnings.push(...(await centeredChannelWarnings(options, readSource)));
  beginMastering?.();
  const { path, report } = await masterAudioMix(
    options,
    mix.delivery,
    folder,
    { base, from, to },
    warnings,
    (path, kind, rate, channels) =>
      renderAudioGraph(
        path,
        join(folder, kind + '.ffscript'),
        options,
        readSource,
        base,
        kind === 'wet' ? { dialogue, music } : { bypassChannelMode: true },
        rate,
        channels,
      ),
  );
  const automation = {
    dialogue: Object.fromEntries(
      [...dialogue].map(([id, { gain }]) => [id, gain]),
    ),
    music,
  };
  return { path, report: { ...report, automation } satisfies AudioMixReport };
}
