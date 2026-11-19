import { audioRoles, deliveryPresets, dialoguePresets } from '@opencut/shared';
import { z } from 'zod';

const amount = z.number().min(0).max(1);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const curve = z
  .array(
    z.strictObject({
      sample: z.int().min(0).max(28_800_000),
      db: z.number().min(-60).max(24),
    }),
  )
  .max(12000)
  .refine(
    (keys) =>
      keys.every((key, i) => i === 0 || key.sample > keys[i - 1]!.sample),
    'Mix automation samples must strictly increase.',
  );

export const professionalMixSchema = z.strictObject({
  preset: z.enum(dialoguePresets),
  enabled: z.boolean().optional(),
  cleanup: amount.optional(),
  warmth: amount.optional(),
  clarity: amount.optional(),
  consistency: amount.optional(),
  dialogueLufs: z.number().min(-40).max(-10).optional(),
  highPassHz: z.number().min(0).max(250).optional(),
  eq: z
    .array(
      z.strictObject({
        frequency: z.number().min(40).max(16000),
        q: z.number().min(0.2).max(12),
        db: z.number().min(-18).max(18),
      }),
    )
    .max(8)
    .optional(),
  deEsser: amount.optional(),
  compressor: z
    .strictObject({
      thresholdDb: z.number().min(-50).max(0),
      ratio: z.number().min(1).max(8),
      attackMs: z.number().min(1).max(200),
      releaseMs: z.number().min(5).max(2000),
    })
    .optional(),
  ai: z.literal('deepfilternet').optional(),
  dereverb: amount.optional(),
  matching: z.strictObject({ amount, referenceClip: id.optional() }).optional(),
  crossfadeMs: z.number().min(0).max(250).optional(),
  ducking: z
    .strictObject({
      depthDb: z.number().min(0).max(36).optional(),
      attackMs: z.number().min(20).max(2000).optional(),
      holdMs: z.number().min(0).max(5000).optional(),
      releaseMs: z.number().min(50).max(5000).optional(),
    })
    .optional(),
  delivery: z
    .strictObject({
      preset: z.enum(deliveryPresets),
      integratedLufs: z.number().min(-40).max(-8).optional(),
      truePeakDbtp: z.number().min(-8).max(-0.1).optional(),
      loudnessRange: z.number().min(1).max(50).optional(),
    })
    .optional(),
  automation: z
    .strictObject({
      dialogue: z.record(id, curve).optional(),
      music: curve.optional(),
    })
    .optional(),
});

export const audioRoleSchema = z.enum(audioRoles);
export const videoMixEditSchema = z.strictObject({
  mix: professionalMixSchema.nullable(),
  roles: z.record(id, audioRoleSchema).optional(),
});
