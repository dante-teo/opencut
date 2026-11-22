import { z } from 'zod';
import { entityIdSchema } from './project.js';

const pixels = z.number().nonnegative();
const target = z.union([
  z.strictObject({ clip: entityIdSchema }),
  z.strictObject({ track: entityIdSchema }),
  z.strictObject({ subtitles: z.literal(true) }),
]);
const common = {
  id: entityIdSchema,
  target,
  tolerance: pixels.default(0),
  required: z.boolean().default(true),
};
const insets = z.strictObject({
  top: pixels.default(0),
  right: pixels.default(0),
  bottom: pixels.default(0),
  left: pixels.default(0),
});
const assertion = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('bottom-center'),
    bottom: pixels,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('upper-left'),
    left: pixels,
    top: pixels,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('centered'),
    against: entityIdSchema.optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('glyphs-centered'),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('inside'),
    against: entityIdSchema.optional(),
    insets: insets.optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('covers-canvas'),
    target: z.strictObject({ clip: entityIdSchema }),
  }),
]);

export const layoutAssertionsSchema = z
  .array(assertion)
  .max(256)
  .superRefine((assertions, ctx) => {
    const ids = new Set<string>();
    for (const [index, { id }] of assertions.entries()) {
      if (ids.has(id))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Layout assertion IDs must be unique.',
        });
      ids.add(id);
    }
  });

export type LayoutAssertion = z.input<typeof assertion>;
export type ParsedLayoutAssertion = z.output<typeof assertion>;
