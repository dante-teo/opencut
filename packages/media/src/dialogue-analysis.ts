import type { MixGainPoint } from '@opencut/shared';
import { runMediaTool } from './process.js';

const windowSize = 4800;
const rate = 12000;
const analysisCache = new Map<string, DialogueProfile>();

interface Window {
  from: number;
  to: number;
  level: number;
  tone: number;
}

export interface DialogueProfile {
  windows: Window[];
  floor: number;
}
interface Interval {
  from: number;
  to: number;
}
export interface DialogueActivity {
  phrases: Interval[];
  level: number;
  tone: number;
}

export const clamp = (value: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, value));

function percentile(values: number[], q: number, fallback: number) {
  if (!values.length) return fallback;
  return values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!;
}

/** K-weighted stereo energy and a coarse spectral tilt estimate in 100 ms windows. */
export async function profileDialogue(
  path: string,
  key: string,
  signal?: AbortSignal,
): Promise<DialogueProfile> {
  const cached = analysisCache.get(key);
  if (cached) {
    analysisCache.delete(key);
    analysisCache.set(key, cached);
    return cached;
  }
  const windows: Window[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let count = 0;
  let energy = 0;
  let bass = 0;
  let high = 0;
  let leftLow = 0;
  let rightLow = 0;
  let offset = 0;
  const coefficient = 1 - Math.exp((-2 * Math.PI * 800) / rate);
  function flush() {
    if (!count) return;
    const end = offset + count * (48000 / rate);
    windows.push({
      from: offset,
      to: end,
      level: 10 * Math.log10(Math.max(1e-12, energy / count)) - 0.691,
      tone: 10 * Math.log10((high + 1e-9) / (bass + 1e-9)),
    });
    offset = end;
    count = energy = bass = high = 0;
  }
  await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-filter_threads',
      '1',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-af',
      'biquad=b0=1.53512485958697:b1=-2.69169618940638:b2=1.19839281085285:a1=-1.69065929318241:a2=0.73248077421585:precision=f64,biquad=b0=1:b1=-2:b2=1:a1=-1.99004745483398:a2=0.99007225036621:precision=f64',
      '-ar',
      String(rate),
      '-ac',
      '2',
      '-c:a',
      'pcm_f32le',
      '-f',
      'f32le',
      'pipe:1',
    ],
    64 * 1024 * 1024,
    120_000,
    {
      signal,
      onStdout(chunk) {
        if (pending.length) chunk = Buffer.concat([pending, chunk]);
        const end = chunk.length - (chunk.length % 8);
        for (let i = 0; i < end; i += 8) {
          const left = chunk.readFloatLE(i);
          const right = chunk.readFloatLE(i + 4);
          leftLow += coefficient * (left - leftLow);
          rightLow += coefficient * (right - rightLow);
          energy += left ** 2 + right ** 2;
          bass += leftLow ** 2 + rightLow ** 2;
          high += (left - leftLow) ** 2 + (right - rightLow) ** 2;
          if (++count === windowSize / (48000 / rate)) flush();
        }
        pending = chunk.subarray(end);
      },
    },
  );
  flush();
  const profile = {
    windows,
    floor: percentile(
      windows.map((window) => window.level),
      0.15,
      -90,
    ),
  };
  analysisCache.set(key, profile);
  if (analysisCache.size > 96)
    analysisCache.delete(analysisCache.keys().next().value!);
  return profile;
}

