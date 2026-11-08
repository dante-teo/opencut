import { compareTimes, rationalTime, timeSchema } from './time.js';
import type { RationalTime } from './time.js';
import {
  MAX_SUBTITLE_CUES,
  normalizeSubtitleText,
  sortSubtitleCues,
  subtitleCueInputSchema,
} from './subtitles.js';
import type { SubtitleCueInput } from './subtitles.js';

export type SubtitleFormat = 'srt' | 'vtt';

export class SubtitleError extends Error {
  override name = 'SubtitleError';
}

export function subtitleFormat(path: string): SubtitleFormat {
  const extension = /\.(srt|vtt)$/i.exec(path)?.[1]?.toLowerCase();
  if (extension === 'srt' || extension === 'vtt') return extension;
  throw new SubtitleError('Choose a filename ending in .srt or .vtt.');
}

function timestamp(value: string): RationalTime {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59)
    throw new SubtitleError(`Invalid subtitle timestamp '${value}'.`);
  return rationalTime(
    ((BigInt(match[1] ?? 0) * 60n + BigInt(match[2]!)) * 60n +
      BigInt(match[3]!)) *
      1000n +
      BigInt(match[4]!.padEnd(3, '0')),
    1000n,
  );
}

/** UI timing fields accept a timestamp, decimal seconds or an exact fraction. */
export function parseSubtitleTime(value: string): RationalTime {
  const input = value.trim();
  if (input.includes(':')) return timestamp(input);
  const fraction = /^(\d+)\/([1-9]\d*)$/.exec(input);
  if (fraction) return rationalTime(BigInt(fraction[1]!), BigInt(fraction[2]!));
  const decimal = /^(\d+)(?:\.(\d{1,9}))?$/.exec(
    input.startsWith('.') ? '0' + input : input,
  );
  if (decimal) {
    const places = decimal[2] ?? '';
    return rationalTime(
      BigInt(decimal[1]! + places),
      10n ** BigInt(places.length),
    );
  }
  throw new SubtitleError(
    'Enter a timestamp, decimal seconds or an exact fraction.',
  );
}

