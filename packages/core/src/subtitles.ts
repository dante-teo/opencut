import { z } from 'zod';
import { textLayerSchema } from './text-style.js';
import type { Project } from './project.js';
import { compareTimes, addTimes, subtractTimes, timeSchema } from './time.js';
import { DEFAULT_TEXT_FONT, type TextLayer } from '@opencut/shared';

export const subtitleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const subtitleStyleSchema = textLayerSchema
  .pick({
    fontFamily: true,
    fontSize: true,
    color: true,
    stroke: true,
    background: true,
  })
  .extend({
    x: z.number().min(-32768).max(32768).optional(),
    y: z.number().min(-32768).max(32768).optional(),
  });
export const subtitleCueInputSchema = z.strictObject({
  start: timeSchema,
  end: timeSchema,
  text: textLayerSchema.shape.content.refine(
    (value) => !/\p{Cs}/u.test(value),
    'Use valid Unicode text.',
  ),
});
export const MAX_SUBTITLE_CUES = 20000;
export const subtitleTrackSchema = z.strictObject({
  style: subtitleStyleSchema,
  cues: z
    .array(subtitleCueInputSchema.extend({ id: subtitleIdSchema }))
    .max(MAX_SUBTITLE_CUES),
});
export type SubtitleCueInput = z.infer<typeof subtitleCueInputSchema>;
export type SubtitleTrack = z.infer<typeof subtitleTrackSchema>;
export type SubtitleCue = SubtitleTrack['cues'][number];
export type SubtitleStyle = SubtitleTrack['style'];

export const subtitleOperations = [
  z.strictObject({
    type: z.literal('subtitle.import'),
    cues: z.array(subtitleCueInputSchema).max(MAX_SUBTITLE_CUES),
  }),
  subtitleCueInputSchema.extend({
    type: z.literal('subtitle.add'),
    id: subtitleIdSchema.optional(),
  }),
  subtitleCueInputSchema.partial().extend({
    type: z.literal('subtitle.set'),
    id: subtitleIdSchema,
    duration: timeSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('subtitle.move'),
    id: subtitleIdSchema,
    start: timeSchema,
  }),
  z.strictObject({
    type: z.literal('subtitle.split'),
    id: subtitleIdSchema,
    at: timeSchema,
    rightId: subtitleIdSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('subtitle.merge'),
    ids: z.array(subtitleIdSchema).min(2).max(MAX_SUBTITLE_CUES),
  }),
  z.strictObject({ type: z.literal('subtitle.remove'), id: subtitleIdSchema }),
  z.strictObject({
    type: z.literal('subtitle.style'),
    style: subtitleStyleSchema,
  }),
] as const;
type SubtitleOperation = z.infer<(typeof subtitleOperations)[number]>;

