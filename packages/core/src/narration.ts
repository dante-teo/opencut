import { z } from 'zod';
import { entityIdSchema, relativeMediaPathSchema } from './project.js';
import {
  subtitleCueInputSchema,
  subtitleTrackSchema,
  validSubtitleWords,
} from './subtitles.js';
import { addTimes, timeSchema } from './time.js';
import { VideoDefinitionError } from './video-definition.js';
import type { VideoDefinition } from './video-definition.js';

const segmentSchema = z.strictObject({
  id: entityIdSchema,
  audio: relativeMediaPathSchema,
  at: timeSchema,
  duration: timeSchema,
  transcript: subtitleCueInputSchema.shape.text,
  timings: subtitleTrackSchema.shape.cues.element.shape.words,
});

export type NarrationSegment = z.input<typeof segmentSchema>;
type AudioTrack = Extract<VideoDefinition['tracks'][number], { type: 'audio' }>;
type Cue = NonNullable<VideoDefinition['subtitles']>['cues'][number];

/** Build audio assets, audio clips and subtitle cues from the same recording manifest. */
export function buildNarration(segments: readonly NarrationSegment[]) {
  const assets: Record<string, { kind: 'audio'; path: string }> = {};
  const clips: AudioTrack['clips'] = [];
  const cues: Cue[] = [];

  for (const [index, input] of segments.entries()) {
    const parsed = segmentSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new VideoDefinitionError(
        `Narration segment ${index + 1} ${issue.path.join('.')}: ${issue.message}`,
      );
    }
    const { id, audio, at, duration, transcript, timings } = parsed.data;
    const asset = `narration-audio-${id}`;
    if (Object.hasOwn(assets, asset))
      throw new VideoDefinitionError(`Duplicate narration segment '${id}'.`);
    if (!duration.numerator)
      throw new VideoDefinitionError(
        `Narration segment '${id}' requires a positive duration.`,
      );
    const cue = {
      id: `narration-cue-${id}`,
      start: at,
      end: addTimes(at, duration),
      text: transcript,
      ...(timings && { words: timings }),
    };
    if (!validSubtitleWords(cue, duration))
      throw new VideoDefinitionError(
        `Narration segment '${id}' has invalid timings. Use ordered, nonoverlapping text ranges and times within the segment duration.`,
      );
    assets[asset] = { kind: 'audio', path: audio };
    clips.push({ id: `narration-clip-${id}`, asset, at, sourceOut: duration });
    cues.push(cue);
  }

  return { assets, clips, cues };
}
