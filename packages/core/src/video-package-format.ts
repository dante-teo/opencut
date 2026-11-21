import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  enhancementBackendId,
  inspectGraphicsRuntime,
  interpolationBackendId,
} from '@opencut/media';
import {
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import type { ParsedVideoDefinition } from './video-definition.js';
import { fingerprintFile } from './video-integrity.js';
import { isVideoDefinitionPath, videoDefinitionFormats } from './video-json.js';
import {
  isEnhancementStep,
  isInterpolationStep,
} from './video-recipe-schema.js';

export const packageManifestName = 'opencut-package.json';
export const packageEntryName = 'opencut.bundle.video.ts';

const entryPrefix = 'export default ';
const entrySuffix = ';\n';

export function serializePackageEntry(definition: ParsedVideoDefinition) {
  return entryPrefix + JSON.stringify(definition) + entrySuffix;
}

function parsePackageEntry(source: string) {
  let value: unknown;
  try {
    // Read the generated TypeScript data literal without executing the module.
    if (!source.startsWith(entryPrefix) || !source.endsWith(entrySuffix))
      throw new Error('Expected a static default export.');
    value = JSON.parse(source.slice(entryPrefix.length, -entrySuffix.length));
  } catch (cause) {
    throw new VideoDefinitionError('Invalid packaged TypeScript entry.', {
      cause,
    });
  }
  return parseVideoDefinition(value);
}

const safeComponent = (part: string) =>
  part !== '' &&
  part !== '.' &&
  part !== '..' &&
  !/[<>:"|?*\\\p{Cc}]/u.test(part) &&
  !/[. ]$/.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part);

const packagePath = z
  .string()
  .refine(
    (path) => path.split('/').every(safeComponent),
    'Expected a portable path inside the package.',
  );
const assetRecipes = z.record(z.string(), z.array(z.unknown()));
const requirements = z.strictObject({
  ffmpeg: z.literal('ffmpeg and ffprobe on PATH'),
  native: z.array(
    z.strictObject({
      kind: z.enum(['interpolation', 'enhancement']),
      version: z.string(),
      platform: z.literal('Apple Silicon, macOS 26+'),
      model: z.literal('Apple VideoToolbox system model'),
    }),
  ),
  authoringPackages: z.array(z.string()),
  graphics: z.array(z.string()).optional(),
});
const manifestSchema = z.strictObject({
  format: z.literal('opencut-video-package'),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  opencut: z.string(),
  node: z.string(),
  entry: z.literal(packageEntryName),
  source: packagePath,
  params: z.record(z.string(), z.unknown()).optional(),
  bytes: z.int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: packagePath,
        bytes: z.int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(2),
  imports: z.array(
    z.strictObject({
      from: packagePath,
      to: packagePath,
      specifier: z.string(),
    }),
  ),
  requirements,
  recipes: assetRecipes,
  graphics: z
    .record(
      z.string(),
      z.strictObject({ path: packagePath, backend: z.string() }),
    )
    .optional(),
});

export type VideoPackageManifest = z.infer<typeof manifestSchema>;

const reactBundle = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  template: z
    .enum(['LowerThird', 'StatisticCard', 'BarChart', 'Callout', 'SectionCard'])
    .optional(),
  adapter: z.enum(['scene', 'lottie', 'three']).optional(),
  renderer: z.literal('react'),
  backend: z.string(),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  js: z.string().min(1),
  css: z.string(),
  sourceMap: z.string().optional(),
  notices: z.record(z.string(), z.string()).optional(),
  resources: z.record(z.string(), z.string()),
});
const maxGraphicsBytes = 160 * 1024 * 1024;
export const staticGraphicsBackend = 'svg-sharp-v1';

const nativeContracts = {
  interpolation: interpolationBackendId,
  enhancement: enhancementBackendId,
};

export function packageRecipes(definition: ParsedVideoDefinition) {
  const recipes = Object.fromEntries(
    Object.entries(definition.assets ?? {}).flatMap(([id, asset]) =>
      asset.kind !== 'graphic' && asset.recipe ? [[id, asset.recipe]] : [],
    ),
  );
  const steps = Object.values(recipes).flat();
  const native = (
    Object.keys(nativeContracts) as (keyof typeof nativeContracts)[]
  )
    .filter((kind) =>
      steps.some(
        kind === 'interpolation' ? isInterpolationStep : isEnhancementStep,
      ),
    )
    .map((kind) => ({
      kind,
      version: nativeContracts[kind],
      platform: 'Apple Silicon, macOS 26+' as const,
      model: 'Apple VideoToolbox system model' as const,
    }));
  return { recipes, native };
}

