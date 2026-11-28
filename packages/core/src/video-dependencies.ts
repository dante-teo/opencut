import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileGraphic } from './video-graphics.js';
import { readVideoInput } from './video-files.js';
import { parseVideoDefinition } from './video-definition.js';
import type { ScriptImport } from './video-script.js';
import { scanPackageImports } from './video-package-imports.js';
import { ifPresent } from './video-integrity.js';
import { videoRecipeCacheDirectory } from './video-processing.js';
import {
  buildReceiptsDirectory,
  listDefinitionBuildArtifacts,
  readCompileReceipts,
} from './video-build.js';
import { mediaStageDirectory, readMediaEntry } from './video-media-cache.js';
import type { MediaFingerprint } from './video-media-cache.js';
import { videoInputIdentity } from './video-input.js';
import { readDeliveryReport } from './video-render-report.js';

interface Reference {
  role: string;
  owner: string;
  direct: boolean;
}
const isDeliveryRole = (role: string) =>
  role === 'export' || role === 'unverified-export';
type Options = {
  params?: unknown;
  signal?: AbortSignal;
  artifactRoots?: string[] | undefined;
  recipeCache?: string | undefined;
  renderReport?: string | undefined;
  cleanupPlan?: boolean | undefined;
};

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
    const info = await ifPresent(lstat(path));
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
  const cacheFingerprints = new Map<string, MediaFingerprint>();
  const diagnostics: {
    owner: string;
    message: string;
    code?: string;
    reason?: string;
  }[] = [];
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
      if (!(await ifPresent(stat(module)))) continue;
      for (const { specifier } of await scanPackageImports(module, signal)) {
        if (
          !/^(?:\.{1,2}\/|\/)/.test(specifier) ||
          edges.some(
            (edge) => edge.parent === module && edge.specifier === specifier,
          )
        )
          continue;
        const target = resolve(dirname(module), specifier);
        if (await ifPresent(stat(target)))
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

  const dependenciesComplete = value !== undefined && diagnostics.length === 0;
  const cache = videoRecipeCacheDirectory(options.recipeCache);
  for (const artifact of await listDefinitionBuildArtifacts(
    cache,
    path,
    signal,
  )) {
    if (!entries.has(artifact.path)) entries.set(artifact.path, []);
    if (artifact.role) add(artifact.path, artifact.role, artifact.owner, false);
    if (artifact.cacheFingerprint)
      cacheFingerprints.set(artifact.path, artifact.cacheFingerprint);
  }
  if (options.renderReport) {
    const { reportPath, output, reason } = await readDeliveryReport(
      options.renderReport,
      path,
      signal,
    );
    add(reportPath, 'render-report', 'render report', true);
    add(output, reason ? 'unverified-export' : 'export', reportPath, false);
    if (reason)
      diagnostics.push({
        owner: reportPath,
        code: 'RENDER_REPORT_OUTPUT_UNVERIFIABLE',
        reason,
        message: `Cannot verify '${output}'. Check that the original export and its matching report are available.`,
      });
  }

  const roots = [
    ...new Set((options.artifactRoots ?? []).map((path) => resolve(path))),
  ].sort();
  for (const root of roots) {
    if (!(await ifPresent(lstat(root)))?.isDirectory())
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
        const entry = await readMediaEntry(directory, key, format, signal, {
          fingerprint: cacheFingerprints.get(media),
        });
        if (entry)
          matches.push({
            media,
            fingerprint: { identity: entry.identity, sha256: entry.sha256 },
          });
      }
      // A generic receipt does not name its format. An ambiguous payload is
      // only classified if it was independently identified by build history.
      if (matches.length === 1) {
        const { media, fingerprint } = matches[0]!;
        cacheFingerprints.set(media, fingerprint);
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
      status: 'present' | 'missing' | 'not-file' | 'unreadable';
      bytes?: number;
      references: Reference[];
    }
  >();
  for (const path of [...entries.keys()].sort()) {
    signal?.throwIfAborted();
    const references = entries.get(path)!;
    const [resolved, info, lookupStatus] = await Promise.all([
      ifPresent(realpath(path)),
      ifPresent(stat(path)),
    ]).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ENOTDIR')
          return [undefined, undefined, 'missing'] as const;
        if (
          (error.code === 'EACCES' ||
            error.code === 'EPERM' ||
            error.code === 'ELOOP') &&
          references.some(({ role }) => isDeliveryRole(role))
        )
          return [undefined, undefined, 'unreadable'] as const;
      }
      throw error;
    });
    const resolvedPath = resolved ?? path;
    const record = files.get(resolvedPath) ?? {
      resolvedPath,
      paths: [],
      status:
        lookupStatus ??
        (!info ? 'missing' : info.isFile() ? 'present' : 'not-file'),
      ...(info?.isFile() && { bytes: info.size }),
      references: [],
    };
    record.paths.push(ownerPath(path));
    record.references.push(
      ...references.filter(
        ({ role }) =>
          role !== 'cache-media' ||
          cacheFingerprints.get(path)?.identity === videoInputIdentity(path),
      ),
    );
    files.set(resolvedPath, record);
  }
  const inventory = [...files.values()].map((item) => {
    const roles = item.references.length
      ? [...new Set(item.references.map(({ role }) => role))].sort()
      : ['unclassified'];
    const classification = roles.some(isDeliveryRole)
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
    ...(options.cleanupPlan && {
      cleanupPlan: await planRecipeCleanup(
        cache,
        path,
        inventory,
        dependenciesComplete,
        cacheFingerprints,
        signal,
      ),
    }),
  };
}

