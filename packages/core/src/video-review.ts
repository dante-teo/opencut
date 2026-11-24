import { mkdir, mkdtemp, rename, rmdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  inspectEncodedPicture,
  MediaError,
  renderReviewClip,
  SourceChangedError,
} from '@opencut/media';
import type {
  RenderControls,
  RenderProgress,
  RenderQuality,
} from '@opencut/media';
import { compareRevisionTimelines } from './video-revision.js';
import type { RevisionTimeline } from './video-revision.js';
import { previewVideo } from './video-preview.js';
import type { CompiledVideo } from './video-compiler.js';
import { parseSubtitleTime } from './subtitle-formats.js';
import { compareTimes, frameTime } from './time.js';
import type { FrameRate } from './time.js';
import { videoInputIdentity } from './video-input.js';

const time = z.union([z.string().min(1), z.number().finite().nonnegative()]);
const named = z.string().trim().min(1).max(100);
const times = z.strictObject({ start: time, end: time });
export const reviewMarksSchema = z
  .array(
    times.extend({
      name: named,
      candidate: times.optional(),
      candidates: z.record(z.string(), times).optional(),
    }),
  )
  .min(1);
export const reviewNotesSchema = z
  .array(
    z.strictObject({
      range: named.optional(),
      timestamp: time.optional(),
      version: named.optional(),
      text: z.string().trim().min(1).max(8000),
    }),
  )
  .refine(
    (notes) =>
      notes.every(
        ({ range, timestamp }) =>
          range !== undefined || timestamp !== undefined,
      ),
    'Each note needs a range or timestamp.',
  );

type Selection = { startFrame: number; endFrame: number };
type ReviewSelection = {
  name: string;
  before: Selection;
  after: Selection;
  alignment: 'explicit' | 'same-grid' | 'inferred' | 'manual';
};
type Mark = z.infer<typeof reviewMarksSchema>[number];
type Seconds = z.infer<typeof time>;

export interface ReviewVersion {
  id: string;
  label: string;
  path: string;
  video?: CompiledVideo;
  timeline?: RevisionTimeline;
  exportIdentity?: string;
}
interface ReviewOptions extends Pick<
  RenderControls,
  'audioBitrateKbps' | 'audioChannels' | 'audioSampleRate'
> {
  output: string;
  marks?: Mark[] | undefined;
  notes?: z.infer<typeof reviewNotesSchema> | undefined;
  quality: RenderQuality;
  musicLoudness: 'matched' | 'authored';
  maxDimension: number;
  audioMixCacheDirectory?: string | undefined;
  audioComparison?: 'before' | 'after' | undefined;
  burnSubtitles?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: (progress: RenderProgress) => void;
}
type Inspected = ReviewVersion & {
  frameRate: FrameRate;
  frameCount: number;
  width: number;
  height: number;
  identity?: string;
};

const seconds = (frame: number, rate: FrameRate) =>
  (frame * rate.denominator) / rate.numerator;
const asTime = (value: Seconds) =>
  typeof value === 'number'
    ? parseSubtitleTime(value.toFixed(9))
    : parseSubtitleTime(value);
function resolveTimes(value: Mark | z.infer<typeof times>, rate: FrameRate) {
  const start = asTime(value.start);
  const end = asTime(value.end);
  if (compareTimes(start, end) >= 0)
    throw new MediaError(
      'A review mark needs an end time after its start time.',
    );
  const index = (
    { numerator, denominator }: ReturnType<typeof asTime>,
    roundUp = false,
  ) => {
    const n = BigInt(numerator) * BigInt(rate.numerator);
    const d = BigInt(denominator) * BigInt(rate.denominator);
    return Number((n + (roundUp ? d - 1n : 0n)) / d);
  };
  return { startFrame: index(start), endFrame: index(end, true) };
}

