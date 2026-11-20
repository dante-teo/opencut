import { z } from 'zod';

const text = z.string().max(512).optional();
const body = z.string().max(4096).optional();
const color = z.string().trim().min(1).max(128).optional();
const coordinate = z.number().min(0).max(1).optional();
const image = z
  .string()
  .max(8 * 1024 * 1024)
  .regex(/^data:image\//)
  .optional();
const theme = {
  accent: color,
  ink: color,
  paper: color,
  theme: z.enum(['light', 'dark']).optional(),
};

export const templatePropSchemas = {
  LowerThird: z.strictObject({
    ...theme,
    name: text,
    role: text,
    portrait: image,
  }),
  StatisticCard: z.strictObject({
    ...theme,
    label: text,
    value: z.number().optional(),
    unit: text,
    detail: text,
  }),
  BarChart: z.strictObject({
    ...theme,
    title: text,
    empty: text,
    data: z
      .array(
        z.strictObject({
          label: z.string().max(512),
          value: z.number().min(-1e15).max(1e15),
        }),
      )
      .max(6)
      .optional(),
  }),
  Callout: z.strictObject({
    ...theme,
    label: text,
    x: coordinate,
    y: coordinate,
    anchorX: coordinate,
    anchorY: coordinate,
  }),
  SectionCard: z.strictObject({ ...theme, heading: text, body, icon: image }),
};

export type GraphicTemplate = keyof typeof templatePropSchemas;
export type TemplateProps<T extends GraphicTemplate> = z.input<
  (typeof templatePropSchemas)[T]
>;

export function parseTemplateProps<T extends GraphicTemplate>(
  template: T,
  props: unknown,
) {
  const parsed = templatePropSchemas[template].safeParse(props);
  if (!parsed.success)
    throw new Error(
      template +
        ' props: ' +
        parsed.error.issues
          .map(
            ({ path, message }) =>
              (path.length ? path.join('.') + ': ' : '') + message,
          )
          .join('; '),
    );
  return parsed.data as z.output<(typeof templatePropSchemas)[T]>;
}