const recipeKey = /^[a-f0-9]{64}$/;

async function planRecipeCleanup(
  cache: string,
  definition: string,
  inventory: readonly {
    resolvedPath: string;
    classification: string;
    bytes?: number;
  }[],
  dependenciesComplete: boolean,
  cacheFingerprints: ReadonlyMap<string, MediaFingerprint>,
  signal?: AbortSignal,
) {
  const root = (await ifPresent(realpath(cache))) ?? cache;
  const keyFor = (path: string) => {
    const [key] = relative(root, path).split(sep);
    return key && recipeKey.test(key) ? key : undefined;
  };
  const recorded = new Map<
    string,
    { owners: Set<string>; formats: Set<string> }
  >();
  const incompleteReceipts: string[] = [];
  const protectedKeys = new Set<string>();
  const recordedInputs = new Set<string>();
  for await (const { path, receipt } of readCompileReceipts(root, signal)) {
    if (!receipt || receipt.state === 'compiling')
      incompleteReceipts.push(path);
    if (!receipt) continue;
    for (const { key, format } of receipt.steps) {
      const recipe = recorded.get(key) ?? {
        owners: new Set<string>(),
        formats: new Set<string>(),
      };
      recipe.owners.add(receipt.definition);
      recipe.formats.add(format);
      recorded.set(key, recipe);
    }
    for (const { path } of receipt.inputs) recordedInputs.add(path);
  }
  // A timeline can use cache media as an ordinary input, including via an alias.
  const unreadableBuildInputs: string[] = [];
  for (const path of recordedInputs) {
    signal?.throwIfAborted();
    const direct = keyFor(path);
    const physical = direct
      ? undefined
      : await realpath(path).catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          )
            return;
          unreadableBuildInputs.push(path);
        });
    const key = direct ?? (physical && keyFor(physical));
    if (key) protectedKeys.add(key);
  }
  const protectedFile = ({ classification }: (typeof inventory)[number]) =>
    classification === 'delivery' || classification === 'dependency';
  for (const file of inventory) {
    const key = keyFor(file.resolvedPath);
    if (key && protectedFile(file)) protectedKeys.add(key);
  }

  type Item = {
    path: string;
    bytes: number | null;
    reason: string;
    referencedBy?: string[];
  };
  const keep: Item[] = [];
  const eligible: Item[] = [];
  const uncertain: Item[] = [];
  const names = (await ifPresent(readdir(root)))?.sort() ?? [];
  const ownershipComplete =
    dependenciesComplete &&
    !incompleteReceipts.length &&
    !unreadableBuildInputs.length;
  const scanned = new Set<string>();
  for (const key of names.filter((name) => recipeKey.test(name))) {
    const path = join(root, key);
    const info = await ifPresent(lstat(path));
    if (!info) continue;
    scanned.add(key);
    let bytes = 0;
    const contents: string[] = [];
    for await (const file of artifacts(path, signal)) {
      if (file.info.isFile()) bytes += file.info.size;
      contents.push(file.path);
    }
    const recipe = recorded.get(key);
    const referencedBy = [...(recipe?.owners ?? [])].sort();
    const item = { path, bytes, referencedBy };
    const keepReason = protectedKeys.has(key)
      ? 'contains-project-input-or-delivery'
      : referencedBy.some((owner) => owner !== definition)
        ? 'referenced-by-another-timeline'
        : undefined;
    if (keepReason) {
      keep.push({ ...item, reason: keepReason });
      continue;
    }

    const [format, extra] = recipe?.formats ?? [];
    let uncertainReason: string | undefined;
    if (!referencedBy.length) uncertainReason = 'no-build-ownership-record';
    else if (!ownershipComplete)
      uncertainReason = 'incomplete-dependency-or-build-records';
    else if (await ifPresent(lstat(mediaStageDirectory(root, key))))
      uncertainReason = 'cache-staging-directory-present';
    else if (
      !info.isDirectory() ||
      !format ||
      extra ||
      contents.length !== 2 ||
      !contents.includes(join(path, 'result.json')) ||
      !contents.includes(join(path, `media.${format}`)) ||
      (await readdir(path)).length !== 2 ||
      !(await readMediaEntry(path, key, format, signal, {
        fingerprint: cacheFingerprints.get(join(cache, key, `media.${format}`)),
      }))
    )
      uncertainReason = 'unverified-cache-directory';
    (uncertainReason ? uncertain : eligible).push({
      ...item,
      reason: uncertainReason ?? 'verified-cache-owned-by-this-timeline',
    });
  }
  const buildReceipts = buildReceiptsDirectory(root) + sep;
  for (const file of inventory) {
    if (scanned.has(keyFor(file.resolvedPath) ?? '')) continue;
    const item = { path: file.resolvedPath, bytes: file.bytes ?? null };
    if (protectedFile(file) || file.resolvedPath.startsWith(buildReceipts))
      keep.push({ ...item, reason: 'project-file-delivery-or-build-record' });
    else uncertain.push({ ...item, reason: 'outside-recipe-ownership-scope' });
  }
  return {
    recipeCache: root,
    incompleteReceipts,
    unreadableBuildInputs,
    keep,
    eligible,
    uncertain,
  };
}