async function inspectVersion(
  version: ReviewVersion,
  signal?: AbortSignal,
): Promise<Inspected> {
  if (version.video) {
    const { width, height, frameRate } = version.video.project.settings;
    return {
      ...version,
      width,
      height,
      frameRate,
      frameCount: version.video.frameCount,
    };
  }
  const identity = videoInputIdentity(version.path);
  if (version.exportIdentity && version.exportIdentity !== identity)
    throw new SourceChangedError(
      version.path,
      'review export inspection',
      version.exportIdentity,
    );
  if (!identity)
    throw new MediaError(`Cannot read review MP4 '${version.path}'.`);
  const { metadata, frameCount } = await inspectEncodedPicture(
    version.path,
    signal,
  );
  const [numerator, denominator] = metadata.frameRateRatio
    .split('/')
    .map(Number) as [number, number];
  if (identity !== videoInputIdentity(version.path))
    throw new SourceChangedError(version.path, 'review inspection', identity);
  return {
    ...version,
    width: metadata.width,
    height: metadata.height,
    frameCount,
    frameRate: { numerator, denominator },
    identity,
  };
}

function resolveFrames(
  range: Selection,
  from: FrameRate,
  into: FrameRate,
): Selection {
  const n = BigInt(from.denominator) * BigInt(into.numerator);
  const d = BigInt(from.numerator) * BigInt(into.denominator);
  return {
    startFrame: Number((BigInt(range.startFrame) * n) / d),
    endFrame: Number((BigInt(range.endFrame) * n + d - 1n) / d),
  };
}

function inferRange(
  mark: Mark,
  before: RevisionTimeline,
  after: RevisionTimeline,
) {
  const { frameRate } = before;
  if (seconds(1, frameRate) !== seconds(1, after.frameRate)) return;
  const range = resolveTimes(mark, frameRate);
  const anchors = before.picture.filter(
    (item) =>
      item.alignmentKey &&
      item.startFrame <= range.startFrame &&
      item.endFrame >= range.endFrame,
  );
  if (anchors.length !== 1) return;
  const anchor = anchors[0]!;
  const matches = after.picture.filter(
    (item) =>
      item.id === anchor.id && item.alignmentKey === anchor.alignmentKey,
  );
  if (matches.length !== 1) return;
  const match = matches[0]!;
  const delta = match.startFrame - anchor.startFrame;
  if (range.endFrame + delta > match.endFrame) return;
  return {
    startFrame: range.startFrame + delta,
    endFrame: range.endFrame + delta,
  };
}

function selectRanges(before: Inspected, after: Inspected, marks?: Mark[]) {
  const comparison =
    before.timeline && after.timeline
      ? compareRevisionTimelines(before.timeline, after.timeline)
      : {
          alignment: 'manual' as const,
          reason: 'One version lacks compatible timeline metadata.',
          ranges: [],
        };
  if (!marks?.length && (!before.timeline || !after.timeline))
    throw new MediaError(
      'Supply --marks when either version lacks compatible timeline evidence.',
    );
  const selected =
    marks?.map((mark) => {
      const explicit = mark.candidates?.[after.id] ?? mark.candidate;
      const inferred =
        !explicit &&
        comparison.alignment === 'manual' &&
        before.timeline &&
        after.timeline &&
        inferRange(mark, before.timeline, after.timeline);
      return {
        name: mark.name,
        before: resolveTimes(mark, before.frameRate),
        after: inferred
          ? resolveFrames(inferred, after.timeline!.frameRate, after.frameRate)
          : resolveTimes(explicit ?? mark, after.frameRate),
        alignment: explicit
          ? ('explicit' as const)
          : inferred
            ? ('inferred' as const)
            : comparison.alignment,
      };
    }) ??
    comparison.ranges.flatMap(({ startFrame, endFrame }, i) => {
      const rate = after.timeline!.frameRate;
      const pad = Math.ceil(rate.numerator / rate.denominator / 2);
      const last = Math.min(
        before.timeline!.frameCount,
        after.timeline!.frameCount,
        endFrame + pad,
      );
      const first = Math.max(0, startFrame - pad);
      // Leave one frame of margin when converting to a different export grid.
      const step = Math.floor((29 * rate.numerator) / rate.denominator);
      const selections: ReviewSelection[] = [];
      if (last <= first || !step) return selections;
      for (let frame = first; frame < last; frame += step) {
        const selection = {
          startFrame: frame,
          endFrame: Math.min(last, frame + step),
        };
        selections.push({
          name:
            'Change ' +
            (i + 1) +
            (last - first > step ? ' at frame ' + frame : ''),
          before: resolveFrames(selection, rate, before.frameRate),
          after: resolveFrames(selection, rate, after.frameRate),
          alignment: comparison.alignment,
        });
      }
      return selections;
    });
  for (const { name, before: left, after: right } of selected) {
    for (const [range, version] of [
      [left, before],
      [right, after],
    ] as const) {
      if (
        range.startFrame < 0 ||
        range.endFrame > version.frameCount ||
        range.endFrame <= range.startFrame ||
        seconds(range.endFrame - range.startFrame, version.frameRate) > 30
      )
        throw new MediaError(
          `Review mark '${name}' must select up to 30 seconds inside '${version.label}'.`,
        );
    }
  }
  return { comparison, selected };
}

