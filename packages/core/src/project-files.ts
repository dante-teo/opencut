/** Optional Node adapter. The main core entry point remains free of filesystem imports. */
import { constants } from 'node:fs';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import {
  deserializeProject,
  mediaReferenceSchema,
  serializeProject,
  validateProject,
} from './project.js';
import type { MediaReference, Project } from './project.js';

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

async function inspectMediaFile(
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
  const location = absolutePath(projectFilePath);
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
    public readonly code: 'READ_FAILED' | 'WRITE_FAILED',
    public readonly path: string,
    options: ErrorOptions,
  ) {
    const message =
      code === 'READ_FAILED'
        ? `Cannot read project file '${path}'.`
        : `Cannot create project file '${path}'; use a new file in an existing writable directory (existing files and symlinks are refused).`;
    super(message, options);
  }
}

export async function readProjectFile(
  projectFilePath: string,
): Promise<Project> {
  const path = nativePath(projectFilePath);
  let json: string;
  try {
    json = await readFile(path, 'utf8');
  } catch (cause) {
    throw new ProjectFileError('READ_FAILED', path, { cause });
  }
  return deserializeProject(json);
}

/** Exclusive creation only. Updating/overwriting existing project files is deferred. */
export async function writeProjectFile(
  project: Project,
  projectFilePath: string,
): Promise<void> {
  const path = nativePath(projectFilePath);
  const json = serializeProject(project);
  try {
    await writeFile(path, json, { encoding: 'utf8', flag: 'wx' });
  } catch (cause) {
    throw new ProjectFileError('WRITE_FAILED', path, { cause });
  }
}