/** Check individual components so a link may not redirect traversal. */
export async function packageFile(root: string, path: string) {
  const parsed = packagePath.safeParse(path);
  if (!parsed.success)
    throw new VideoDefinitionError(`Unsafe package path '${path}'.`);
  const parts = parsed.data.split('/');
  let absolute = root;
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    const info = await lstat(absolute).catch((cause: unknown) => {
      throw new VideoDefinitionError(
        `Missing or unreadable package file '${path}'.`,
        { cause },
      );
    });
    if (!(index === parts.length - 1 ? info.isFile() : info.isDirectory()))
      throw new VideoDefinitionError(
        `Package path '${path}' contains a symlink or non-regular entry.`,
      );
  }
  if ((await realpath(absolute)) !== absolute)
    throw new VideoDefinitionError(
      `Package file '${path}' escaped its declared root.`,
    );
  return absolute;
}

/** Reject collisions on case-insensitive and Unicode-normalizing filesystems. */
export function assertUniquePackagePaths(paths: Iterable<string>) {
  const spellings = new Map<string, { path: string; file: boolean }>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.normalize('NFKC').toLowerCase();
      const file = i === parts.length;
      const previous = spellings.get(key);
      if (previous && (file || previous.file || previous.path !== prefix))
        throw new VideoDefinitionError(
          `Package destination collision: '${previous.path}' and '${path}'.`,
        );
      spellings.set(key, { path: prefix, file });
    }
  }
}