function reviewPlayer(json: unknown) {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCut revision review</title>
<style>
body{margin:2rem auto;padding:0 1rem;max-width:70rem;background:#131418;color:#f2f2f2;font:16px system-ui}
article{margin:2rem 0;padding-bottom:2rem;border-bottom:1px solid #444}
.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
video{display:block;max-width:100%;max-height:65vh;background:black;margin-top:.5rem}
button,select,input{font:inherit;margin:.75rem .5rem 0 0}input{width:min(18rem,45vw)}
a{color:#acc8ff}p{color:#d0d0d0}output{display:block;font-variant-numeric:tabular-nums}
</style><h1>OpenCut revision review</h1>
<p><a href="index.json">Review index and notes</a></p><main></main>
<script type="application/json" id="review">${JSON.stringify(json).replaceAll('<', '\\u003c')}</script>
<script>
const data = JSON.parse(document.querySelector('#review').textContent);
const main = document.querySelector('main');
function add(parent, tag, label) {
  const element = document.createElement(tag);
  if (label) element.textContent = label;
  parent.append(element);
  return element;
}
for (const candidate of data.candidates) {
  if (!candidate.marks.length) {
    const section = add(main, 'article');
    add(section, 'h2', candidate.label);
    add(section, 'p', candidate.changes.reason || 'No changed ranges were detected.');
  }
  for (const mark of candidate.marks) {
    const section = add(main, 'article');
    add(section, 'h2', mark.name + ' · ' + candidate.label);
    if (mark.alignment === 'manual') add(section, 'p', 'Check alignment before judging timing.');
    const pair = add(section, 'div');
    pair.className = 'pair';
    const [before, after] = [mark.before, mark.after].map((clip) => {
      const cell = add(pair, 'div', clip.label);
      const clock = add(cell, 'output');
      const video = add(cell, 'video');
      video.src = clip.file;
      video.preload = 'metadata';
      video.playsInline = true;
      const rate = clip.frameRate.numerator / clip.frameRate.denominator;
      const clockAt = (position) => {
        const frame = Math.min(clip.endFrame - 1, clip.startFrame + Math.floor(position * rate + .001));
        clock.textContent = (frame / rate).toFixed(3) + 's · frame ' + frame;
      };
      clockAt(0);
      if (video.requestVideoFrameCallback) {
        const update = (_, frame) => {
          clockAt(frame.mediaTime);
          video.requestVideoFrameCallback(update);
        };
        video.requestVideoFrameCallback(update);
      } else video.addEventListener('timeupdate', () => clockAt(video.currentTime));
      return video;
    });
    after.muted = true;
    const play = add(section, 'button', 'Play');
    const audio = add(section, 'select');
    audio.setAttribute('aria-label', 'Listen to');
    add(audio, 'option', 'Listen to baseline');
    add(audio, 'option', 'Listen to candidate');
    audio.onchange = () => { before.muted = audio.selectedIndex === 1; after.muted = !before.muted; };
    const seek = add(section, 'input');
    seek.type = 'range';
    seek.setAttribute('aria-label', 'Review position');
    seek.min = '0'; seek.max = '1000'; seek.value = '0';
    const videos = [before, after];
    const leader = () => before.duration >= after.duration ? before : after;
    const move = (time) => {
      for (const video of videos) video.currentTime = Math.min(video.duration, time);
    };
    seek.oninput = () => {
      const duration = leader().duration;
      if (duration) move(duration * Number(seek.value) / 1000);
    };
    const stop = () => { before.pause(); after.pause(); play.textContent = 'Play'; };
    play.onclick = () => {
      if (videos.some((video) => !video.paused)) { stop(); return; }
      if (videos.some((video) => !Number.isFinite(video.duration))) return;
      const main = leader();
      if (main.currentTime >= main.duration - .03) move(0);
      move(main.currentTime);
      Promise.all(videos.filter((video) => video.currentTime < video.duration).map((video) => video.play()))
        .then(() => { play.textContent = 'Pause'; }, stop);
    };
    for (const video of videos) {
      video.ontimeupdate = () => {
        if (video !== leader() || !video.duration) return;
        const time = video.currentTime;
        seek.value = String(1000 * Math.min(1, time / video.duration));
        const other = video === before ? after : before;
        if (!video.paused && !other.paused && time < other.duration &&
          Math.abs(time - other.currentTime) > .09) other.currentTime = time;
      };
      video.onended = () => { if (video === leader()) stop(); };
    }
    for (const clip of [mark.before, mark.after]) {
      const link = add(section, 'a', 'Open ' + clip.label + ' clip');
      link.href = clip.file;
      add(section, 'span', '  ');
    }
  }
}
</script></html>`;
}

/** Produce bounded, in-motion comparisons and publish the complete package together. */
export async function reviewVideoRevisions(
  baseline: ReviewVersion,
  candidates: ReviewVersion[],
  options: ReviewOptions,
) {
  const { signal } = options;
  const before = await inspectVersion(baseline, signal);
  const after = [];
  for (const version of candidates)
    after.push(await inspectVersion(version, signal));
  const marks = options.marks;
  const names = new Set(marks?.map(({ name }) => name));
  if (marks && names.size !== marks.length)
    throw new MediaError('Review mark names must be unique.');
  for (const mark of marks ?? [])
    for (const id of Object.keys(mark.candidates ?? {}))
      if (!after.some((version) => version.id === id))
        throw new MediaError(
          `Review mark '${mark.name}' names unknown version '${id}'.`,
        );
  const comparisons = after.map((version) =>
    selectRanges(before, version, marks),
  );
  for (const { range, version, timestamp } of options.notes ?? []) {
    if (
      range &&
      !comparisons.some(({ selected }) =>
        selected.some(({ name }) => range === name),
      )
    )
      throw new MediaError(`Review note names unknown range '${range}'.`);
    if (version && ![before, ...after].some(({ id }) => id === version))
      throw new MediaError(`Review note names unknown version '${version}'.`);
    if (timestamp !== undefined) asTime(timestamp);
  }
  const output = resolve(options.output);
  const stage = await mkdtemp(join(dirname(output), '.opencut-review-'));
  const work = join(stage, 'scratch');
  async function renderSelection(
    version: Inspected,
    range: Selection,
    { width, height }: { width: number; height: number },
    file: string,
    label: string,
  ) {
    signal?.throwIfAborted();
    const folder = await mkdtemp(join(work, 'clip-'));
    const raw = join(folder, 'preview.mp4');
    const preview = version.video
      ? await previewVideo(version.video).clip(range, raw, options)
      : undefined;
    await renderReviewClip({
      source: preview?.path ?? version.path,
      output: join(folder, file),
      width,
      height,
      signal,
      label,
      startSeconds: version.video
        ? 0
        : seconds(range.startFrame, version.frameRate),
      duration: seconds(range.endFrame - range.startFrame, version.frameRate),
      sourceFrame: range.startFrame,
      frameCount: range.endFrame - range.startFrame,
      frameRate: version.frameRate,
      onProgress: options.onProgress,
    });
    if (
      version.identity &&
      version.identity !== videoInputIdentity(version.path)
    )
      throw new SourceChangedError(
        version.path,
        'rendering review selection',
        version.identity,
      );
    await rename(join(folder, file), join(stage, file));
    await rm(folder, { recursive: true });
    return {
      file,
      label: version.label,
      ...range,
      frameRate: version.frameRate,
      startTime: frameTime(range.startFrame, version.frameRate),
      endTime: frameTime(range.endFrame, version.frameRate),
      ...(preview?.musicLoudness && { musicLoudness: preview.musicLoudness }),
      ...(preview?.audioMix && { audioMix: preview.audioMix }),
      ...(preview?.warnings && { warnings: preview.warnings }),
    };
  }
  const baselineClips = new Map<
    string,
    Awaited<ReturnType<typeof renderSelection>>
  >();
  let reserved = false;
  try {
    await mkdir(output);
    reserved = true;
    await mkdir(work);
    const entries = [];
    for (const [index, candidate] of after.entries()) {
      const { comparison, selected } = comparisons[index]!;
      const scale = Math.min(
        1,
        options.maxDimension / Math.max(candidate.width, candidate.height),
      );
      const width = Math.max(2, 2 * Math.floor((candidate.width * scale) / 2));
      const height = Math.max(
        2,
        2 * Math.floor((candidate.height * scale) / 2),
      );
      const generated = [];
      for (const [i, mark] of selected.entries()) {
        const key = [
          mark.before.startFrame,
          mark.before.endFrame,
          width,
          height,
        ].join('/');
        let baselineClip = baselineClips.get(key);
        if (!baselineClip) {
          baselineClip = await renderSelection(
            before,
            mark.before,
            { width, height },
            'baseline-' + (baselineClips.size + 1) + '.mp4',
            'Before',
          );
          baselineClips.set(key, baselineClip);
        }
        const candidateClip = await renderSelection(
          candidate,
          mark.after,
          { width, height },
          `candidate-${index + 1}-${i + 1}.mp4`,
          'After ' + (index + 1),
        );
        generated.push({
          name: mark.name,
          alignment: mark.alignment,
          before: baselineClip,
          after: candidateClip,
        });
      }
      entries.push({
        id: candidate.id,
        label: candidate.label,
        path: candidate.path,
        changes: comparison,
        marks: generated,
        sharedVoiceSettings:
          before.timeline && candidate.timeline
            ? before.timeline.voiceSettingsKey ===
              candidate.timeline.voiceSettingsKey
            : null,
        samePicture:
          before.timeline && candidate.timeline
            ? before.timeline.pictureKey === candidate.timeline.pictureKey
            : null,
        technicalChecks: [
          ...(generated.length
            ? ['decoded frame count', 'review canvas dimensions']
            : []),
          ...(before.timeline && candidate.timeline
            ? ['compared timeline dependencies']
            : []),
          ...(!before.video && before.exportIdentity
            ? ['verified baseline export fingerprint']
            : []),
          ...(!candidate.video && candidate.exportIdentity
            ? ['verified candidate export fingerprint']
            : []),
        ],
        viewing: 'pending',
        listening: 'pending',
      });
    }
    const result = {
      version: 1,
      baseline: { id: before.id, label: before.label, path: before.path },
      musicLoudness: options.musicLoudness,
      candidates: entries,
      notes: options.notes ?? [],
    };
    await rmdir(work);
    await writeFile(
      join(stage, 'index.json'),
      JSON.stringify(result, null, 2) + '\n',
      { signal },
    );
    await writeFile(join(stage, 'index.html'), reviewPlayer(result), {
      signal,
    });
    signal?.throwIfAborted();
    await rename(stage, output);
    reserved = false;
    return { ...result, output };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (reserved) await rmdir(output);
  }
}
