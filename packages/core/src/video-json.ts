import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import {
  definitionLoadError,
  resolveVideoDefinition,
  validateVideoParameters,
  VideoDefinitionError,
} from './video-definition.js';
import type {
  ResolvedVideoDefinition,
  VideoParameters,
} from './video-definition.js';
import { fileIdentity, videoInputIdentity } from './video-input.js';

export const videoDefinitionFormats = {
  typescript: { suffix: '.video.ts', authoringCode: true },
  json: {
    suffix: '.video.json',
    authoringCode: false,
    parameterFormat: 'opencut-video-json',
    parameterVersion: 1,
    parameterTypes: ['string', 'number', 'integer', 'boolean', 'json'],
    maxBytes: 8 * 1024 * 1024,
    maxParameters: 128,
    maxBindings: 1024,
  },
} as const;

export function isVideoDefinitionPath(file: string) {
  return Object.values(videoDefinitionFormats).some(({ suffix }) =>
    file.endsWith(suffix),
  );
}

const json = videoDefinitionFormats.json;
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
  format: z.literal(json.parameterFormat),
  version: z.literal(json.parameterVersion),
  parameters: z
    .record(parameterName, parameterSchema)
    .refine(
      (parameters) => Object.keys(parameters).length <= json.maxParameters,
      `Choose up to ${json.maxParameters} parameters.`,
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
    .max(json.maxBindings),
});

type Parameter = z.infer<typeof parameterSchema>;

function parameterValueSchema(name: string, parameter: Parameter): z.ZodType {
  switch (parameter.type) {
    case 'string': {
      const { choices } = parameter;
      return choices ? z.enum(choices) : z.string();
    }
    case 'boolean':
      return z.boolean();
    case 'json':
      return z.json();
    case 'integer':
    case 'number': {
      const { minimum, maximum } = parameter;
      if (minimum !== undefined && maximum !== undefined && minimum > maximum)
        throw new VideoDefinitionError(
          `parameters.${name}: Minimum exceeds maximum.`,
        );
      let schema = parameter.type === 'integer' ? z.int() : z.number();
      if (minimum !== undefined) schema = schema.min(minimum);
      if (maximum !== undefined) schema = schema.max(maximum);
      return schema;
    }
  }
}

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

function resolveDocument(
  value: unknown,
  overrides: VideoParameters | undefined,
): Promise<ResolvedVideoDefinition> | ResolvedVideoDefinition {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'format'))
    return resolveVideoDefinition(value, overrides);
  const checked = documentSchema.safeParse(value);
  if (!checked.success) throw invalidJsonDocument(checked.error);
  const { composition, bindings, parameters } = checked.data;
  const shape = Object.fromEntries(
    Object.entries(parameters).map(([name, parameter]) => {
      const schema = parameterValueSchema(name, parameter);
      if (parameter.default === undefined) return [name, schema];
      const result = schema.safeParse(parameter.default);
      if (!result.success)
        throw new VideoDefinitionError(
          `parameters.${name}.default: ${result.error.issues[0]?.message}`,
        );
      return [name, schema.default(result.data)];
    }),
  );
  const checkedParams = z.strictObject(shape).safeParse(overrides ?? {});
  if (!checkedParams.success)
    throw invalidJsonDocument(checkedParams.error, ['params']);
  const params = validateVideoParameters(checkedParams.data);

  // Resolve targets before writing any values. Path prefix collisions would
  // otherwise make one binding depend on the order of another.
  const used = new Set(bindings.map(({ path }) => JSON.stringify(path)));
  if (used.size !== bindings.length)
    throw new VideoDefinitionError('bindings: Duplicate composition target.');
  const targets = bindings.map(({ path, parameter }, i) => {
    const location = `bindings.${i}.path (${JSON.stringify(path)})`;
    if (!Object.hasOwn(parameters, parameter))
      throw new VideoDefinitionError(
        `bindings.${i}.parameter: Unknown parameter '${parameter}'.`,
      );
    let parent: unknown = composition;
    for (const [index, key] of path.slice(0, -1).entries()) {
      if (used.has(JSON.stringify(path.slice(0, index + 1))))
        throw new VideoDefinitionError(`${location}: Binding targets overlap.`);
      parent = requireProperty(parent, key, location)[key];
    }
    const key = path.at(-1)!;
    return { parent: requireProperty(parent, key, location), key, parameter };
  });
  for (const { parent, key, parameter } of targets)
    parent[key] = structuredClone(params[parameter]);
  return { value: composition, params, jsonParameters: parameters };
}

function invalidJsonDocument(error: z.ZodError, prefix: string[] = []) {
  return new VideoDefinitionError(
    error.issues
      .map(
        ({ path, message }) =>
          `${[...prefix, ...path].join('.') || 'Definition'}: ${message}`,
      )
      .join('\n'),
  );
}

export type JsonVideoParameterSchema = z.input<
  typeof documentSchema
>['parameters'];

export async function readJsonVideo(
  path: string,
  identity: string | null,
  params?: VideoParameters,
  signal?: AbortSignal,
) {
  try {
    const fd = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const info = await fd.stat({ bigint: true });
      if (!identity || fileIdentity(info) !== identity)
        throw new Error('Definition changed before it could be read.');
      if (info.size > BigInt(json.maxBytes))
        throw new Error('JSON definitions are limited to 8 MiB.');
      bytes = Buffer.alloc(Number(info.size));
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await fd.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) throw new Error('Definition changed while reading.');
        offset += bytesRead;
      }
      if (videoInputIdentity(path) !== identity)
        throw new Error('Definition changed while reading.');
    } finally {
      await fd.close();
    }
    signal?.throwIfAborted();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return await resolveDocument(JSON.parse(text), params);
  } catch (cause) {
    signal?.throwIfAborted();
    throw definitionLoadError(path, cause);
  }
}
