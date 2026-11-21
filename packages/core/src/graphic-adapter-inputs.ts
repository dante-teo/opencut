import { canvasColorPattern } from '@opencut/shared';
import type { ThreeScene } from '@opencut/shared';
import { z } from 'zod';
import { motionChannelSchema } from './motion-schema.js';
import { entityIdSchema } from './project.js';

const limit = (min: number, max: number) => z.number().min(min).max(max);
const animated = (min: number, max: number) => {
  const scalar = limit(min, max);
  const value = z.union([scalar, motionChannelSchema(scalar)]);
  return z.tuple([value, value, value]);
};
const color = z
  .string()
  .regex(canvasColorPattern)
  .refine(
    (value) => value.length === 7,
    'Use #RRGGBB for a 3D light or material.',
  );
const position = animated(-1000, 1000);
const transform = {
  position: position.optional(),
  rotation: animated(-1000, 1000).optional(),
  scale: animated(0.001, 1000).optional(),
};

export const intrinsicRangeSchema = z.enum(['hold', 'loop', 'error']);

export const threeSceneSchema = z.strictObject({
  version: z.literal(1),
  camera: z.strictObject({
    position,
    target: position,
    fov: limit(10, 120).optional(),
  }),
  lights: z
    .array(
      z.strictObject({
        type: z.enum(['ambient', 'directional']),
        color,
        intensity: limit(0, 20),
        position: z
          .tuple([limit(-1000, 1000), limit(-1000, 1000), limit(-1000, 1000)])
          .optional(),
      }),
    )
    .min(1)
    .max(8),
  model: z
    .strictObject({
      ...transform,
      animation: z
        .strictObject({
          name: z.string().min(1).max(256),
          speed: limit(1 / 64, 64).optional(),
          outOfRange: intrinsicRangeSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  meshes: z
    .array(
      z.strictObject({
        id: entityIdSchema,
        geometry: z.enum(['box', 'sphere']),
        color,
        ...transform,
        roughness: limit(0, 1).optional(),
        metalness: limit(0, 1).optional(),
        texture: z
          .strictObject({
            resource: entityIdSchema,
            repeat: z.tuple([limit(0.001, 64), limit(0.001, 64)]).optional(),
            offset: z.tuple([limit(-64, 64), limit(-64, 64)]).optional(),
            rotation: limit(-3600, 3600).optional(),
          })
          .optional(),
      }),
    )
    .max(32)
    .optional(),
});

export function validateThreeResources(
  scene: ThreeScene,
  hasModel: boolean,
  resources: Record<string, string>,
) {
  if (scene.model && !hasModel)
    throw new Error('The Three.js model configuration requires a GLB path.');
  if (!hasModel && !scene.meshes?.length)
    throw new Error('Three.js requires a GLB or at least one mesh.');
  const ids = new Set<string>();
  for (const mesh of scene.meshes ?? []) {
    if (ids.has(mesh.id))
      throw new Error(`Duplicate Three.js mesh '${mesh.id}'.`);
    ids.add(mesh.id);
    if (!mesh.texture) continue;
    const { resource } = mesh.texture;
    if (
      !Object.hasOwn(resources, resource) ||
      !/\.(?:png|jpg|jpeg|webp|avif)$/i.test(resources[resource]!)
    )
      throw new Error(
        `Three.js mesh '${mesh.id}' requires a captured raster texture '${resource}'.`,
      );
  }
}

const object = z.looseObject({});
const shape = object.extend({ ty: z.string() });
const vectorClock = z.object({
  w: z.int().min(1).max(3840),
  h: z.int().min(1).max(3840),
  fr: limit(1, 120),
  ip: limit(0, 72000),
  op: limit(0, 72000),
  assets: z.array(z.never()).max(0).optional(),
  layers: z
    .array(
      z.object({
        ty: z.literal(4),
        ddd: z.literal(0).optional(),
        bm: z.literal(0).optional(),
        sr: z.literal(1).optional(),
        tt: z.never().optional(),
        td: z.never().optional(),
        parent: z.never().optional(),
        ef: z.never().optional(),
        masksProperties: z.array(z.never()).max(0).optional(),
        shapes: z.array(z.unknown()).max(256),
      }),
    )
    .min(1)
    .max(32),
  ddd: z.literal(0).optional(),
  fonts: z.never().optional(),
  chars: z.never().optional(),
});

function walkAsset(
  value: unknown,
  visit: (key: string, item: unknown) => void,
) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== 'object') continue;
    if (current.depth > 32 || entries > 120000)
      throw new Error('Asset exceeds its nesting or entry limit.');
    for (const [key, item] of Object.entries(current.value)) {
      if (++entries > 120000) throw new Error('Asset exceeds its entry limit.');
      visit(key, item);
      if (item && typeof item === 'object')
        pending.push({ value: item, depth: current.depth + 1 });
    }
  }
}

export function readLottieClock(bytes: Buffer) {
  if (bytes.length > 4 * 1024 * 1024)
    throw new Error('Lottie assets are limited to 4 MiB.');
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  walkAsset(value, (key, item) => {
    if (
      (key === 'x' && typeof item === 'string') ||
      key === 'expression' ||
      key === 'expressions'
    )
      throw new Error('Lottie expressions are unsupported.');
    if (key === 'refId' || key === 'tm' || key === 'sy')
      throw new Error(
        `Unsupported Lottie reference or playback feature '${key}'.`,
      );
  });
  const result = vectorClock.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(
      `Unsupported Lottie feature at '${issue.path.join('.') || 'root'}': ${issue.message}`,
    );
  }
  const { fr, ip, op, layers } = result.data;
  if (ip >= op || op - ip > fr * 600)
    throw new Error(
      'Lottie needs increasing in/out frames and a duration of at most 600 seconds.',
    );
  const available = new Set(['gr', 'el', 'rc', 'sh', 'fl', 'st', 'tr', 'tm']);
  let count = 0;
  const pending = layers.flatMap(({ shapes }) => shapes);
  while (pending.length) {
    const item = shape.parse(pending.pop());
    if (++count > 1024)
      throw new Error('Lottie assets may use at most 1,024 shapes.');
    if (
      !available.has(item.ty) ||
      (Object.hasOwn(item, 'd') && Array.isArray(item.d))
    )
      throw new Error(
        `Unsupported Lottie shape or dashed stroke '${item.ty}'.`,
      );
    if (item.ty === 'gr')
      pending.push(...z.array(z.unknown()).max(256).parse(item.it));
  }
  return { fr, ip, op };
}