export async function verifyPackageContents(
  directory: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const requested = resolve(directory);
  if (!(await lstat(requested)).isDirectory())
    throw new VideoDefinitionError(
      'Choose a package directory, not a symlink.',
    );
  const root = await realpath(requested);
  const path = await packageFile(root, packageManifestName);
  const read = await readFile(path, { encoding: 'utf8', signal });
  let value: unknown;
  try {
    value = JSON.parse(read);
  } catch (cause) {
    throw new VideoDefinitionError('Invalid package manifest JSON.', { cause });
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success)
    throw new VideoDefinitionError(
      `Invalid OpenCut package manifest: ${parsed.error.issues[0]?.path.join('.') || 'format'}.`,
    );
  const { data: manifest } = parsed;
  const inventory = manifest.files.map(({ path }) => path);
  assertUniquePackagePaths([packageManifestName, ...inventory]);
  const paths = new Set(inventory);
  const sourceName = manifest.source;
  if (
    !paths.has(manifest.entry) ||
    !paths.has(sourceName) ||
    !sourceName.startsWith('project/') ||
    !isVideoDefinitionPath(sourceName) ||
    manifest.imports.some(
      ({ from, to, specifier }) =>
        !paths.has(from) || !paths.has(to) || !/^\.{1,2}\//.test(specifier),
    )
  )
    throw new VideoDefinitionError(
      'Package manifest contains a missing entry or dependency.',
    );
  if (
    manifest.bytes !== manifest.files.reduce((sum, item) => sum + item.bytes, 0)
  )
    throw new VideoDefinitionError(
      'Package size does not match its inventory.',
    );

  const fingerprints = new Map<
    string,
    Awaited<ReturnType<typeof fingerprintFile>>
  >();
  let valueBytes: string | undefined;
  const graphics = new Map<string, z.infer<typeof reactBundle>>();
  const bundles = new Map(
    Object.entries(manifest.graphics ?? {}).map(([id, entry]) => [
      entry.path,
      { ...entry, id },
    ]),
  );
  if (
    bundles.size !== Object.keys(manifest.graphics ?? {}).length ||
    [...bundles.keys()].some(
      (path) => !path.startsWith('graphics/') || !paths.has(path),
    )
  )
    throw new VideoDefinitionError(
      'Package contains an invalid graphics bundle inventory.',
    );
  const graphicsBytes = manifest.files.reduce(
    (total, item) => total + (bundles.has(item.path) ? item.bytes : 0),
    0,
  );
  if (graphicsBytes > maxGraphicsBytes)
    throw new VideoDefinitionError(
      'Package graphics payload exceeds its size limit.',
    );
  for (const item of manifest.files) {
    const file = await packageFile(root, item.path);
    const digest = await fingerprintFile(file, signal);
    const { bytes, sha256 } = digest;
    fingerprints.set(file, digest);
    if (item.sha256 !== sha256 || item.bytes !== bytes)
      throw new VideoDefinitionError(
        `Package integrity check failed for '${item.path}'.`,
      );
    const bundle = bundles.get(item.path);
    if (item.path === manifest.entry || bundle) {
      const content = await readFile(file, { encoding: 'utf8', signal });
      const entryHash = createHash('sha256').update(content).digest('hex');
      // Read the entry and verify the bytes actually parsed, even if it changed
      // after the streaming inventory check.
      if (entryHash !== item.sha256)
        throw new VideoDefinitionError(
          'Package build entry or graphics bundle changed during verification.',
        );
      if (bundle) {
        let payload: unknown;
        try {
          payload = JSON.parse(content);
        } catch (cause) {
          throw new VideoDefinitionError(
            `Invalid graphics bundle '${item.path}'.`,
            { cause },
          );
        }
        const parsed = reactBundle.safeParse(payload);
        if (!parsed.success || parsed.data.backend !== bundle.backend)
          throw new VideoDefinitionError(
            `Invalid graphics bundle '${item.path}'.`,
          );
        graphics.set(bundle.id, { ...parsed.data, key: entryHash });
      } else valueBytes = content;
    }
  }
  const definition = parsePackageEntry(valueBytes!);
  for (const item of [
    ...Object.values(definition.assets ?? {}),
    ...Object.values(definition.fonts ?? {}),
  ]) {
    if (
      'path' in item &&
      item.path !== undefined &&
      (!item.path.startsWith('project/') || !paths.has(item.path))
    )
      throw new VideoDefinitionError(
        `Package build entry references an unpackaged file '${item.path}'.`,
      );
  }
  const graphicAssets = Object.entries(definition.assets ?? {}).flatMap(
    ([id, asset]) => (asset.kind === 'graphic' ? [[id, asset] as const] : []),
  );
  const backends = new Set<string>();
  let reactCount = 0;
  for (const [id, asset] of graphicAssets) {
    if (asset.renderer === 'svg') {
      if (
        Object.values(asset.fonts ?? {}).some(
          (path) => !path.startsWith('project/') || !paths.has(path),
        )
      )
        throw new VideoDefinitionError(
          `Package is missing a static SVG font for '${id}'.`,
        );
      backends.add(staticGraphicsBackend);
      continue;
    }
    const bundle = graphics.get(id);
    if (
      !bundle ||
      bundle.adapter !==
        (asset.renderer === 'react' || asset.renderer === 'template'
          ? undefined
          : asset.renderer) ||
      (asset.renderer === 'template' && bundle.template !== asset.template) ||
      Object.values(asset.resources ?? {}).some(
        (path) => !path.startsWith('project/') || !paths.has(path),
      )
    )
      throw new VideoDefinitionError(
        `Package is missing a graphics bundle or resource for '${id}'.`,
      );
    backends.add(bundle.backend);
    reactCount++;
  }
  if (
    reactCount !== graphics.size ||
    manifest.version !==
      (definition.version === 3 ||
      sourceName.endsWith(videoDefinitionFormats.json.suffix)
        ? 3
        : graphicAssets.length
          ? 2
          : 1) ||
    (!graphicAssets.length && manifest.graphics !== undefined) ||
    JSON.stringify([...backends].sort()) !==
      JSON.stringify(manifest.requirements.graphics ?? [])
  )
    throw new VideoDefinitionError(
      'Package graphics requirements do not match the build entry.',
    );
  const recorded = packageRecipes(definition);
  if (
    JSON.stringify(recorded.recipes) !== JSON.stringify(manifest.recipes) ||
    JSON.stringify(recorded.native.map(({ kind }) => kind)) !==
      JSON.stringify(manifest.requirements.native.map(({ kind }) => kind))
  )
    throw new VideoDefinitionError(
      'Package recipes or backend requirements do not match the build entry.',
    );
  return {
    manifest,
    root,
    entry: join(root, manifest.entry),
    definition,
    manifestPath: path,
    fingerprints,
    graphics,
  };
}

export async function checkPackagedBackends({
  requirements,
}: VideoPackageManifest) {
  const react = (requirements.graphics ?? []).filter(
    (backend) => backend !== staticGraphicsBackend,
  );
  if (react.length) {
    const { backend } = await inspectGraphicsRuntime();
    for (const required of react)
      if (required !== backend)
        throw new VideoDefinitionError(
          `Package requires graphics backend '${required}', but this OpenCut provides '${backend}'. Install a matching OpenCut build.`,
        );
  }
  for (const { kind, version } of requirements.native) {
    if (nativeContracts[kind] !== version)
      throw new VideoDefinitionError(
        `Package requires ${kind} backend '${version}'; this OpenCut provides '${nativeContracts[kind]}'. Install a matching OpenCut build.`,
      );
  }
}

export function portableRelativePath(root: string, path: string) {
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new VideoDefinitionError(
      `Dependency '${path}' is outside the project root '${root}'. Choose a shared --root or move the dependency inside it.`,
    );
  const portable = path
    .slice(root.endsWith(sep) ? root.length : root.length + 1)
    .split(sep)
    .join('/');
  if (!packagePath.safeParse(portable).success)
    throw new VideoDefinitionError(
      `Dependency '${path}' does not have a portable filename.`,
    );
  return portable;
}
