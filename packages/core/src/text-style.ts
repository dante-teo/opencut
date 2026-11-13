import { z } from 'zod';
import { canvasColorPattern } from '@opencut/shared';

const textColor = z.string().regex(canvasColorPattern);
export const textLayerSchema = z.strictObject({
  canvasFill: textColor.optional(),
  embeddedFont: z.base64().max(2_800_000).nullable().optional(),
  emphasis: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  content: z
    .string()
    .max(4096)
    .refine(
      (value) => !/\p{Cc}/u.test(value.replace(/[\t\r\n]/g, '')),
      'Use printable text, tabs and line breaks.',
    ),
  fontFamily: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  fontSize: z.number().min(1).max(512).optional(),
  fontWeight: z.int().min(100).max(900).multipleOf(100).optional(),
  color: textColor.optional(),
  alignment: z.enum(['left', 'center', 'right']).optional(),
  wrapWidth: z.number().min(1).max(3840).nullable().optional(),
  rotation: z.number().min(-360).max(360).optional(),
  stroke: z
    .strictObject({ color: textColor, width: z.number().min(0).max(64) })
    .nullable()
    .optional(),
  shadow: z
    .strictObject({
      color: textColor,
      x: z.number().min(-128).max(128),
      y: z.number().min(-128).max(128),
      blur: z.number().min(0).max(64),
    })
    .nullable()
    .optional(),
  background: z
    .strictObject({ color: textColor, padding: z.number().min(0).max(128) })
    .nullable()
    .optional(),
});
