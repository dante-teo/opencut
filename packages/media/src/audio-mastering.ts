import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deliveryTargets } from '@opencut/shared';
import type { MixGainPoint, ProfessionalMix } from '@opencut/shared';
import { clamp } from './dialogue-analysis.js';
import { MediaError, runMediaTool } from './process.js';
import { accountRenderFile } from './render-budget.js';
import type { RenderControls } from './render.js';

const ffmpeg = [
  '-hide_banner',
  '-v',
  'error',
  '-nostdin',
  '-n',
  '-xerror',
  '-filter_threads',
  '1',
];
const timeout = 600_000;
export interface LoudnessMeasurement {
  integratedLufs: number | null;
  loudnessRange: number;
  truePeakDbtp: number | null;
}
export interface AudioMixReport {
  automation: {
    dialogue: Record<string, MixGainPoint[]>;
    music: MixGainPoint[];
  };
  input: LoudnessMeasurement;
  output: LoudnessMeasurement;
  target: typeof deliveryTargets.web;
  comparison: 'after' | 'before';
  normalization: 'linear' | 'dynamic' | 'none';
  warnings: string[];
}

export async function renderAudioFile(
  args: string[],
  output: string,
  signal?: AbortSignal,
) {
  await runMediaTool(
    'ffmpeg',
    [...ffmpeg, ...args, output],
    undefined,
    timeout,
    { signal, writesFile: true },
  );
  await accountRenderFile(output);
}

type Target = AudioMixReport['target'];

function normalizationOptions(target: Target) {
  return `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakDbtp}:LRA=${target.loudnessRange}`;
}

async function measure(path: string, target: Target, signal?: AbortSignal) {
  let result: Record<string, string> = {};
  await runMediaTool(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'info',
      '-nostdin',
      '-xerror',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      normalizationOptions(target) + ':print_format=json',
      '-f',
      'null',
      '-',
    ],
    undefined,
    timeout,
    {
      signal,
      onDiagnostics(diagnostics) {
        const block = diagnostics.match(/\{\s*"input_i"[^}]*\}/)?.[0];
        if (!block)
          throw new MediaError('FFmpeg did not return loudness measurements.');
        result = JSON.parse(block) as Record<string, string>;
      },
    },
  );
  const number = (key: string) => {
    const val = Number(result[key]);
    return Number.isFinite(val) ? val : null;
  };
  return {
    loudness: {
      integratedLufs: number('input_i'),
      loudnessRange: number('input_lra') ?? 0,
      truePeakDbtp: number('input_tp'),
    },
    threshold: number('input_thresh'),
    offset: number('target_offset'),
  };
}

export async function measureAudioLoudness(path: string, signal?: AbortSignal) {
  return (await measure(path, deliveryTargets.web, signal)).loudness;
}

async function normalize(
  source: string,
  destination: string,
  target: Target,
  sampleRate: number,
  signal?: AbortSignal,
) {
  const stats = await measure(source, target, signal);
  const { integratedLufs, truePeakDbtp, loudnessRange } = stats.loudness;
  const { threshold, offset } = stats;
  if (
    integratedLufs === null ||
    truePeakDbtp === null ||
    integratedLufs <= -69.9
  )
    return { path: source, stats, method: 'none' as const };
  const delta = target.integratedLufs - integratedLufs;
  const linear =
    delta + truePeakDbtp <= target.truePeakDbtp &&
    loudnessRange <= target.loudnessRange;
  // FFmpeg switches to dynamic mode for zero LRA, including short clips. A
  // static measured gain preserves those clips if the measured peak permits it.
  const method = linear ? 'linear' : 'dynamic';
  const dynamic =
    normalizationOptions(target) +
    `:measured_I=${clamp(integratedLufs, -99, 0)}:measured_LRA=${loudnessRange}:measured_TP=${clamp(truePeakDbtp, -99, 99)}:measured_thresh=${clamp(threshold ?? -70, -99, 0)}:linear=false`;
  const render = (path: string, filter: string) =>
    renderAudioFile(
      [
        '-i',
        source,
        '-af',
        filter,
        '-ar',
        String(sampleRate),
        '-c:a',
        'pcm_f32le',
      ],
      path,
      signal,
    );
  const boost = clamp(offset ?? 0, -99, 99);
  await render(
    destination,
    linear
      ? `volume=${delta}dB:precision=double`
      : `${dynamic}:offset=${boost}`,
  );
  // Peak-constrained masters can miss the target predicted by the first pass.
  // Correct the pre-limiter gain once and keep the closer measured result.
  if (!linear) {
    const delivered = (await measure(destination, target, signal)).loudness
      .integratedLufs;
    if (
      delivered !== null &&
      Math.abs(target.integratedLufs - delivered) > 0.75
    ) {
      const correction = target.integratedLufs - delivered;
      const candidate = destination.replace(/\.wav$/, '-adjusted.wav');
      await render(
        candidate,
        `${dynamic}:offset=${clamp(boost + correction * 1.6, -99, 99)}`,
      );
      const adjusted = (await measure(candidate, target, signal)).loudness
        .integratedLufs;
      if (
        adjusted !== null &&
        Math.abs(target.integratedLufs - adjusted) < Math.abs(correction)
      ) {
        await rm(destination, { force: true });
        return { path: candidate, stats, method } as const;
      }
      await rm(candidate, { force: true });
    }
  }
  return { path: destination, stats, method } as const;
}