const uint = z.int().nonnegative();
const gltf = z.object({
  asset: z.object({ version: z.literal('2.0') }),
  buffers: z.array(z.object({ byteLength: uint })).length(1),
  bufferViews: z
    .array(
      z.object({
        buffer: z.literal(0),
        byteLength: uint,
        byteOffset: uint.optional(),
      }),
    )
    .max(256),
  accessors: z
    .array(
      z.object({
        count: z.int().min(1).max(300_000),
        bufferView: uint,
        sparse: z.never().optional(),
      }),
    )
    .max(256),
  nodes: z
    .array(
      z.object({
        children: z.array(uint).max(128).optional(),
        skin: z.never().optional(),
        weights: z.never().optional(),
      }),
    )
    .max(128),
  meshes: z
    .array(
      z.object({
        primitives: z
          .array(
            z.object({
              mode: z.literal(4).optional(),
              indices: uint.optional(),
              attributes: z.record(z.string(), uint),
              targets: z.never().optional(),
            }),
          )
          .min(1)
          .max(16),
      }),
    )
    .min(1)
    .max(64),
  animations: z
    .array(
      z.object({
        channels: z.array(z.unknown()).max(64),
        samplers: z.array(z.unknown()).max(64),
        name: z.string().optional(),
      }),
    )
    .max(16)
    .optional(),
  images: z.array(z.never()).max(0).optional(),
  textures: z.array(z.never()).max(0).optional(),
  skins: z.array(z.never()).max(0).optional(),
});

export function validateGlb(bytes: Buffer, animationName?: string) {
  if (
    bytes.length < 28 ||
    bytes.length > 16 * 1024 * 1024 ||
    bytes.toString('latin1', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.toString('latin1', 16, 20) !== 'JSON'
  )
    throw new Error(
      'Expected a self-contained GLB 2.0 file of at most 16 MiB.',
    );
  const jsonEnd = 20 + bytes.readUInt32LE(12);
  if (
    jsonEnd > Math.min(bytes.length - 8, 1024 * 1024) ||
    jsonEnd % 4 !== 0 ||
    bytes.toString('latin1', jsonEnd + 4, jsonEnd + 8) !== 'BIN\0'
  )
    throw new Error(
      'GLB requires a bounded JSON chunk followed by one BIN chunk.',
    );
  const size = bytes.readUInt32LE(jsonEnd);
  if (size !== bytes.length - jsonEnd - 8)
    throw new Error('Invalid GLB binary payload length.');
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(20, jsonEnd),
    ),
  );
  walkAsset(value, (key, item) => {
    if (key === 'uri')
      throw new Error(
        'GLB URIs are unsupported. Use captured resources for procedural meshes.',
      );
    if (
      key === 'extensionsRequired' ||
      key === 'extensionsUsed' ||
      key === 'extensions'
    ) {
      const names = Array.isArray(item) ? item : Object.keys(Object(item));
      if (names.length)
        throw new Error(`Unsupported GLB extension '${String(names[0])}'.`);
    }
  });
  const result = gltf.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(
      `Unsupported GLB feature at '${issue.path.join('.') || 'root'}': ${issue.message}`,
    );
  }
  const { buffers, bufferViews, accessors, meshes, nodes, animations } =
    result.data;
  const length = buffers[0]!.byteLength;
  if (
    length > size ||
    size - length > 3 ||
    bufferViews.some(
      (view) => (view.byteOffset ?? 0) + view.byteLength > length,
    ) ||
    accessors.some((entry) => !bufferViews[entry.bufferView])
  )
    throw new Error(
      'GLB buffers or accessors reference missing or out-of-bounds data.',
    );
  let indices = 0;
  for (const { primitives } of meshes)
    for (const entry of primitives) {
      const count =
        accessors[entry.indices ?? entry.attributes.POSITION ?? -1]?.count;
      if (
        !count ||
        count % 3 ||
        Object.values(entry.attributes).some((id) => !accessors[id])
      )
        throw new Error('GLB requires valid triangle primitives.');
      indices += count;
    }
  if (indices > 600_000) throw new Error('GLB exceeds 200,000 triangles.');
  if (animationName && !animations?.some(({ name }) => name === animationName))
    throw new Error(`GLB has no animation '${animationName}'.`);
  const visited = new Set<number>();
  function visit(index: number, depth: number, ancestors: Set<number>) {
    if (ancestors.has(index))
      throw new Error('GLB scene graph contains a cycle.');
    if (depth > 24 || !nodes[index])
      throw new Error('GLB node nesting or reference is invalid.');
    if (visited.has(index)) return;
    visited.add(index);
    ancestors.add(index);
    for (const child of nodes[index]!.children ?? [])
      visit(child, depth + 1, ancestors);
    ancestors.delete(index);
  }
  nodes.forEach((_, i) => visit(i, 0, new Set()));
}
