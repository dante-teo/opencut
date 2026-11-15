/** Optional Node adapter. The main core entry point remains free of filesystem imports. */
import { constants } from 'node:fs';
import { z } from 'zod';
import { lockProject } from './project-writer.js';
import {
  requestSession,
  reviewEndpoint,
  serveSession,
  SessionError,
} from './session-transport.js';
import {
  access,
  copyFile,
  link,
  mkdir,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { basename, dirname, extname, join, posix, win32 } from 'node:path';
import {
  deserializeProject,
  ProjectFormatError,
  mediaReferenceSchema,
  serializeProject,
  validateProject,
} from './project.js';
import type { MediaReference, Project, ProjectIssue } from './project.js';
import { MediaError } from '@opencut/media';
import { AssetError } from './assets.js';
import { TimelineError } from './timeline.js';
import {
  checkProjectRevision,
  commitEdit,
  checkLockedTracks,
  EditError,
  getEditHistory,
  projectRevision,
} from './editing.js';

function pathStyle(value: string): typeof posix {
  return /^[A-Za-z]:[/\\]/.test(value) || /^(?:\/\/|\\\\)/.test(value)
    ? win32
    : posix;
}

function isNativePath(path: string): boolean {
  return (process.platform === 'win32') === (pathStyle(path) === win32);
}

function absolutePath(value: string): string {
  const style = pathStyle(value);
  if (
    !style.isAbsolute(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(`Expected an absolute file path, received '${value}'.`);
  }
  const normalized = style.normalize(value);
  const path = style === win32 ? normalized.replaceAll('\\', '/') : normalized;
  if (!mediaReferenceSchema.safeParse({ type: 'absolute', path }).success) {
    throw new TypeError(
      `Cannot represent file path '${value}' in the project format.`,
    );
  }
  return path;
}

function nativePath(value: string): string {
  const path = absolutePath(value);
  if (!isNativePath(path)) {
    throw new TypeError(
      `Project file path '${value}' belongs to a different operating system.`,
    );
  }
  return path;
}

/** Resolve directory aliases while retaining the project filename for update safety checks. */
export async function canonicalProjectFilePath(value: string): Promise<string> {
  const path = absolutePath(value);
  if (!isNativePath(path)) return path;
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch (error) {
    // Availability checks also accept locations whose project directory is absent.
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return path;
    throw error;
  }
}

/** Prefer paths relative to the project file's directory, including sibling folders. */
export function createMediaReference(
  mediaFilePath: string,
  projectFilePath: string,
): MediaReference {
  const media = absolutePath(mediaFilePath);
  const project = absolutePath(projectFilePath);
  const style = pathStyle(project);
  if (
    style === pathStyle(media) &&
    style.parse(media).root.toLowerCase() ===
      style.parse(project).root.toLowerCase()
  ) {
    const relative = mediaReferenceSchema.safeParse({
      type: 'relative',
      path:
        style.relative(style.dirname(project), media).replaceAll('\\', '/') ||
        '.',
    });
    if (relative.success) return relative.data;
  }
  return mediaReferenceSchema.parse({ type: 'absolute', path: media });
}

/** Resolve against the containing project directory, never against the working directory. */
export function resolveMediaReference(
  reference: MediaReference,
  projectFilePath: string,
): string {
  const file = mediaReferenceSchema.parse(reference);
  const project = absolutePath(projectFilePath);
  if (file.type === 'absolute') return absolutePath(file.path);
  const style = pathStyle(project);
  return absolutePath(style.resolve(style.dirname(project), file.path));
}

export interface MediaAvailability {
  assetId: string;
  path: string;
  status:
    'available' | 'missing' | 'unreadable' | 'not_file' | 'unsupported_path';
  message: string;
}

export async function inspectMediaFile(
  path: string,
): Promise<Pick<MediaAvailability, 'status' | 'message'>> {
  if (!isNativePath(path)) {
    return {
      status: 'unsupported_path',
      message:
        'This absolute path belongs to a different operating system; relink the asset on this host.',
    };
  }
  try {
    if (!(await stat(path)).isFile()) {
      return {
        status: 'not_file',
        message: 'Media reference is not a regular file.',
      };
    }
    await access(path, constants.R_OK);
    return { status: 'available', message: 'Media file is readable.' };
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    const missing = code === 'ENOENT' || code === 'ENOTDIR';
    return {
      status: missing ? 'missing' : 'unreadable',
      message: missing
        ? 'Media file is missing; the project data remains usable.'
        : `Cannot read media file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Checks readable regular files only; does not probe, decode, relink or mutate a project. */
export async function checkProjectMedia(
  project: Project,
  projectFilePath: string,
): Promise<MediaAvailability[]> {
  const validated = validateProject(project);
  if (!validated.success) throw validated.error;
  const location = await canonicalProjectFilePath(projectFilePath);
  const results: MediaAvailability[] = [];
  for (const asset of validated.project.assets) {
    const path = resolveMediaReference(asset.file, location);
    results.push({
      assetId: asset.id,
      path,
      ...(await inspectMediaFile(path)),
    });
  }
  return results;
}

export class ProjectFileError extends Error {
  override name = 'ProjectFileError';
  constructor(
    public readonly code: 'READ_FAILED' | 'WRITE_FAILED' | 'UPDATE_FAILED',
    public readonly path: string,
    options: ErrorOptions,
  ) {
    const message =
      code === 'READ_FAILED'
        ? `Cannot read project file '${path}'.`
        : code === 'WRITE_FAILED'
          ? `Cannot create project file '${path}'; use a new file in an existing writable directory (existing files and symlinks are refused).`
          : `Cannot update project file '${path}': ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`;
    super(message, options);
  }
}

export async function readProjectFile(
  projectFilePath: string,
): Promise<Project> {
  const path = await canonicalProjectFilePath(nativePath(projectFilePath));
  return readProjectDisk(path);
}

async function readProjectDisk(projectFilePath: string): Promise<Project> {
  const path = nativePath(projectFilePath);
  let json: string;
  try {
    json = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ProjectFileError('READ_FAILED', path, { cause });
  }
  return deserializeProject(json);
}

export interface ProjectFileValidation {
  path: string;
  valid: boolean;
  structureValid: boolean;
  issues: readonly ProjectIssue[];
  media: MediaAvailability[];
}

/** Read-only validation of project data and every referenced media file. */
export async function validateProjectFile(
  projectFilePath: string,
): Promise<ProjectFileValidation> {
  const path = nativePath(projectFilePath);
  let project: Project;
  try {
    project = await readProjectFile(path);
  } catch (error) {
    if (!(error instanceof ProjectFormatError)) throw error;
    return {
      path,
      valid: false,
      structureValid: false,
      issues: error.issues,
      media: [],
    };
  }
  const media = await checkProjectMedia(project, path);
  return {
    path,
    valid: media.every((asset) => asset.status === 'available'),
    structureValid: true,
    issues: [],
    media,
  };
}

/** Create a project without replacing an existing file or symlink. */
export async function writeProjectFile(
  project: Project,
  projectFilePath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const path = nativePath(projectFilePath);
  await publishNewFile(path, serializeProject(project), signal).catch(
    (cause: unknown) => {
      if (signal?.aborted && cause === signal.reason) throw cause;
      throw new ProjectFileError('WRITE_FAILED', path, { cause });
    },
  );
}

export async function publishNewFile(
  path: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(dirname(path), '.opencut-create-'));
    const pending = join(temporary, 'pending');
    const file = await open(pending, 'wx');
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    try {
      await link(pending, path);
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !('code' in cause) ||
        (cause.code !== 'ENOTSUP' && cause.code !== 'EPERM')
      )
        throw cause;
      // Some writable volumes, including exFAT, cannot publish a hard link.
      signal?.throwIfAborted();
      await copyFile(pending, path, constants.COPYFILE_EXCL);
    }
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

/** Copy a saved revision and rebase media references in both content and history. */
export async function copyProjectFile(
  project: Project,
  sourcePath: string,
  destination: string,
  bundle = false,
) {
  sourcePath = await canonicalProjectFilePath(nativePath(sourcePath));
  destination = await canonicalProjectFilePath(nativePath(destination));
  const output = bundle
    ? join(destination, 'project.opencut.json')
    : destination;
  const copy = structuredClone(project);
  const snapshots = [
    copy,
    ...[...(copy.editing?.undo ?? []), ...(copy.editing?.redo ?? [])].flatMap(
      ({ before, after }) => [before, after],
    ),
  ];
  const references = new Map<string, MediaReference>();
  const files: string[] = [];
  let createdRoot = false;
  let createdMedia = false;
  const media = join(destination, 'media');
  try {
    if (bundle) {
      await mkdir(destination);
      createdRoot = true;
      await mkdir(media);
      createdMedia = true;
    }
    for (const [snapshotIndex, { assets }] of snapshots.entries()) {
      for (const asset of assets) {
        const path = resolveMediaReference(asset.file, sourcePath);
        let reference = references.get(path);
        if (!reference) {
          if (bundle) {
            const availability = await inspectMediaFile(path);
            if (availability.status !== 'available' && snapshotIndex === 0)
              throw new Error(
                `Cannot package '${asset.name}': ${availability.message}`,
              );
            const target = join(
              media,
              `${references.size + 1}${extname(path)}`,
            );
            if (availability.status === 'available') {
              await copyFile(path, target, constants.COPYFILE_EXCL);
              files.push(target);
            }
            reference = createMediaReference(target, output);
          } else {
            reference = isNativePath(path)
              ? createMediaReference(path, output)
              : asset.file;
          }
          references.set(path, reference);
        }
        asset.file = reference;
      }
    }
    getEditHistory(copy);
    await writeProjectFile(copy, output);
    return {
      path: output,
      revision: projectRevision(project),
      mediaFiles: files.length,
    };
  } catch (error) {
    for (const path of files) await rm(path, { force: true }).catch(() => {});
    if (createdMedia) await rmdir(media).catch(() => {});
    if (createdRoot) await rmdir(destination).catch(() => {});
    throw error;
  }
}

export interface ProjectUpdateOptions {
  expectedRevision?: number | undefined;
  dryRun?: boolean | undefined;
  label?: string | undefined;
  /** Restore one transaction, or preserve multiple validated in-memory session transactions. */
  history?: 'record' | 'restore' | 'preserve' | undefined;
  /** Cancel before atomic publication. */
  signal?: AbortSignal | undefined;
}

const entityId = z.string().min(1).max(120);
const actionOnly = z.strictObject({
  action: z.enum([
    'play',
    'pause',
    'toggle',
    'render-preview',
    'status',
    'live-preview',
  ]),
});
export const desktopControlSchema = z.union([
  actionOnly,
  z.strictObject({ action: z.literal('seek'), frame: z.int().nonnegative() }),
  z.strictObject({
    action: z.literal('source-seek'),
    seconds: z.number().nonnegative(),
  }),
  z.strictObject({
    action: z.literal('step'),
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.strictObject({
    action: z.literal('select'),
    kind: z.enum(['asset', 'clip']),
    id: entityId.nullable(),
  }),
  z.strictObject({
    action: z.literal('viewer'),
    viewer: z.enum(['project', 'source']),
  }),
]);
export type DesktopControlRequest = z.infer<typeof desktopControlSchema>;
export const desktopControlJsonSchema = () =>
  z.toJSONSchema(desktopControlSchema);
export async function controlDesktopProject(
  path: string,
  control: DesktopControlRequest,
) {
  const address = await reviewEndpoint(await canonicalProjectFilePath(path));
  const result = await requestSession(address, {
    version: 2,
    type: 'control',
    control: desktopControlSchema.parse(control),
  });
  if (result === undefined)
    throw new SessionError(
      'SESSION_CLOSED',
      'Open this saved project in OpenCut desktop first.',
    );
  return result;
}
const reviewRequest = z.strictObject({
  version: z.literal(2),
  type: z.literal('control'),
  control: desktopControlSchema,
});

/** Desktop controls have their own endpoint and never acquire the project lock. */
export async function serveDesktopControls(
  path: string,
  control: (request: DesktopControlRequest) => Promise<unknown>,
) {
  const address = await reviewEndpoint(path);
  const release = await lockProject(address);
  try {
    const stop = await serveSession(address, (value) =>
      control(reviewRequest.parse(value).control),
    );
    return async () => {
      try {
        await stop();
      } finally {
        release();
      }
    };
  } catch (error) {
    release();
    throw error;
  }
}

type Update<T> = (
  project: Project,
  path: string,
) => Promise<{ project: Project; result: T }>;

/** Headless updates hold the writer lock for a single disk transaction. */
export async function updateProjectFile<T>(
  path: string,
  update: Update<T>,
  options: ProjectUpdateOptions = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  const writer = await acquireProjectWriter(path);
  try {
    return await writer.update(update, options);
  } finally {
    await writer.close();
  }
}

/** Capability held by one authoritative writer. Never expose it to the renderer. */
export async function acquireProjectWriter(projectFilePath: string) {
  const path = await canonicalProjectFilePath(nativePath(projectFilePath));
  const release = await lockProject(path);
  let closed = false;
  let activeUpdate: Promise<unknown> | undefined;
  return {
    path,
    read: () => readProjectDisk(path),
    update: async <T>(
      update: Update<T>,
      options: ProjectUpdateOptions = {},
    ) => {
      if (closed)
        throw new SessionError('SESSION_CLOSED', 'Project writer is closed.');
      if (activeUpdate)
        throw new SessionError(
          'PROJECT_LOCKED',
          'A writer operation is in progress.',
        );
      try {
        const pending = updateProjectDisk(path, update, options);
        activeUpdate = pending;
        return await pending;
      } finally {
        activeUpdate = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        // Never release ownership while an already accepted publication is running.
        await activeUpdate?.catch(() => {});
      } finally {
        release();
      }
    },
  };
}
export type ProjectWriter = Awaited<ReturnType<typeof acquireProjectWriter>>;
export { SessionError };

/** Serialize cooperating writers and publish a complete, synced JSON file by rename. */
async function updateProjectDisk<T>(
  projectFilePath: string,
  update: Update<T>,
  options: ProjectUpdateOptions = {},
): Promise<T> {
  const { signal } = options;
  signal?.throwIfAborted();
  const requested = nativePath(projectFilePath);
  let path = requested;
  let temporary: string | undefined;
  let published = false;
  try {
    // Canonicalize the parent so directory aliases use the same writer lock.
    path = await canonicalProjectFilePath(requested);
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1)
      throw new Error(
        'Updates require a regular project file with one hard link; project symlinks and hard links are refused.',
      );
    const original = await readFile(path, 'utf8');
    const project = deserializeProject(original);
    checkProjectRevision(project, options.expectedRevision);
    const snapshot = serializeProject(project);
    const changed = await update(project, path);
    const baseline = deserializeProject(snapshot);
    if (options.history !== 'restore' && options.history !== 'preserve')
      checkLockedTracks(baseline, changed.project);
    const updated =
      options.history === 'restore' || options.history === 'preserve'
        ? changed.project
        : commitEdit(baseline, changed.project, options.label);
    const json = serializeProject(updated);
    if (
      (options.history === 'restore' || options.history === 'preserve') &&
      json !== snapshot
    ) {
      if (options.history === 'restore')
        checkProjectRevision(updated, projectRevision(baseline) + 1);
      else if (projectRevision(updated) <= projectRevision(baseline))
        throw new EditError(
          'REVISION_CONFLICT',
          'Saved session must advance the project revision.',
        );
      if (updated.metadata.id !== baseline.metadata.id)
        throw new EditError(
          'INVALID_TRANSACTION',
          'An edit cannot change project identity.',
        );
      getEditHistory(updated);
    }
    signal?.throwIfAborted();
    if (options.dryRun || json === snapshot) return changed.result;
    temporary = await mkdtemp(join(dirname(path), '.opencut-update-'));
    const pending = join(temporary, 'project.json');
    const file = await open(pending, 'wx', before.mode & 0o777);
    try {
      await file.chmod(before.mode & 0o777);
      await file.writeFile(json, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    const current = await lstat(path);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.nlink !== 1 ||
      current.mtimeMs !== before.mtimeMs ||
      (await readFile(path, 'utf8')) !== original
    )
      throw new EditError(
        'REVISION_CONFLICT',
        'Project changed during the operation; reload and retry.',
      );
    signal?.throwIfAborted();
    await rename(pending, path);
    published = true;
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return changed.result;
  } catch (cause) {
    if (published)
      throw new SessionError(
        'COMMIT_OUTCOME_UNKNOWN',
        'The edit was published but durability could not be confirmed. Reload before retrying.',
      );
    if (signal?.aborted && cause === signal.reason) throw cause;
    if (
      cause instanceof ProjectFormatError ||
      cause instanceof AssetError ||
      cause instanceof TimelineError ||
      cause instanceof EditError ||
      cause instanceof MediaError
    )
      throw cause;
    throw new ProjectFileError('UPDATE_FAILED', path, { cause });
  } finally {
    if (temporary)
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export {
  AssetError,
  importMediaAsset,
  prepareMediaAsset,
  prepareOnlineMediaAsset,
  prepareMediaRelink,
  prepareFreezeFrame,
  freezeProjectFrame,
  prepareEmbeddedFont,
  relinkMediaAsset,
  removeAssetFromProject,
  listMediaAssets,
  getMediaAsset,
  removeMediaAsset,
} from './assets.js';
export type { AssetInfo, AssetImportResult } from './assets.js';

export { renderProjectFile, resolveProjectRender } from './render-files.js';
export { renderPreviewCache } from './preview-cache.js';

export { readSubtitleFile, writeSubtitleFile } from './subtitle-files.js';

export { OnlineMediaLibrary, OnlineMediaError } from './online-media.js';
export type {
  OnlineMediaProvider,
  OnlineMediaKind,
  OnlineMediaSearch,
  OnlineMediaPage,
  OnlineMediaResult,
} from './online-media.js';

export {
  compileVideo,
  isVideoDefinitionPath,
  readVideoJsonForPreview,
} from './video-files.js';
export { VideoDefinitionError } from './video-compiler.js';
export type { CompiledVideo } from './video-compiler.js';
export {
  previewVideo,
  previewProject,
  previewFrameIndex,
  VideoPreviewRangeError,
} from './video-preview.js';
export type {
  PreviewPosition,
  VideoPreviewOptions,
  VideoPreviewRange,
} from './video-preview.js';
export { watchVideo } from './video-watch.js';
export type {
  VideoWatchOptions,
  VideoWatchRevision,
  VideoWatchStatus,
} from './video-watch.js';

export { migrateProject, VideoMigrationError } from './video-migration.js';
