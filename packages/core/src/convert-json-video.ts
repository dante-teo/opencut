import { z } from 'zod';
import {
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';

const maxParameters = 128;
const maxBindings = 1024;
const parameterName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const numericConstraints = {
  minimum: z.number().optional(),
  maximum: z.number().optional(),
};
const parameterSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'),
    choices: z.array(z.string()).min(1).max(128).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal('number'),
    ...numericConstraints,
    default: z.number().optional(),
  }),
  z.strictObject({
    type: z.literal('integer'),
    ...numericConstraints,
    default: z.int().optional(),
  }),
  z.strictObject({
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('json'), default: z.json().optional() }),
]);

const targetKey = z.union([
  z
    .string()
    .min(1)
    .max(192)
    .refine(
      (key) => !['__proto__', 'prototype', 'constructor'].includes(key),
      'Expected a composition property.',
    ),
  z.int().nonnegative(),
]);
const documentSchema = z.strictObject({
  format: z.literal('opencut-video-json'),
  version: z.literal(1),
  parameters: z
    .record(parameterName, parameterSchema)
    .refine(
      (parameters) => Object.keys(parameters).length <= maxParameters,
      `Choose up to ${maxParameters} parameters.`,
    ),
  composition: z.custom<Record<string, unknown>>(
    (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected a composition object.',
  ),
  bindings: z
    .array(
      z.strictObject({
        parameter: parameterName,
        path: z.array(targetKey).min(1).max(32),
      }),
    )
    .max(maxBindings),
});

type Parameter = z.infer<typeof parameterSchema>;

function requireProperty(
  container: unknown,
  key: string | number,
  path: string,
) {
  if (
    container === null ||
    typeof container !== 'object' ||
    (typeof key === 'number') !== Array.isArray(container) ||
    !Object.hasOwn(container, key)
  )
    throw new VideoDefinitionError(`${path}: Binding target does not exist.`);
  return container as Record<string | number, unknown>;
}

function propertySource(key: string) {
  return key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
}

type BindingTargets = Map<object, Map<string | number, string>>;

function valueSource(
  value: unknown,
  indent: string,
  targets?: BindingTargets,
): string {
  if (value === null || typeof value !== 'object')
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);

  const inner = indent + '  ';
  const bindings = targets?.get(value);
  const itemSource = (key: string | number, item: unknown) => {
    const parameter = bindings?.get(key);
    const entry =
      parameter === undefined
        ? valueSource(item, inner, targets)
        : `params[${JSON.stringify(parameter)}]`;
    const property = typeof key === 'string' ? `${propertySource(key)}: ` : '';
    return `${inner}${property}${entry},\n`;
  };
  const array = Array.isArray(value);
  const content = (
    array
      ? value.map((item, index) => itemSource(index, item))
      : Object.entries(value).map(([key, item]) => itemSource(key, item))
  ).join('');
  const body = content ? `\n${content}${indent}` : '';
  return array ? `[${body}]` : `{${body}}`;
}

function parameterSource(name: string, parameter: Parameter) {
  let schema = parameter.type === 'integer' ? 'int()' : `${parameter.type}()`;
  if (parameter.type === 'string' && parameter.choices) {
    const { choices, default: value } = parameter;
    if (value !== undefined && !choices.includes(value))
      throw new VideoDefinitionError(
        `parameters.${name}.default: Choose a value from choices.`,
      );
    schema = `enum(${JSON.stringify(choices)})`;
  } else if (parameter.type === 'integer' || parameter.type === 'number') {
    const { minimum, maximum, default: value } = parameter;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      throw new VideoDefinitionError(
        `parameters.${name}: Minimum exceeds maximum.`,
      );
    if (
      value !== undefined &&
      ((minimum !== undefined && value < minimum) ||
        (maximum !== undefined && value > maximum))
    )
      throw new VideoDefinitionError(
        `parameters.${name}.default: Value is outside the allowed range.`,
      );
    if (minimum !== undefined) schema += `.min(${minimum})`;
    if (maximum !== undefined) schema += `.max(${maximum})`;
  }
  const fallback =
    parameter.default === undefined
      ? ''
      : `.default(${valueSource(parameter.default, '    ')})`;
  return `    ${propertySource(name)}: videoParams.${schema}${fallback},\n`;
}

function bindingTargets({
  bindings,
  composition,
  parameters,
}: z.output<typeof documentSchema>) {
  const used = new Set(bindings.map(({ path }) => JSON.stringify(path)));
  if (used.size !== bindings.length)
    throw new VideoDefinitionError('bindings: Duplicate composition target.');

  const targets: BindingTargets = new Map();
  for (const [index, { path, parameter }] of bindings.entries()) {
    const location = `bindings.${index}.path (${JSON.stringify(path)})`;
    if (!Object.hasOwn(parameters, parameter))
      throw new VideoDefinitionError(
        `bindings.${index}.parameter: Unknown parameter '${parameter}'.`,
      );
    let parent: unknown = composition;
    for (const [depth, key] of path.slice(0, -1).entries()) {
      if (used.has(JSON.stringify(path.slice(0, depth + 1))))
        throw new VideoDefinitionError(`${location}: Binding targets overlap.`);
      parent = requireProperty(parent, key, location)[key];
    }
    const key = path.at(-1)!;
    const container = requireProperty(parent, key, location);
    const properties = targets.get(container) ?? new Map();
    properties.set(key, parameter);
    targets.set(container, properties);
  }
  return targets;
}

/** Convert a legacy JSON composition into standalone TypeScript source. */
export function convertJsonVideoDefinition(source: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source, (_key: string, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error('Expected a finite number.');
      return value;
    });
  } catch (cause) {
    throw new VideoDefinitionError(
      `Invalid video definition JSON: ${(cause as Error).message}`,
      { cause },
    );
  }

  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'format')) {
    parseVideoDefinition(value);
    return `export default ${valueSource(value, '')};\n`;
  }

  const checked = documentSchema.safeParse(value);
  if (!checked.success)
    throw new VideoDefinitionError(
      checked.error.issues
        .map(
          ({ path, message }) =>
            `${path.join('.') || 'Definition'}: ${message}`,
        )
        .join('\n'),
    );

  const { composition, parameters } = checked.data;
  const targets = bindingTargets(checked.data);
  const shape = Object.entries(parameters)
    .map(([name, parameter]) => parameterSource(name, parameter))
    .join('');
  const schema = shape ? `{\n${shape}  }` : '{}';
  const callback = targets.size ? '(params)' : '()';
  const body = valueSource(composition, '  ', targets);
  const builders = shape ? 'defineVideo, videoParams' : 'defineVideo';
  return `import { ${builders}, type VideoDefinition } from '@opencut/sdk';

export default defineVideo(
  ${schema},
  ${callback} => (${body}) as unknown as VideoDefinition,
);
`;
}
