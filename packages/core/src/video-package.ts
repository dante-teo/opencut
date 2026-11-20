import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getApplicationInfo } from './index.js';
import {
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import { isVideoDefinitionPath, readVideoInput } from './video-files.js';
import { copyVideoInput, videoInputIdentity } from './video-input.js';
import {
  fingerprintFile,
  missing,
  syncPath,
  writeCheckpoint,
} from './video-integrity.js';
import {
  assertUniquePackagePaths,
  packageEntryName,
  packageFile,
  packageManifestName,
  packageRecipes,
  portableRelativePath,
  serializePackageEntry,
  staticGraphicsBackend,
  verifyPackageContents,
} from './video-package-format.js';
import type { VideoPackageManifest } from './video-package-format.js';
import { scanPackageImports } from './video-package-imports.js';
import type { ScriptImport } from './video-script.js';
import { compileVideoGraphics } from './video-graphics.js';

export interface VideoPackageOptions {
  /** Common ancestor of the definition and all local files. Defaults to its directory. */
  root?: string;
  /** Additional authoring resources, relative to root (for example, files read with fs). */
  resources?: readonly string[];
  params?: unknown;
  signal?: AbortSignal;
}

export async function verifyVideoPackage(
  directory: string,
  { signal }: Pick<VideoPackageOptions, 'signal'> = {},
) {
  const { manifest, entry, root } = await verifyPackageContents(
    directory,
    signal,
  );
  return { directory: root, entry, manifest };
}

/** Package one resolved composition alongside its editable source tree. */
export async function packageVideo(
  file: string,
  output: string,
  { root, resources = [], params, signal }: VideoPackageOptions = {},
) {
  const source = resolve(file);
  if (!isVideoDefinitionPath(source) || basename(source) === packageEntryName)
    throw new VideoDefinitionError('Choose an authored .video.ts definition.');
  const project = resolve(root ?? dirname(source));
  if (
    !(await lstat(project)).isDirectory() ||
    (await realpath(project)) !== project
  )
    throw new VideoDefinitionError('Choose a project root without symlinks.');
  await packageFile(project, portableRelativePath(project, source));
  const directory = resolve(output);
  const parent = dirname(directory);
  if ((await realpath(parent)) !== parent)
    throw new VideoDefinitionError(
      'Choose a package destination without symlink parents.',
    );
  const checkOutput = async () => {
    try {
      await lstat(directory);
      throw new VideoDefinitionError(
        `Package destination '${directory}' already exists.`,
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
  };
  await checkOutput();

  const dependencies = new Map<string, { bytes: number; identity: string }>();
  const add = async (path: string, identity = videoInputIdentity(path)) => {
    const relative = portableRelativePath(project, path);
    const actual = await packageFile(project, relative);
    const info = await lstat(actual);
    const previous = dependencies.get(relative);
    if (
      !identity ||
      identity !== videoInputIdentity(actual) ||
      (previous && previous.identity !== identity)
    )
      throw new VideoDefinitionError(
        `Package dependency '${path}' changed during discovery.`,
      );
    dependencies.set(relative, { bytes: info.size, identity });
    return `project/${relative}`;
  };
  // Capture the file identity before the dynamic definition can read it.
  const sources = new Map<string, string | null>();
  const extra = resources.map((path) => {
    if (!path || isAbsolute(path) || path.includes(':'))
      throw new VideoDefinitionError(
        `Additional resources must be relative to the project root: '${path}'.`,
      );
    return resolve(project, path);
  });
  for (const path of extra) await add(path);
  const imports: ScriptImport[] = [];
  const { value, params: resolvedParams } = await readVideoInput(
    source,
    { signal, params },
    ({ path, identity }) => {
      if (!sources.has(path)) sources.set(path, identity);
    },
    (edge) => imports.push(edge),
  );
  const authored = await add(source, sources.get(source));
  const edges = new Map<string, VideoPackageManifest['imports'][number]>();
  const external = new Set<string>();
  const pending = new Set([source]);
  const traced = new Set(
    imports.map(({ parent, specifier }) => JSON.stringify([parent, specifier])),
  );
  const collect = async ({
    parent,
    path,
    specifier,
    unresolved,
  }: ScriptImport) => {
    if (unresolved)
      throw new VideoDefinitionError(
        `Unresolved package dependency '${specifier}' from '${parent}'.`,
      );
    if (isBuiltin(specifier)) return;
    if (!/^\.{1,2}\//.test(specifier)) {
      if (path || /^(?:#|\.|\/|[\w+.-]+:)/.test(specifier))
        throw new VideoDefinitionError(
          `Use a relative file import or a package name: '${specifier}' in '${parent}'.`,
        );
      external.add(specifier);
      return;
    }
    const requested = fileURLToPath(new URL(specifier, pathToFileURL(parent)));
    await add(requested, sources.get(requested));
    const target = path ?? requested;
    const edge = {
      from: await add(parent, sources.get(parent)),
      to: await add(target, sources.get(target)),
      specifier,
    };
    edges.set(JSON.stringify(edge), edge);
    pending.add(target);
  };
  for (const edge of imports) await collect(edge);
  // Sets iterate over items added during traversal, so each module is scanned once.
  for (const path of pending) {
    for (const edge of await scanPackageImports(path, signal)) {
      if (!traced.has(JSON.stringify([edge.parent, edge.specifier])))
        await collect(edge);
    }
  }
  const definition = parseVideoDefinition(value);
  const graphics = await compileVideoGraphics(
    source,
    definition,
    undefined,
    signal,
  );
  const bundleFiles = new Map<string, string>();
  const graphicBundles: NonNullable<VideoPackageManifest['graphics']> =
    Object.create(null);
  const graphicBackends = new Set<string>();
  const notices = new Map<string, string>();
  for (const [id, { bundle, inputs }] of graphics) {
    for (const { path, identity, kind } of inputs)
      if (kind === 'graphic') await add(path, identity);
    if (bundle.renderer === 'svg') {
      graphicBackends.add(staticGraphicsBackend);
      continue;
    }
    for (const [name, text] of Object.entries(bundle.notices ?? {}))
      notices.set(name, text);
    const path = `graphics/bundle-${bundleFiles.size}.json`;
    bundleFiles.set(path, JSON.stringify(bundle) + '\n');
    graphicBundles[id] = { path, backend: bundle.backend };
    graphicBackends.add(bundle.backend);
  }
  if (notices.size)
    bundleFiles.set(
      'graphics/notices.txt',
      [...notices]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, text]) => name + '\n' + text.trimEnd() + '\n')
        .join('\n'),
    );
  for (const asset of Object.values(definition.assets ?? {})) {
    asset.path = await add(resolve(dirname(source), asset.path));
    if (asset.kind === 'graphic') {
      const resources =
        asset.renderer === 'react' ? asset.resources : asset.fonts;
      for (const [id, path] of Object.entries(resources ?? {}))
        resources![id] = await add(resolve(dirname(source), path));
    }
  }
  for (const font of Object.values(definition.fonts ?? {}))
    if ('path' in font)
      font.path = await add(resolve(dirname(source), font.path));

  const entrySource = serializePackageEntry(definition);
  const total =
    Buffer.byteLength(entrySource) +
    [...bundleFiles.values()].reduce(
      (sum, text) => sum + Buffer.byteLength(text),
      0,
    ) +
    [...dependencies.values()].reduce((sum, item) => sum + item.bytes, 0);
  assertUniquePackagePaths([
    packageManifestName,
    packageEntryName,
    ...bundleFiles.keys(),
    ...[...dependencies.keys()].map((path) => `project/${path}`),
  ]);
  const { bavail, bsize } = await statfs(parent, { bigint: true });
  if (BigInt(total) > bavail * bsize)
    throw new VideoDefinitionError(
      `Package may require ${total} bytes for its files; there is insufficient free space at '${parent}'.`,
    );

  const stage = await mkdtemp(join(parent, '.opencut-package-'));
  const directories = new Set([stage]);
  try {
    const files: VideoPackageManifest['files'] = [];
    for (const [path, { identity }] of [...dependencies].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      signal?.throwIfAborted();
      const packaged = `project/${path}`;
      const to = join(stage, packaged);
      for (let dir = dirname(to); dir !== stage; dir = dirname(dir))
        directories.add(dir);
      await mkdir(dirname(to), { recursive: true });
      const from = await packageFile(project, path);
      await copyVideoInput(from, identity, to, signal);
      const { bytes, sha256 } = await fingerprintFile(to, signal);
      await syncPath(to);
      files.push({ path: packaged, bytes, sha256 });
    }
    for (const [path, { identity }] of dependencies)
      if (videoInputIdentity(await packageFile(project, path)) !== identity)
        throw new VideoDefinitionError(
          `Package dependency '${path}' changed during copying.`,
        );
    if (bundleFiles.size) {
      const bundleDirectory = join(stage, 'graphics');
      await mkdir(bundleDirectory, { mode: 0o700 });
      directories.add(bundleDirectory);
      for (const [path, payload] of bundleFiles) {
        const file = join(stage, path);
        await writeFile(file, payload, {
          flag: 'wx',
          mode: 0o600,
          signal,
          flush: true,
        });
        const { bytes, sha256 } = await fingerprintFile(file, signal);
        files.push({ path, bytes, sha256 });
      }
    }
    const entry = join(stage, packageEntryName);
    await writeFile(entry, entrySource, {
      flag: 'wx',
      mode: 0o600,
      signal,
      flush: true,
    });
    const { bytes, sha256 } = await fingerprintFile(entry, signal);
    files.push({ path: packageEntryName, bytes, sha256 });
    const { recipes, native } = packageRecipes(definition);
    const manifest: VideoPackageManifest = {
      format: 'opencut-video-package',
      version: graphics.size ? 2 : 1,
      ...(graphics.size && { graphics: graphicBundles }),
      opencut: getApplicationInfo().version,
      node: process.versions.node,
      entry: packageEntryName,
      source: authored,
      ...(resolvedParams !== undefined && { params: resolvedParams }),
      bytes: total,
      files,
      imports: [...edges.values()].sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.specifier.localeCompare(b.specifier),
      ),
      requirements: {
        ffmpeg: 'ffmpeg and ffprobe on PATH',
        native,
        authoringPackages: [...external].sort(),
        ...(graphics.size && { graphics: [...graphicBackends].sort() }),
      },
      recipes,
    };
    await writeCheckpoint(join(stage, packageManifestName), manifest);
    for (const path of [...directories].sort((a, b) => b.length - a.length))
      await syncPath(path);
    signal?.throwIfAborted();
    await checkOutput();
    await rename(stage, directory);
    await syncPath(parent);
    return { directory, entry: join(directory, packageEntryName), manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
