import { z } from 'zod';
import { entityIdSchema } from './project.js';
import { addTimes, compareTimes, subtractTimes } from './time.js';
import type { RationalTime } from './time.js';
import { fileFingerprintSchema } from './video-integrity.js';
import { parseSubtitleTime } from './subtitle-formats.js';
import { validSubtitleWords } from './subtitles.js';
import type { NarrationSegment } from './narration.js';
import { VideoDefinitionError } from './video-definition.js';
import type { VideoDefinition } from './video-definition.js';

const seconds = z.number().nonnegative();
const timed = { start: seconds, end: seconds };
const interval = z.strictObject(timed).refine(({ start, end }) => end > start);
const word = z.strictObject({
  ...timed,
  from: z.int().nonnegative(),
  to: z.int().positive(),
});
const segment = z.strictObject({
  ...timed,
  id: entityIdSchema,
  text: z.string().max(4000),
  language: z.string().nullable(),
  words: z.array(word).default([]),
  review: z.array(z.string()).default([]),
});

export const transcriptSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({
    path: z.string(),
    fingerprint: fileFingerprintSchema,
  }),
  interval,
  backend: z.literal('qwen3'),
  segments: z.array(segment).max(10000),
});
export type Transcript = z.infer<typeof transcriptSchema>;
type Segment = Transcript['segments'][number];

export const speechBackendResultSchema = z.array(
  z.strictObject({
    text: z.string(),
    language: z.string().nullable(),
    words: z.array(z.strictObject({ ...timed, text: z.string() })),
    reason: z.string().nullable(),
  }),
);
type BackendResult = z.infer<typeof speechBackendResultSchema>[number];

export function validateTranscriptWindows(transcript: Transcript) {
  let previousEnd = transcript.interval.start;
  const ids = new Set<string>();
  for (const { id, start, end } of transcript.segments) {
    if (
      start < previousEnd ||
      end <= start ||
      end > transcript.interval.end ||
      end - start > 300
    )
      throw new VideoDefinitionError(
        `Segment '${id}' must be in order, within the selected source interval and at most five minutes long.`,
      );
    if (ids.has(id))
      throw new VideoDefinitionError(
        `Duplicate transcript segment ID '${id}'.`,
      );
    ids.add(id);
    previousEnd = end;
  }
}

function searchableText(text: string) {
  const letters: { value: string; from: number; to: number }[] = [];
  for (const { segment, index } of new Intl.Segmenter().segment(text)) {
    for (const value of Array.from(segment.normalize('NFKC').toLowerCase())) {
      if (/[\p{L}\p{M}\p{N}]/u.test(value))
        letters.push({ value, from: index, to: index + segment.length });
    }
  }
  return letters;
}

export function applyTranscriptTimings(
  segment: Segment,
  result: BackendResult,
  preserveText: boolean,
): Segment {
  const text = preserveText ? segment.text : result.text;
  const letters = searchableText(text);
  const values = letters.map(({ value }) => value);
  const words: Segment['words'] = [];
  const review = new Set(result.reason ? [result.reason] : []);
  let cursor = 0;
  let previousEnd = segment.start;
  let previousText = 0;
  for (const token of result.words) {
    const normalized = searchableText(token.text).map(({ value }) => value);
    if (!normalized.length) continue;
    const matches = (at: number) =>
      normalized.every((value, index) => values[at + index] === value);
    let next = cursor;
    while (next < letters.length && !matches(next)) next++;
    if (next >= letters.length) {
      review.add(`Unmatched alignment token ${JSON.stringify(token.text)}.`);
      continue;
    }
    if (next > cursor)
      review.add(
        `Review unaligned text at character ${letters[cursor]!.from}.`,
      );
    cursor = next + normalized.length;
    const from = letters[next]!.from;
    const to = letters[cursor - 1]!.to;
    const start = segment.start + token.start;
    const end = Math.min(segment.end, segment.start + token.end);
    if (
      end <= start ||
      start < previousEnd ||
      segment.start + token.end > segment.end + 0.001 ||
      from < previousText ||
      end - start < 0.02 ||
      end - start > 5
    ) {
      review.add(`Review timing at characters ${from}–${to}.`);
      continue;
    }
    words.push({ from, to, start, end });
    previousEnd = end;
    previousText = to;
  }
  if (cursor < letters.length)
    review.add(`Review unaligned text at character ${letters[cursor]!.from}.`);
  return {
    ...segment,
    text,
    language: result.language ?? segment.language,
    words,
    review: [...review],
  };
}

const exact = (seconds: number) =>
  parseSubtitleTime((Math.round(seconds * 1e6) / 1e6).toFixed(6));

/** Turn source-timed segments into subtitle cues at a new timeline placement. */
export function transcriptCues(input: Transcript, at?: RationalTime) {
  const transcript = transcriptSchema.parse(input);
  validateTranscriptWindows(transcript);
  const origin = exact(transcript.interval.start);
  const shifted = (seconds: number) =>
    addTimes(at ?? origin, subtractTimes(exact(seconds), origin));
  const cues: NonNullable<VideoDefinition['subtitles']>['cues'] = [];
  for (const segment of transcript.segments) {
    if (!segment.text.trim()) continue;
    // Use window bounds whenever the alignment leaves anything for review.
    const words = segment.review.length ? [] : segment.words;
    const start = words[0]?.start ?? segment.start;
    const end = words.at(-1)?.end ?? segment.end;
    if (compareTimes(exact(start), exact(end)) >= 0)
      throw new VideoDefinitionError(
        `Transcript segment '${segment.id}' has no playable duration.`,
      );
    const cue = {
      id: segment.id,
      text: segment.text,
      start: shifted(start),
      end: shifted(end),
      ...(words.length && {
        words: words.map(({ from, to, start: a, end: b }) => ({
          from,
          to,
          start: subtractTimes(exact(a), exact(start)),
          end: subtractTimes(exact(b), exact(start)),
        })),
      }),
    };
    if (!validSubtitleWords(cue, subtractTimes(cue.end, cue.start)))
      throw new VideoDefinitionError(
        `Transcript segment '${segment.id}' has invalid word timing. Realign it before exporting.`,
      );
    if ((cue.words?.length ?? 0) > 128)
      throw new VideoDefinitionError(
        `Transcript segment '${segment.id}' has more than 128 timed words. Split the segment before exporting.`,
      );
    cues.push(cue);
  }
  return cues;
}

/** Reuse one audio recording with source-relative narration clips and timed subtitles. */
export function transcriptNarrationSegments(
  transcript: Transcript,
  audio: string,
  at: RationalTime,
): NarrationSegment[] {
  const source = transcriptCues(transcript);
  const origin = exact(transcript.interval.start);
  return source.map((cue) => ({
    id: cue.id,
    audio,
    at: addTimes(at, subtractTimes(cue.start, origin)),
    sourceIn: cue.start,
    duration: subtractTimes(cue.end, cue.start),
    transcript: cue.text,
    ...(cue.words && { timings: cue.words }),
  }));
}
