import {
  clipTimelineEnd,
  clipTimelinePosition,
  clipSourcePosition,
  subtitleLanes,
  subtractTimes,
  type SubtitleCue,
  compareTimes,
  frameTime,
  type FrameRate,
  type Project,
  type RationalTime,
  type TimelineClip,
} from '@opencut/core';

export const ZERO: RationalTime = { numerator: 0, denominator: 1 };
export const ZOOM_LEVELS = [5, 10, 20, 40, 80, 160, 320, 640];
export const TRACK_HEIGHT = 64;
export const LABEL_WIDTH = 140;
export const RULER_HEIGHT = 30;
// Chromium limits layout dimensions. A compressed scrollbar covers longer sequences;
// the viewport itself always renders at the requested pixels per second.
export const MAX_SCROLL_WIDTH = 8_000_000;

/** Convert a screen coordinate once, at the UI boundary (millipixel precision). */
export function pixelTime(pixel: number, zoom: number): RationalTime {
  const scaled = Math.max(0, pixel) * 1000;
  if (scaled <= Number.MAX_SAFE_INTEGER)
    return { numerator: Math.round(scaled), denominator: zoom * 1000 };
  // At astronomical offsets the browser coordinate itself has no subsecond precision.
  return {
    numerator: Math.min(Number.MAX_SAFE_INTEGER, Math.round(pixel / zoom)),
    denominator: 1,
  };
}

export function relativePixels(
  time: RationalTime,
  origin: RationalTime,
  zoom: number,
) {
  return fractionPixels(
    BigInt(time.numerator),
    BigInt(time.denominator),
    origin,
    zoom,
  );
}

/** Subtract exactly before converting view geometry to pixels, without JSON limits. */
function fractionPixels(
  numerator: bigint,
  denominator: bigint,
  origin: RationalTime,
  zoom: number,
) {
  const relative =
    numerator * BigInt(origin.denominator) -
    BigInt(origin.numerator) * denominator;
  return (
    (Number(relative) / Number(denominator * BigInt(origin.denominator))) * zoom
  );
}

export function frameIndex(
  time: RationalTime,
  rate: FrameRate,
  nearest = false,
): bigint {
  const numerator = BigInt(time.numerator) * BigInt(rate.numerator);
  const denominator = BigInt(time.denominator) * BigInt(rate.denominator);
  return (numerator + (nearest ? denominator / 2n : 0n)) / denominator;
}

/** Non-drop nominal labels, using exact project-frame counts even at 30000/1001. */
export function timelineTimecode(time: RationalTime, rate: FrameRate) {
  return frameTimecode(frameIndex(time, rate), rate);
}

function frameTimecode(frame: bigint, rate: FrameRate) {
  const base = BigInt(
    Math.max(1, Math.round(rate.numerator / rate.denominator)),
  );
  return [
    frame / (base * 3600n),
    (frame / (base * 60n)) % 60n,
    (frame / base) % 60n,
    frame % base,
  ]
    .map((field) => String(field).padStart(2, '0'))
    .join(':');
}

export function clampTime(time: RationalTime, end: RationalTime) {
  return compareTimes(time, end) > 0 ? end : time;
}

