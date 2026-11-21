import { z } from 'zod';
import { entityIdSchema } from './project.js';
import { compareTimes, timeSchema } from './time.js';

export const audioAnalysisSchema = z
  .strictObject({
    version: z.literal(1),
    source: z.union([
      z.literal('mix'),
      z.strictObject({ track: entityIdSchema }),
    ]),
    window: z.literal([512, 1024, 2048, 4096]),
    hop: z.int().min(256).max(4096),
    waveform: z.int().min(2).max(192),
    bins: z.int().min(2).max(96),
    beats: z
      .array(timeSchema)
      .max(1024)
      .refine(
        (beats) =>
          beats.every(
            (beat, i) => i === 0 || compareTimes(beats[i - 1]!, beat) < 0,
          ),
        'Beat markers must be in strictly increasing timeline order.',
      )
      .optional(),
  })
  .refine(
    ({ window, hop }) => hop <= window,
    'Analysis hop must be at most the window size.',
  );
