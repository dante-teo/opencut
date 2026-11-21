import { z } from 'zod';
import { describeAuthoredClips } from './video-compiler.js';
import { parseVideoDefinition } from './video-definition.js';
import { readVideoInput } from './video-files.js';
import { listTimeline } from './timeline-view.js';
import type { Project } from './project.js';
import { frameRateSchema, timeSchema } from './time.js';

const interval = z.object({
  id: z.string(),
  start: timeSchema,
  end: timeSchema,
});
export const contactTimelineSchema = z.object({
  frameRate: frameRateSchema,
  clips: z.array(interval),
  captions: z.array(interval),
});
export type ContactTimeline = z.infer<typeof contactTimelineSchema>;

export function describeProjectContactTimeline(
  project: Project,
): ContactTimeline {
  const timeline = listTimeline(project);
  return {
    frameRate: timeline.frameRate,
    clips: timeline.tracks
      .filter((track) => track.type === 'video')
      .flatMap(({ clips }) =>
        clips.map(({ id, timelineStart: start, timelineEnd: end }) => ({
          id,
          start,
          end,
        })),
      ),
    captions: (timeline.subtitles?.cues ?? []).map(({ id, start, end }) => ({
      id,
      start,
      end,
    })),
  };
}

export async function readDefinitionContactTimeline(
  file: string,
  options: { signal: AbortSignal; params?: unknown },
): Promise<ContactTimeline> {
  const { value } = await readVideoInput(file, options);
  const definition = parseVideoDefinition(value);
  const rate = definition.canvas.frameRate;
  const frameRate =
    typeof rate === 'number' ? { numerator: rate, denominator: 1 } : rate;
  return {
    frameRate,
    clips: describeAuthoredClips(definition, frameRate),
    captions: (definition.subtitles?.cues ?? []).map(({ id, start, end }) => ({
      id,
      start,
      end,
    })),
  };
}
