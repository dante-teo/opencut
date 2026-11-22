import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileGraphic } from './video-graphics.js';
import { readVideoInput } from './video-files.js';
import { parseVideoDefinition } from './video-definition.js';
import type { ScriptImport } from './video-script.js';
import { scanPackageImports } from './video-package-imports.js';
import {
  fileFingerprintSchema,
  matchesFingerprint,
  missing,
} from './video-integrity.js';
import { processingSettings } from './video-processing.js';
import {
  listDefinitionBuildArtifacts,
  readOutputFingerprint,
} from './video-build.js';
import { readMediaEntry } from './video-media-cache.js';
import { videoInputIdentity } from './video-input.js';

interface Reference {
  role: string;
  owner: string;
  direct: boolean;
}
type Options = {
  params?: unknown;
  signal?: AbortSignal;
  artifactRoots?: string[] | undefined;
  recipeCache?: string | undefined;
  renderReport?: string | undefined;
};

async function optional<T>(result: Promise<T>) {
  return result.catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}

async function* artifacts(root: string, signal?: AbortSignal) {
  const todo = [root];
  let visited = 0;
  while (todo.length) {
    signal?.throwIfAborted();
    if (++visited > 20000)
      throw new Error(
        `Artifact root '${root}' exceeds 20000 entries. Choose a narrower root.`,
      );
    const path = todo.pop()!;
    const info = await optional(lstat(path));
    if (!info) continue;
    if (info.isDirectory())
      for (const name of (await readdir(path)).sort().reverse())
        todo.push(join(path, name));
    else yield { path, info };
  }
}

