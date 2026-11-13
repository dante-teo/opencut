import { z } from 'zod';
import { textLayerSchema } from './text-style.js';
import type { Project } from './project.js';
import { compareTimes, addTimes, subtractTimes, timeSchema } from './time.js';
import { DEFAULT_TEXT_FONT, type TextLayer } from '@opencut/shared';
import type { RationalTime } from './time.js';
import type { VisualKeyframes } from '@opencut/shared';

export const subtitleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const subtitleStyleSchema = textLayerSchema
  .pick({
    fontFamily: true,
    embeddedFont: true,
    fontSize: true,
    color: true,
    stroke: true,
    shadow: true,
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
const wordsSchema = z
  .array(
    z.strictObject({
      from: z.int().nonnegative(),
      to: z.int().positive(),
      start: timeSchema,
      end: timeSchema,
    }),
  )
  .max(128);
export const subtitleTrackSchema = z.strictObject({
  style: subtitleStyleSchema,
  cues: z
    .array(
      subtitleCueInputSchema.extend({
        id: subtitleIdSchema,
        style: subtitleStyleSchema.optional(),
        pop: z.boolean().optional(),
        emphasis: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
        words: wordsSchema.optional(),
      }),
    )
    .max(MAX_SUBTITLE_CUES),
});
export type SubtitleCueInput = z.infer<typeof subtitleCueInputSchema>;
export type SubtitleTrack = z.infer<typeof subtitleTrackSchema>;
export type SubtitleCue = SubtitleTrack['cues'][number];
export type SubtitleStyle = SubtitleTrack['style'];

export function validSubtitleWords(cue: SubtitleCue, duration: RationalTime) {
  return (cue.words ?? []).every(
    (word, i, words) =>
      word.from < word.to &&
      word.to <= cue.text.length &&
      !!cue.text.slice(word.from, word.to).trim() &&
      !/\p{Cs}/u.test(cue.text.slice(word.from, word.to)) &&
      compareTimes(word.start, word.end) < 0 &&
      compareTimes(word.end, duration) <= 0 &&
      (!i ||
        (words[i - 1]!.to <= word.from &&
          compareTimes(words[i - 1]!.end, word.start) <= 0)),
  );
}

function trimWords(cue: SubtitleCue, start: RationalTime, end: RationalTime) {
  if (!cue.words?.length || compareTimes(start, end) >= 0) return [];
  return cue.words.flatMap((word) => {
    const a = addTimes(cue.start, word.start);
    const b = addTimes(cue.start, word.end);
    if (compareTimes(a, end) >= 0 || compareTimes(b, start) <= 0) return [];
    return [
      {
        ...word,
        start:
          compareTimes(a, start) < 0
            ? { numerator: 0, denominator: 1 }
            : subtractTimes(a, start),
        end: subtractTimes(compareTimes(b, end) > 0 ? end : b, start),
      },
    ];
  });
}

export const subtitleOperations = [
  z.strictObject({
    type: z.literal('subtitle.words'),
    id: subtitleIdSchema,
    words: wordsSchema,
  }),
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
    ids: z.array(subtitleIdSchema).min(1).max(MAX_SUBTITLE_CUES).optional(),
  }),
  z.strictObject({
    type: z.literal('subtitle.effects'),
    id: subtitleIdSchema,
    pop: z.boolean(),
    emphasis: z.array(z.string().trim().min(1).max(120)).max(20),
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
    const cue: SubtitleCue = {
      ...input,
      id,
      text: normalizeSubtitleText(input.text),
    };
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
        ...cue,
        start,
        end: compareTimes(end, cue.end) === 0 ? cue.end : end,
        text:
          operation.text === undefined
            ? cue.text
            : normalizeSubtitleText(operation.text),
      };
      if (cue.words)
        track.cues[index]!.words =
          track.cues[index]!.text === cue.text
            ? trimWords(cue, start, end)
            : [];
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
      const right = add(
        { start: operation.at, end: cue.end, text: cue.text },
        operation.rightId,
      );
      if (cue.style) right.style = cue.style;
      if (cue.pop) right.pop = cue.pop;
      if (cue.emphasis) right.emphasis = cue.emphasis;
      if (cue.words) {
        track.cues[index]!.words = trimWords(cue, cue.start, operation.at);
        right.words = trimWords(cue, operation.at, cue.end);
      }
      result = { right };
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
      // Overlapping cues can have simultaneous words. Clear timing on merge.
      delete merged.words;
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
      if (operation.ids) {
        for (const id of new Set(operation.ids)) {
          const index = indexOf(id);
          const cue = track.cues[index]!;
          track.cues[index] = {
            ...cue,
            style: { ...cue.style, ...operation.style },
          };
        }
      } else track.style = { ...track.style, ...operation.style };
      break;
    case 'subtitle.words': {
      const index = indexOf(operation.id);
      track.cues[index] = { ...track.cues[index]!, words: operation.words };
      break;
    }
    case 'subtitle.effects': {
      const index = indexOf(operation.id);
      track.cues[index] = {
        ...track.cues[index]!,
        pop: operation.pop,
        emphasis: operation.emphasis,
      };
      break;
    }
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
  override?: SubtitleStyle,
) {
  const style = { ...project.subtitles?.style, ...override };
  const { width, height } = project.settings;
  return {
    fontFamily: style.fontFamily ?? DEFAULT_TEXT_FONT,
    ...(style.embeddedFont && { embeddedFont: style.embeddedFont }),
    fontSize:
      style.fontSize ??
      Math.min(512, Math.max(12, Math.round(Math.min(width, height) * 0.055))),
    color: style.color ?? '#ffffff',
    stroke:
      style.stroke === undefined
        ? { color: '#000000', width: 2 }
        : style.stroke,
    background: style.background ?? null,
    shadow: style.shadow ?? null,
    x: style.x ?? 0,
    y: style.y ?? Math.round(height * 0.35),
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
  project: Pick<Project, 'settings' | 'subtitles'>,
) {
  let offset = 0;
  return subtitleLanes(cues).map((lane) => {
    let height = 0;
    let spacing = 0;
    const layers = lane.map((cue) => {
      const { x, y, ...style } = effectiveSubtitleStyle(project, cue.style);
      const padding =
        (style.background?.padding ?? 0) + (style.stroke?.width ?? 0);
      const text: TextLayer = {
        ...style,
        content: cue.text,
        ...(cue.emphasis?.length && { emphasis: cue.emphasis }),
      };
      const block =
        normalizeSubtitleText(cue.text).split('\n').length *
        style.fontSize *
        1.25;
      height = Math.max(height, block + padding * 2);
      spacing = Math.max(spacing, style.fontSize * 0.15);
      const duration = subtractTimes(cue.end, cue.start);
      const pop = { numerator: 3, denominator: 20 };
      const keyframes: VisualKeyframes | undefined = cue.pop
        ? {
            scale: [
              {
                time: { numerator: 0, denominator: 1 },
                value: 0.65,
                easing: 'ease-out',
              },
              {
                time: compareTimes(duration, pop) < 0 ? duration : pop,
                value: 1,
                easing: 'linear',
              },
            ],
          }
        : undefined;
      return {
        cue,
        text,
        keyframes,
        visual: {
          x,
          y: Math.max(-32768, y - offset - block / 2 - padding),
          scale: 1,
          opacity: 1,
          fit: 'contain' as const,
        },
      };
    });
    offset += height + spacing;
    return layers;
  });
}

type SubtitleTextSegment = ReturnType<
  typeof subtitleGroupTextLayers
>[number][number] & {
  id: string;
  start: RationalTime;
  end: RationalTime;
  subtitleCueId?: string;
  animationStart?: RationalTime;
};

export function subtitleTextLayers(
  project: Pick<Project, 'settings' | 'subtitles'>,
): SubtitleTextSegment[][] {
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
    const group = subtitleGroupTextLayers(cues.slice(first, last), project);
    for (const [lane, layers] of group.entries())
      (lanes[lane] ??= []).push(...layers);
    first = last;
  }
  return lanes.map((lane) =>
    lane.flatMap((layer) => {
      const { cue } = layer;
      const base = { ...layer, id: cue.id, start: cue.start, end: cue.end };
      if (!cue.words?.length) return [base];
      const result: SubtitleTextSegment[] = [];
      let cursor = cue.start;
      const append = (
        end: RationalTime,
        word?: NonNullable<TextLayer['activeWord']>,
      ) => {
        if (compareTimes(cursor, end) >= 0) return;
        result.push({
          ...base,
          id: `word:${cue.id}:${result.length}`,
          subtitleCueId: cue.id,
          ...(layer.keyframes && { animationStart: cue.start }),
          start: cursor,
          end,
          text: word ? { ...layer.text, activeWord: word } : layer.text,
        });
        cursor = end;
      };
      for (const word of cue.words) {
        const start = addTimes(cue.start, word.start);
        const end = addTimes(cue.start, word.end);
        append(start);
        const onset = { numerator: 1, denominator: 30 };
        if (compareTimes(subtractTimes(end, start), onset) > 0)
          append(addTimes(start, onset), {
            from: word.from,
            to: word.to,
            phase: 0,
          });
        append(end, { from: word.from, to: word.to, phase: 1 });
      }
      append(cue.end);
      return result;
    }),
  );
}
