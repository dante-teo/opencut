import { describe, expect, it } from 'vitest';
import { buildNarration } from './narration.js';
import {
  applyTranscriptTimings,
  transcriptCues,
  transcriptNarrationSegments,
} from './transcript.js';
import type { Transcript } from './transcript.js';

const segment = {
  id: 'speech-1',
  start: 9,
  end: 12,
  text: '割胶哪里有这样 Fashion 哦！',
  language: 'Chinese',
  words: [],
  review: [],
};
const input = (
  part: typeof segment | Transcript['segments'][number],
): Transcript => ({
  version: 1,
  source: {
    path: '/audio.wav',
    fingerprint: { bytes: 1, sha256: 'a'.repeat(64) },
  },
  interval: { start: 9, end: 12 },
  backend: 'qwen3',
  segments: [part],
});

describe('transcript timing', () => {
  it('keeps edited mixed-language text and stable IDs, and flags missing spans', () => {
    const aligned = applyTranscriptTimings(
      segment,
      {
        text: 'ignored',
        language: 'Chinese',
        reason: null,
        words: [
          { text: '割', start: 0.1, end: 0.2 },
          { text: '胶', start: 0.2, end: 0.3 },
          { text: 'FASHION', start: 1, end: 1.5 },
          { text: '哦', start: 2.8, end: 3.2 },
        ],
      },
      true,
    );
    expect(aligned.text).toBe(segment.text);
    expect(aligned.id).toBe(segment.id);
    expect(
      aligned.words.map(({ from, to }) => aligned.text.slice(from, to)),
    ).toEqual(['割', '胶', 'Fashion']);
    expect(aligned.review).toHaveLength(2);
    const [cue] = transcriptCues(input(aligned));
    expect(cue).toMatchObject({
      start: { numerator: 9, denominator: 1 },
      text: segment.text,
    });
  });

  it('turns an aligned excerpt into narration at a new timeline placement', () => {
    const aligned = applyTranscriptTimings(
      { ...segment, text: 'Fashion！' },
      {
        text: '',
        language: 'Chinese',
        reason: null,
        words: [{ text: 'Fashion', start: 1, end: 2 }],
      },
      true,
    );
    const narration = buildNarration(
      transcriptNarrationSegments(input(aligned), 'voice.wav', {
        numerator: 4,
        denominator: 1,
      }),
    );
    expect(narration.clips[0]).toMatchObject({
      at: { numerator: 5, denominator: 1 },
      sourceIn: { numerator: 10, denominator: 1 },
      sourceOut: { numerator: 11, denominator: 1 },
    });
    expect(narration.cues[0]?.words).toEqual([
      {
        from: 0,
        to: 7,
        start: { numerator: 0, denominator: 1 },
        end: { numerator: 1, denominator: 1 },
      },
    ]);
  });
});