export async function masterAudioMix(
  options: RenderControls,
  settings: ProfessionalMix['delivery'],
  folder: string,
  { base, from, to }: { base: number; from: number; to: number },
  warnings: string[],
  render: (
    path: string,
    kind: 'wet' | 'dry',
    rate: number,
    channels: number,
  ) => Promise<void>,
) {
  const { signal } = options;
  const rate = options.audioSampleRate ?? 48000;
  const channels = options.audioChannels ?? 2;
  const bitrate = options.audioBitrateKbps ?? 192;
  const delivery = settings ?? { preset: 'web' };
  const defaults = deliveryTargets[delivery.preset];
  const target = {
    integratedLufs: delivery.integratedLufs ?? defaults.integratedLufs,
    truePeakDbtp: delivery.truePeakDbtp ?? defaults.truePeakDbtp,
    loudnessRange: delivery.loudnessRange ?? defaults.loudnessRange,
  };
  const working = {
    ...target,
    truePeakDbtp: Math.max(-9, target.truePeakDbtp - 0.55),
  };
  const wet = join(folder, 'wet.wav');
  await render(wet, 'wet', rate, channels);
  const after = await normalize(
    wet,
    join(folder, 'after.wav'),
    working,
    rate,
    signal,
  );
  // Do loudness matching and gain staging for the full composition before trimming.
  const comparison = options.audioComparison ?? 'after';
  let selected = after;
  if (comparison === 'before') {
    const dry = join(folder, 'dry.wav');
    await render(dry, 'dry', rate, channels);
    const measured = (await measure(after.path, working, signal)).loudness
      .integratedLufs;
    selected = await normalize(
      dry,
      join(folder, 'before.wav'),
      {
        ...working,
        integratedLufs:
          measured === null ? working.integratedLufs : clamp(measured, -70, -5),
        loudnessRange: 50,
      },
      rate,
      signal,
    );
    if (measured !== null) {
      const actual = (await measure(selected.path, working, signal)).loudness
        .integratedLufs;
      if (actual === null || Math.abs(actual - measured) > 1)
        warnings.push(
          'The comparison could not fully match loudness within the delivery peak ceiling.',
        );
    }
  }

  let path: string;
  let output: LoudnessMeasurement;
  let trim = 0;
  const start = Math.round((from * rate) / 48000);
  const end = Math.round((to * rate) / 48000);
  for (let attempt = 0; ; attempt++) {
    path = join(folder, `master-${attempt}.m4a`);
    const filter = `volume=${-trim}dB,apad,atrim=start_sample=${start}:end_sample=${end},asettb=1/${rate},asetpts=N`;
    await renderAudioFile(
      [
        '-i',
        selected.path,
        '-af',
        filter,
        '-map_metadata',
        '-1',
        '-c:a',
        'aac',
        '-b:a',
        `${bitrate}k`,
        '-ar',
        String(rate),
        '-ac',
        String(channels),
      ],
      path,
      signal,
    );
    output = (await measure(path, target, signal)).loudness;
    const over = (output.truePeakDbtp ?? -Infinity) - target.truePeakDbtp;
    if (over <= 0) break;
    if (attempt >= 3)
      throw new MediaError(
        'AAC audio could not pass the configured true-peak ceiling.',
      );
    trim += over + 0.25;
  }
  if (comparison === 'after' && from === 0 && to >= base) {
    if (
      output.integratedLufs !== null &&
      Math.abs(output.integratedLufs - target.integratedLufs) > 1
    )
      warnings.push(
        'Output loudness differs from the target by more than 1 LU. Check the measured result and delivery settings.',
      );
    if (output.loudnessRange > target.loudnessRange + 1)
      warnings.push(
        'Output loudness range exceeds the target by more than 1 LU.',
      );
  }
  const report: Omit<AudioMixReport, 'automation'> = {
    input: selected.stats.loudness,
    output,
    target,
    comparison,
    normalization: selected.method,
    warnings,
  };
  return { path, report };
}