/** Discover authored references even when media are missing, without materializing builds. */
export async function inspectVideoDependencies(
  file: string,
  options: Options = {},
) {
  const { signal } = options;
  const entries = new Map<string, Reference[]>();
  const cacheIdentities = new Map<string, string>();
  const diagnostics: { owner: string; message: string }[] = [];
  function add(path: string, role: string, owner: string, direct: boolean) {
    const refs = entries.get(path) ?? [];
    refs.push({ role, owner, direct });
    entries.set(path, refs);
  }
  const edges: ScriptImport[] = [];
  const imports = new Set<string>();
  const localImport = (specifier: string) =>
    /^(?:\.{1,2}\/|\/|file:)/.test(specifier);
  const { path, value, verified } = await readVideoInput(
    file,
    options,
    (input) => {
      imports.add(input.path);
    },
    (edge) => edges.push(edge),
  ).catch(async (error: unknown) => {
    signal?.throwIfAborted();
    if (
      !edges.some(
        ({ specifier, unresolved }) => unresolved && localImport(specifier),
      )
    )
      throw error;
    const path = await realpath(file);
    diagnostics.push({
      owner: basename(path),
      message: error instanceof Error ? error.message : String(error),
    });
    return { path, value: undefined, verified: undefined };
  });
  const root = dirname(path);
  const ownerPath = (file: string) => relative(root, file) || '.';
  add(path, 'definition', ownerPath(path), true);
  for (const edge of edges) {
    const { parent, specifier } = edge;
    if (!edge.path && !localImport(specifier)) continue;
    const target =
      edge.path ?? fileURLToPath(new URL(specifier, pathToFileURL(parent)));
    add(target, 'definition-module', ownerPath(parent), parent === path);
  }
  if (verified) {
    for (const module of imports)
      if (module !== path)
        add(module, 'package-dependency', ownerPath(path), false);
  } else {
    // Runtime hooks miss erased type imports and inactive literal branches.
    for (const module of imports) {
      if (!(await optional(stat(module)))) continue;
      for (const { specifier } of await scanPackageImports(module, signal)) {
        if (
          !/^(?:\.{1,2}\/|\/)/.test(specifier) ||
          edges.some(
            (edge) => edge.parent === module && edge.specifier === specifier,
          )
        )
          continue;
        const target = resolve(dirname(module), specifier);
        if (await optional(stat(target)))
          add(target, 'definition-module', ownerPath(module), module === path);
      }
    }
  }
  if (value !== undefined) {
    const {
      assets = {},
      fonts = {},
      canvas,
      tracks,
    } = parseVideoDefinition(value);
    const { frameRate, ...settings } = canvas;
    const rate =
      typeof frameRate === 'number'
        ? { numerator: frameRate, denominator: 1 }
        : frameRate;
    const authored = (file: string) => resolve(root, file);
    for (const [id, asset] of Object.entries(assets)) {
      signal?.throwIfAborted();
      const owner = `assets.${id}`;
      if (asset.path)
        add(
          authored(asset.path),
          asset.kind === 'graphic' ? 'graphic-source' : 'media',
          owner,
          true,
        );
      if (asset.kind !== 'graphic') continue;
      const direct = new Set(asset.path ? [authored(asset.path)] : [path]);
      const resources =
        asset.renderer === 'svg' ? asset.fonts : asset.resources;
      for (const [name, resource] of Object.entries(resources ?? {})) {
        const file = authored(resource);
        direct.add(file);
        add(
          file,
          asset.renderer === 'svg' ? 'font' : 'graphic-resource',
          `${owner}.${asset.renderer === 'svg' ? 'fonts' : 'resources'}.${name}`,
          true,
        );
      }
      if (asset.renderer === 'scene')
        for (const [name, sample] of Object.entries(asset.mediaFrames ?? {})) {
          const source = assets[sample.asset]?.path;
          if (source)
            add(
              authored(source),
              'graphic-media-frame',
              `${owner}.mediaFrames.${name}`,
              false,
            );
        }
      if (asset.renderer !== 'react' || verified || !asset.path) continue;
      try {
        // Use the graphics compiler's own local TSX, CSS and asset resolution.
        await compileGraphic(
          id,
          asset,
          path,
          { ...settings, frameRate: rate },
          ({ path: dependency, kind }) => {
            if (!direct.has(dependency))
              add(
                dependency,
                kind === 'graphic-runtime' ||
                  dependency.includes(sep + 'node_modules' + sep)
                  ? 'graphic-runtime'
                  : 'graphic-dependency',
                owner,
                false,
              );
          },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        diagnostics.push({
          owner,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const [id, font] of Object.entries(fonts))
      if ('path' in font) add(authored(font.path), 'font', `fonts.${id}`, true);
    for (const [i, track] of tracks.entries())
      for (const [j, clip] of track.clips.entries()) {
        const asset = 'asset' in clip && assets[clip.asset];
        if (!asset || !asset.path) continue;
        add(
          authored(asset.path),
          track.type === 'audio'
            ? 'audio-input'
            : asset.kind === 'graphic'
              ? 'graphic-input'
              : 'picture-input',
          `tracks.${track.id ?? i}.clips.${clip.id ?? j}`,
          false,
        );
      }
  }

  const cache = processingSettings({
    cacheDirectory: options.recipeCache,
  }).directory;
  for (const artifact of await listDefinitionBuildArtifacts(
    cache,
    path,
    signal,
  )) {
    if (!entries.has(artifact.path)) entries.set(artifact.path, []);
    if (artifact.role) add(artifact.path, artifact.role, artifact.owner, false);
    if (artifact.cacheIdentity)
      cacheIdentities.set(artifact.path, artifact.cacheIdentity);
  }
  if (options.renderReport) {
    const reportPath = resolve(options.renderReport);
    const report = JSON.parse(
      await readFile(reportPath, { encoding: 'utf8', signal }),
    ) as {
      path?: unknown;
      definitionPath?: unknown;
      frameCount?: unknown;
      metadata?: { path?: unknown };
      outputFingerprint?: unknown;
    };
    if (
      !report ||
      typeof report.path !== 'string' ||
      typeof report.frameCount !== 'number' ||
      report.path !== report.metadata?.path ||
      (typeof report.definitionPath === 'string' &&
        resolve(report.definitionPath) !== path)
    )
      throw new Error('Expected a render JSON result for this definition.');
    add(reportPath, 'render-report', 'render report', true);
    const output = resolve(dirname(reportPath), report.path);
    const expected = fileFingerprintSchema.safeParse(report.outputFingerprint);
    const verified =
      expected.success &&
      matchesFingerprint(
        await readOutputFingerprint(output, signal),
        expected.data,
      );
    add(output, verified ? 'export' : 'unverified-export', reportPath, false);
  }

  const roots = [
    ...new Set((options.artifactRoots ?? []).map((path) => resolve(path))),
  ].sort();
  for (const root of roots) {
    if (!(await optional(lstat(root)))?.isDirectory())
      throw new Error(`Artifact root '${root}' must be a directory.`);
    for await (const { path, info } of artifacts(root, signal)) {
      if (!entries.has(path)) entries.set(path, []);
      if (basename(path) !== 'result.json' || !info.isFile()) continue;
      const directory = dirname(path);
      const key = basename(directory);
      if (!/^[a-f0-9]{64}(?:\.[a-f0-9]{64})?$/.test(key)) continue;
      const matches = [];
      for (const name of (await readdir(directory)).sort()) {
        const format = /^media\.(mkv|nut|mov|mp4|png|wav|flac)$/.exec(
          name,
        )?.[1];
        if (!format) continue;
        const media = join(directory, name);
        const identity = cacheIdentities.get(media);
        if (identity && videoInputIdentity(media) === identity) {
          matches.push({ media, identity });
          continue;
        }
        const entry = await readMediaEntry(directory, key, format, signal);
        if (entry) matches.push({ media, identity: entry.identity });
      }
      // A generic receipt does not name its format. An ambiguous payload is
      // only classified if it was independently identified by build history.
      if (matches.length === 1) {
        const { media, identity } = matches[0]!;
        cacheIdentities.set(media, identity);
        add(path, 'cache-manifest', ownerPath(root), false);
        add(media, 'cache-media', ownerPath(path), false);
      }
    }
  }

  // Merge symlink aliases while retaining all references and authored paths.
  const files = new Map<
    string,
    {
      resolvedPath: string;
      paths: string[];
      status: 'present' | 'missing' | 'not-file';
      bytes?: number;
      references: Reference[];
    }
  >();
  for (const path of [...entries.keys()].sort()) {
    signal?.throwIfAborted();
    const [resolved, info] = await Promise.all([
      optional(realpath(path)),
      optional(stat(path)),
    ]);
    const resolvedPath = resolved ?? path;
    const record = files.get(resolvedPath) ?? {
      resolvedPath,
      paths: [],
      status: !info ? 'missing' : info.isFile() ? 'present' : 'not-file',
      ...(info?.isFile() && { bytes: info.size }),
      references: [],
    };
    record.paths.push(ownerPath(path));
    record.references.push(
      ...entries
        .get(path)!
        .filter(
          ({ role }) =>
            role !== 'cache-media' ||
            cacheIdentities.get(path) === videoInputIdentity(path),
        ),
    );
    files.set(resolvedPath, record);
  }
  const inventory = [...files.values()].map((item) => {
    const roles = item.references.length
      ? [...new Set(item.references.map(({ role }) => role))].sort()
      : ['unclassified'];
    const classification =
      roles.includes('export') || roles.includes('unverified-export')
        ? 'delivery'
        : roles.every(
              (role) => role === 'cache-manifest' || role === 'cache-media',
            )
          ? 'regenerable-cache'
          : roles.includes('unclassified')
            ? 'unclassified'
            : 'dependency';
    return {
      ...item,
      relativePath: item.paths[0]!,
      roles,
      classification,
      regenerable: classification === 'regenerable-cache',
      references: [
        ...new Map(
          item.references.map((ref) => [JSON.stringify(ref), ref]),
        ).values(),
      ],
    };
  });
  const byteTotals = {
    regenerableCache: 0,
    deliveries: 0,
    unclassified: 0,
    dependencies: 0,
  };
  for (const { classification, bytes = 0 } of inventory) {
    if (classification === 'regenerable-cache')
      byteTotals.regenerableCache += bytes;
    else if (classification === 'delivery') byteTotals.deliveries += bytes;
    else if (classification === 'unclassified')
      byteTotals.unclassified += bytes;
    else byteTotals.dependencies += bytes;
  }
  return {
    inspectionVersion: 1,
    definitionPath: path,
    definitionEvaluated: value !== undefined,
    projectRoot: root,
    artifactRoots: roots,
    files: inventory,
    byteTotals,
    diagnostics,
  };
}