/** Preserve exact core frame times whenever they fit; UI state stays JSON-safe otherwise. */
export function framePosition(frame: bigint, rate: FrameRate): RationalTime {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (frame <= limit) {
    try {
      return frameTime(Number(frame), rate);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  const numerator = frame * BigInt(rate.denominator);
  const denominator = BigInt(rate.numerator);
  if (numerator > limit * denominator)
    return { numerator: Number(limit), denominator: 1 };
  // Use the largest denominator that keeps both components safe. Round toward
  // the following instant so approximation does not label the preceding frame.
  const scale =
    numerator > denominator ? (limit * denominator) / numerator : limit;
  return {
    numerator: Number((numerator * scale + denominator - 1n) / denominator),
    denominator: Number(scale),
  };
}

export function snapToFrame(time: RationalTime, rate: FrameRate) {
  return framePosition(frameIndex(time, rate, true), rate);
}

export const isSubtitleLane = (id: string) => id.startsWith('subtitle:');

export function cueTimelineClip(
  cue: SubtitleCue,
  trackId: string,
): TimelineClip {
  return {
    id: cue.id,
    trackId,
    timelineStart: cue.start,
    sourceIn: ZERO,
    sourceOut: subtractTimes(cue.end, cue.start),
    text: { content: cue.text },
  };
}

/** Transient search indexes reference the original clips; the project remains the model. */
export function indexTimeline(project: Project | undefined) {
  const tracks = new Map<string, { clip: TimelineClip; end: RationalTime }[]>();
  const assets = new Map(project?.assets.map((asset) => [asset.id, asset]));
  let end = ZERO;
  if (project)
    for (const marker of project.markers ?? []) {
      const at = frameTime(marker.frame, project.settings.frameRate);
      if (compareTimes(at, end) > 0) end = at;
    }

  for (const clip of project?.clips ?? []) {
    const clipEnd = clipTimelineEnd(clip);
    if (compareTimes(clipEnd, end) > 0) end = clipEnd;
    let entries = tracks.get(clip.trackId);
    if (!entries) {
      entries = [];
      tracks.set(clip.trackId, entries);
    }
    entries.push({ clip, end: clipEnd });
  }
  for (const entries of tracks.values())
    entries.sort((a, b) =>
      compareTimes(a.clip.timelineStart, b.clip.timelineStart),
    );
  const subtitles = new Map<string, TimelineClip>();
  const subtitleTracks = subtitleLanes(project?.subtitles?.cues ?? []).map(
    (lane, i) => {
      const id = `subtitle:${i}`;
      tracks.set(
        id,
        lane.map((cue) => {
          const clip = cueTimelineClip(cue, id);
          subtitles.set(clip.id, clip);
          if (compareTimes(cue.end, end) > 0) end = cue.end;
          return { clip, end: cue.end };
        }),
      );
      return { id, type: 'subtitle' as const, name: 'Subtitles' };
    },
  );
  return {
    tracks,
    assets,
    end,
    subtitles,
    rows: [...(project?.tracks ?? []), ...subtitleTracks],
  };
}

/** Regular tracks and individual subtitle lanes have monotonic ends. */
export function visibleClips(
  clips: { clip: TimelineClip; end: RationalTime }[],
  start: RationalTime,
  end: RationalTime,
) {
  let low = 0;
  let high = clips.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareTimes(clips[middle]!.end, start) <= 0) low = middle + 1;
    else high = middle;
  }
  const visible = [];
  for (let i = low; i < clips.length; i++) {
    const entry = clips[i]!;
    if (compareTimes(entry.clip.timelineStart, end) >= 0) break;
    visible.push(entry);
  }
  return visible;
}

export function scrollGeometry(end: RationalTime, zoom: number, width: number) {
  const durationPixels = (end.numerator / end.denominator) * zoom;
  const logicalWidth = Math.max(
    width,
    durationPixels + Math.max(100, width / 2),
    zoom * 10,
  );
  const physicalWidth = Math.min(MAX_SCROLL_WIDTH, logicalWidth);
  const ratio = Math.max(
    1,
    (logicalWidth - width) / Math.max(1, physicalWidth - width),
  );
  return { physicalWidth, logicalWidth, ratio };
}

export function zoomScroll(
  scroll: number,
  anchor: number,
  before: number,
  after: number,
) {
  return Math.max(0, ((scroll + anchor) / before) * after - anchor);
}

export function rulerTicks(
  origin: RationalTime,
  width: number,
  zoom: number,
  rate: FrameRate,
) {
  const desired = ((110 / zoom) * rate.numerator) / rate.denominator;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, desired)));
  const interval = [1, 2, 5, 10]
    .map((factor) => factor * magnitude)
    .find((n) => n >= desired)!;
  const step = BigInt(Math.max(1, interval));
  const first = frameIndex(origin, rate) / step;
  const ticks = [];
  for (let i = first; ticks.length < Math.ceil(width / 80) + 4; i++) {
    const frame = i * step;
    const x = fractionPixels(
      frame * BigInt(rate.denominator),
      BigInt(rate.numerator),
      origin,
      zoom,
    );
    if (x > width) break;
    ticks.push({ frame, x, label: frameTimecode(frame, rate) });
  }
  return ticks;
}

export function sourceToTimeline(
  clip: TimelineClip,
  seconds: number,
  rate?: FrameRate,
): RationalTime {
  const source = {
    numerator: Math.max(0, Math.round(seconds * 1_000_000)),
    denominator: 1_000_000,
  };
  if (compareTimes(source, clip.sourceIn) < 0) return clip.timelineStart;
  if (compareTimes(source, clip.sourceOut) >= 0) return clipTimelineEnd(clip);
  const { numerator, denominator } = clipTimelinePosition(clip, source);
  const clock = rate ?? { numerator: 1_000_000, denominator: 1 };
  const frameNumerator = numerator * BigInt(clock.numerator);
  const frameDenominator = denominator * BigInt(clock.denominator);
  const frame = (frameNumerator + frameDenominator / 2n) / frameDenominator;
  const snapped = framePosition(frame, clock);
  return compareTimes(snapped, clip.timelineStart) < 0
    ? clip.timelineStart
    : clampTime(snapped, clipTimelineEnd(clip));
}

export function timelineToSource(
  clip: TimelineClip,
  time: RationalTime,
): number | undefined {
  if (
    compareTimes(time, clip.timelineStart) < 0 ||
    compareTimes(time, clipTimelineEnd(clip)) >= 0
  )
    return undefined;
  const { numerator, denominator } = clipSourcePosition(clip, time);
  return Number(numerator) / Number(denominator);
}