export function editSubtitles(project: Project, operation: SubtitleOperation) {
  if (operation.type === 'subtitle.import' && !operation.cues.length)
    return { project, ids: [] };
  const track = {
    style: project.subtitles?.style ?? {},
    cues: [...(project.subtitles?.cues ?? [])],
  };
  const indexOf = (id: string) => {
    const index = track.cues.findIndex((cue) => cue.id === id);
    if (index === -1) throw new Error(`Subtitle cue '${id}' does not exist.`);
    return index;
  };
  const add = (
    input: SubtitleCueInput,
    id: string = globalThis.crypto.randomUUID(),
  ) => {
    const cue = { ...input, id, text: normalizeSubtitleText(input.text) };
    track.cues.push(cue);
    return cue;
  };
  let result: Record<string, unknown> = {};
  switch (operation.type) {
    case 'subtitle.import':
      result = { ids: operation.cues.map((cue) => add(cue).id) };
      break;
    case 'subtitle.add':
      result = {
        cue: add(
          { start: operation.start, end: operation.end, text: operation.text },
          operation.id,
        ),
      };
      break;
    case 'subtitle.set': {
      const index = indexOf(operation.id);
      const cue = track.cues[index]!;
      const start =
        operation.start && compareTimes(operation.start, cue.start) !== 0
          ? operation.start
          : cue.start;
      if (operation.end && operation.duration)
        throw new Error('Specify either end or duration.');
      const end = operation.duration
        ? addTimes(start, operation.duration)
        : (operation.end ?? cue.end);
      track.cues[index] = {
        id: cue.id,
        start,
        end: compareTimes(end, cue.end) === 0 ? cue.end : end,
        text:
          operation.text === undefined
            ? cue.text
            : normalizeSubtitleText(operation.text),
      };
      break;
    }
    case 'subtitle.move': {
      const index = indexOf(operation.id);
      const cue = track.cues[index]!;
      if (compareTimes(operation.start, cue.start) === 0) return { project };
      track.cues[index] = {
        ...cue,
        start: operation.start,
        end: addTimes(operation.start, subtractTimes(cue.end, cue.start)),
      };
      break;
    }
    case 'subtitle.split': {
      const index = indexOf(operation.id);
      const cue = track.cues[index]!;
      if (
        compareTimes(operation.at, cue.start) <= 0 ||
        compareTimes(operation.at, cue.end) >= 0
      )
        throw new Error('Split time must be strictly inside the cue.');
      track.cues[index] = { ...cue, end: operation.at };
      result = {
        right: add(
          { text: cue.text, start: operation.at, end: cue.end },
          operation.rightId,
        ),
      };
      break;
    }
    case 'subtitle.merge': {
      const ids = new Set(operation.ids);
      const cues = sortSubtitleCues(
        track.cues.filter((cue) => ids.has(cue.id)),
      );
      if (cues.length !== operation.ids.length)
        throw new Error('Merge requires distinct, existing cue IDs.');
      const first = cues[0]!;
      const end = cues.reduce(
        (latest, cue) => (compareTimes(cue.end, latest) > 0 ? cue.end : latest),
        first.end,
      );
      const merged = {
        ...first,
        end,
        text: cues
          .map((cue) => cue.text)
          .filter(Boolean)
          .join('\n'),
      };
      track.cues = track.cues
        .filter((cue) => !ids.has(cue.id) || cue.id === first.id)
        .map((cue) => (cue.id === first.id ? merged : cue));
      result = { cue: merged };
      break;
    }
    case 'subtitle.remove':
      track.cues.splice(indexOf(operation.id), 1);
      break;
    case 'subtitle.style':
      track.style = {
        ...track.style,
        ...Object.fromEntries(
          Object.entries(operation.style).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };
      break;
  }
  return { project: { ...project, subtitles: track }, ...result };
}

export const normalizeSubtitleText = (text: string) =>
  text.replace(/\r\n?/g, '\n');

export function sortSubtitleCues<T extends SubtitleCueInput>(
  cues: readonly T[],
): T[] {
  return [...cues].sort((a, b) => compareTimes(a.start, b.start));
}

export function effectiveSubtitleStyle(
  project: Pick<Project, 'settings' | 'subtitles'>,
) {
  const style = project.subtitles?.style;
  const { width, height } = project.settings;
  return {
    fontFamily: style?.fontFamily ?? DEFAULT_TEXT_FONT,
    fontSize:
      style?.fontSize ??
      Math.min(512, Math.max(12, Math.round(Math.min(width, height) * 0.055))),
    color: style?.color ?? '#ffffff',
    stroke:
      style?.stroke === undefined
        ? { color: '#000000', width: 2 }
        : style.stroke,
    background: style?.background ?? null,
    x: style?.x ?? 0,
    y: style?.y ?? Math.round(height * 0.35),
  };
}

/** Partition overlaps into display lanes. A release at the start time frees its lane. */
export function subtitleLanes(cues: readonly SubtitleCue[]): SubtitleCue[][] {
  const lanes: SubtitleCue[][] = [];
  const occupied = new Map<SubtitleCue, number>();
  const available: number[] = [];
  // A min-heap keeps lone cues on the lowest free lane without scanning overlaps.
  function release(lane: number) {
    let i = available.length;
    available.push(lane);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (available[parent]! <= lane) break;
      available[i] = available[parent]!;
      i = parent;
    }
    available[i] = lane;
  }
  function nextLane() {
    const first = available[0] ?? lanes.length;
    const last = available.pop();
    if (last === undefined || available.length === 0) return first;
    let i = 0;
    while (i * 2 + 1 < available.length) {
      const left = i * 2 + 1;
      const right = left + 1;
      const child =
        right < available.length && available[right]! < available[left]!
          ? right
          : left;
      if (available[child]! >= last) break;
      available[i] = available[child]!;
      i = child;
    }
    available[i] = last;
    return first;
  }
  const events = cues
    .flatMap((cue) => [
      { cue, time: cue.start, start: true },
      { cue, time: cue.end, start: false },
    ])
    .sort(
      (a, b) =>
        compareTimes(a.time, b.time) || Number(a.start) - Number(b.start),
    );
  for (const { cue, start } of events) {
    if (start) {
      const lane = nextLane();
      (lanes[lane] ??= []).push(cue);
      occupied.set(cue, lane);
    } else {
      release(occupied.get(cue)!);
      occupied.delete(cue);
    }
  }
  return lanes;
}

function subtitleGroupTextLayers(
  cues: readonly SubtitleCue[],
  { x, y, ...style }: ReturnType<typeof effectiveSubtitleStyle>,
) {
  const padding = (style.background?.padding ?? 0) + (style.stroke?.width ?? 0);
  let offset = 0;
  return subtitleLanes(cues).map((lane) => {
    let height = 0;
    const layers = lane.map((cue) => {
      const text: TextLayer = { ...style, content: cue.text };
      const block =
        normalizeSubtitleText(cue.text).split('\n').length *
        style.fontSize *
        1.25;
      height = Math.max(height, block + padding * 2);
      return {
        cue,
        text,
        visual: {
          x,
          y: Math.max(-32768, y - offset - block / 2 - padding),
          scale: 1,
          opacity: 1,
          fit: 'contain' as const,
        },
      };
    });
    offset += height + style.fontSize * 0.15;
    return layers;
  });
}

export function subtitleTextLayers(
  project: Pick<Project, 'settings' | 'subtitles'>,
) {
  const style = effectiveSubtitleStyle(project);
  const cues = sortSubtitleCues(
    project.subtitles?.cues.filter((cue) => cue.text !== '') ?? [],
  );
  const lanes: ReturnType<typeof subtitleGroupTextLayers> = [];
  // Keep a stack stable while any cues overlap. A gap or a touching boundary
  // starts a new stack with its own lane heights.
  for (let first = 0; first < cues.length;) {
    let last = first + 1;
    let end = cues[first]!.end;
    while (last < cues.length && compareTimes(cues[last]!.start, end) < 0) {
      const cue = cues[last++]!;
      if (compareTimes(cue.end, end) > 0) end = cue.end;
    }
    const group = subtitleGroupTextLayers(cues.slice(first, last), style);
    for (const [lane, layers] of group.entries())
      (lanes[lane] ??= []).push(...layers);
    first = last;
  }
  return lanes;
}