const escapes = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
  lrm: '\u200e',
  rlm: '\u200f',
};
function vttText(payload: string) {
  return payload
    .replace(/<\/?(?:b|i|u|c|v|lang|ruby|rt)(?=[\s.>])[^<>]*>|<\d[\d:.]*>/g, '')
    .replace(
      /&(amp|lt|gt|nbsp|lrm|rlm|#\d+|#[xX][\da-fA-F]+);/g,
      (_, entity: string) => {
        if (!entity.startsWith('#'))
          return escapes[entity as keyof typeof escapes];
        const digits = entity.slice(1);
        const code = /^[xX]/.test(digits)
          ? parseInt(digits.slice(1), 16)
          : Number(digits);
        return code === 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
          ? '\uFFFD'
          : String.fromCodePoint(code);
      },
    );
}

export function parseSubtitles(
  data: string,
  format: SubtitleFormat,
): SubtitleCueInput[] {
  const text = normalizeSubtitleText(data.replace(/^\uFEFF/, ''));
  let first = 0;
  let last = text.length;
  while (first < last && text[first] === '\n') first++;
  while (last > first && text[last - 1] === '\n') last--;
  const blocks = text
    .slice(first, last)
    .split(format === 'srt' ? /\n(?:[ \t]*\n)+/ : /\n{2,}/);
  if (format === 'vtt') {
    const header = blocks.shift()!;
    if (
      !/^WEBVTT(?:[ \t][^\n]*)?(?:\n[^\n]*)*$/.test(header) ||
      header.includes('-->')
    )
      throw new SubtitleError(
        'Expected a WEBVTT header followed by a blank line before the first cue.',
      );
  }
  const cues: SubtitleCueInput[] = [];
  for (const [index, block] of blocks.entries()) {
    if (
      !block.trim() ||
      (format === 'vtt' &&
        /^(?:NOTE(?:[ \t][^\n]*)?|STYLE|REGION)(?:\n|$)/.test(block))
    )
      continue;
    const lines = block.split('\n');
    const timing =
      format === 'srt'
        ? /^\s*\d+\s*$/.test(lines[0]!)
          ? 1
          : 0
        : lines[0]!.includes('-->')
          ? 0
          : 1;
    const match =
      /^[ \t]*([\d:.,]+)[ \t]*-->[ \t]*([\d:.,]+)(?:[ \t].*)?$/.exec(
        lines[timing] ?? '',
      );
    try {
      if (!match) throw new SubtitleError('Expected a cue timing line.');
      const start = timestamp(match[1]!);
      const end = timestamp(match[2]!);
      if (compareTimes(end, start) <= 0)
        throw new SubtitleError('End must be later than start.');
      const payload = lines.slice(timing + 1).join('\n');
      const text = format === 'vtt' ? vttText(payload) : payload;
      if (!subtitleCueInputSchema.shape.text.safeParse(text).success)
        throw new SubtitleError(
          'Cue text must use printable Unicode and fit within 4096 UTF-16 code units.',
        );
      cues.push({ start, end, text });
      if (cues.length > MAX_SUBTITLE_CUES)
        throw new SubtitleError(
          `At most ${MAX_SUBTITLE_CUES} cues are supported.`,
        );
    } catch (cause) {
      throw new SubtitleError(
        `Subtitle block ${index + 1}: ${(cause as Error).message}`,
        { cause },
      );
    }
  }
  return cues;
}

function milliseconds(time: RationalTime) {
  timeSchema.parse(time);
  const denominator = BigInt(time.denominator);
  return (BigInt(time.numerator) * 1000n + denominator / 2n) / denominator;
}

function formatTimestamp(ms: bigint, format: SubtitleFormat) {
  const [hours, minutes, seconds, fraction] = [
    ms / 3600000n,
    (ms / 60000n) % 60n,
    (ms / 1000n) % 60n,
    ms % 1000n,
  ].map((value, index) => String(value).padStart(index === 3 ? 3 : 2, '0'));
  return `${hours}:${minutes}:${seconds}${format === 'srt' ? ',' : '.'}${fraction}`;
}

export function serializeSubtitles(
  cues: readonly SubtitleCueInput[],
  format: SubtitleFormat,
) {
  const timed = sortSubtitleCues(cues).map((cue, index) => {
    if (compareTimes(cue.end, cue.start) <= 0)
      throw new SubtitleError(`Cue ${index + 1} must end after it starts.`);
    let start = milliseconds(cue.start);
    let end = milliseconds(cue.end);
    if (start === end) {
      // Keep the interval nonempty and move neither boundary by a full millisecond.
      if (
        BigInt(cue.start.numerator) * 1000n <
        start * BigInt(cue.start.denominator)
      )
        start--;
      else end++;
    }
    // The rounded timestamps must be representable when read back into a project.
    rationalTime(start, 1000n);
    rationalTime(end, 1000n);
    let text = normalizeSubtitleText(
      subtitleCueInputSchema.shape.text.parse(cue.text),
    );
    if (
      text &&
      (format === 'srt'
        ? /(?:^|\n)[ \t]*(?:\n|$)/.test(text)
        : /(?:^|\n)(?:\n|$)/.test(text))
    )
      throw new SubtitleError(
        `Cue ${index + 1} contains a blank line. SRT and WebVTT use blank lines to separate cues.`,
      );
    if (format === 'vtt')
      text = text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return { start, end, text };
  });
  // A rounded short cue can move to the preceding millisecond.
  timed.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const blocks = timed.map(({ start, end, text }, index) => {
    const timing = `${formatTimestamp(start, format)} --> ${formatTimestamp(end, format)}`;
    return [format === 'srt' ? String(index + 1) : null, timing, text || null]
      .filter((line) => line !== null)
      .join('\n');
  });
  return (
    (format === 'vtt' ? 'WEBVTT\n\n' : '') +
    (blocks.length ? blocks.join('\n\n') + '\n' : '')
  );
}