export function detectDialogue(
  profile: DialogueProfile,
  pre: number,
  length: number,
  gainAt: (sample: number) => number,
): DialogueActivity {
  const windows = profile.windows
    .filter((window) => window.to > pre && window.from < pre + length)
    .map((window) => {
      const from = Math.max(0, window.from - pre);
      const to = Math.min(length, window.to - pre);
      const gain = gainAt((from + to) / 2);
      return {
        from,
        to,
        tone: window.tone,
        level: window.level + 20 * Math.log10(gain),
        audible: gain > 0.015,
      };
    });
  const levels = windows
    .filter(({ audible }) => audible)
    .map(({ level }) => level);
  const upper = percentile(levels.slice(), 0.85, -90);
  const floor = percentile(levels, 0.15, -90);
  const stationary = windows.length >= 12 && upper - floor < 2.5 && upper < -27;
  // A brief utterance may sit entirely above the percentile used for typical speech.
  const threshold = Math.max(
    -64,
    upper - 27,
    stationary ? floor + 7 : Math.min(floor + 7, upper - 3),
  );
  const active = windows.filter(
    ({ audible, level }) => audible && level >= threshold,
  );
  const phrases: Interval[] = [];
  const voiced: typeof active = [];
  let start = 0;
  while (start < active.length) {
    let end = start + 1;
    while (
      end < active.length &&
      active[end]!.from - active[end - 1]!.to <= 9600
    )
      end++;
    const { from, level } = active[start]!;
    const { to } = active[end - 1]!;
    // Remove isolated low-level impacts while retaining strong one-window utterances.
    if (to - from >= 7200 || level >= Math.max(-42, upper - 5)) {
      phrases.push({ from, to });
      voiced.push(...active.slice(start, end));
    }
    start = end;
  }
  return {
    phrases,
    level: percentile(
      voiced.map(({ level }) => level),
      0.65,
      -Infinity,
    ),
    tone: percentile(
      voiced.map(({ tone }) => tone),
      0.5,
      0,
    ),
  };
}

function point(keys: MixGainPoint[], sample: number, db: number) {
  const value = db === 0 ? 0 : db;
  const last = keys.at(-1);
  if (last?.sample === sample) last.db = value;
  else keys.push({ sample, db: value });
}

export function dialogueCurve(
  profile: DialogueProfile,
  activity: DialogueActivity,
  target: number,
  intensity: number,
  pre: number,
  length: number,
  gainAt: (sample: number) => number,
): MixGainPoint[] {
  if (!Number.isFinite(activity.level) || !intensity) return [];
  const keys: MixGainPoint[] = [];
  const clipGain = clamp(target - activity.level, -15, 15) * intensity;
  let first = 0;
  for (const { from, to } of activity.phrases) {
    while (profile.windows[first] && profile.windows[first]!.to - pre <= from)
      first++;
    const phraseLevels = [];
    for (
      let i = first;
      i < profile.windows.length && profile.windows[i]!.from - pre < to;
      i++
    ) {
      const window = profile.windows[i]!;
      phraseLevels.push(
        window.level +
          20 *
            Math.log10(
              gainAt(clamp((window.from + window.to) / 2 - pre, from, to)),
            ),
      );
    }
    const difference =
      activity.level - percentile(phraseLevels, 0.65, activity.level);
    // Quiet and loud expressive phrases retain their contrast.
    const correction =
      Math.abs(difference) <= 9 ? clamp(difference * 0.45, -3, 3) : 0;
    const value = Math.round((clipGain + correction * intensity) * 100) / 100;
    if (!value) continue;
    const attack = Math.max(keys.at(-1)?.sample ?? 0, from - 2400);
    const release = Math.min(length, to + 3600);
    if (attack < from) point(keys, attack, 0);
    point(keys, from, value);
    point(keys, to, value);
    if (release > to) point(keys, release, 0);
  }
  return keys;
}

export function musicCurve(
  activity: Interval[],
  {
    depthDb,
    attackMs,
    holdMs,
    releaseMs,
  }: { depthDb: number; attackMs: number; holdMs: number; releaseMs: number },
  length: number,
): MixGainPoint[] {
  if (!depthDb) return [];
  const [attack, hold, release] = [attackMs, holdMs, releaseMs].map((ms) =>
    Math.round(ms * 48),
  ) as [number, number, number];
  const regions: Interval[] = [];
  for (const span of activity
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)) {
    const preceding = regions.at(-1);
    if (preceding && span.from - attack <= preceding.to + hold + release)
      preceding.to = Math.max(preceding.to, span.to);
    else regions.push({ ...span });
  }
  const keys: MixGainPoint[] = [];
  for (const { from, to } of regions) {
    if (from >= length) break;
    if (from > 0) {
      const begin = Math.max(0, from - attack);
      point(keys, begin, -depthDb * (1 - (from - begin) / attack));
    }
    point(keys, from, -depthDb);
    const held = Math.min(length, to + hold);
    point(keys, held, -depthDb);
    if (held < length) {
      const end = Math.min(length, held + release);
      point(keys, end, -depthDb * (1 - (end - held) / release));
    }
  }
  return keys;
}
