import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import {
  defaultMediaCacheDirectory,
  renderVideoTimeline,
  probeMedia,
  sourceFileStamp,
} from '@opencut/media';
import type { RenderControls } from '@opencut/media';
import type { Project } from './project.js';
import { resolveProjectRender } from './render-files.js';
import { projectRevision } from './editing.js';
import { lockProject } from './project-writer.js';
import { SessionError } from './session-transport.js';
import {
  canonicalProjectFilePath,
  resolveMediaReference,
} from './project-files.js';

const entryName = /^[a-f0-9]{64}$/;
const missing = (error: NodeJS.ErrnoException) => error.code === 'ENOENT';
const identity = (info: Awaited<ReturnType<typeof lstat>>) =>
  `${info.dev}:${info.ino}:${info.birthtimeMs}`;

async function lockCache(root: string, signal?: AbortSignal) {
  const deadline = Date.now() + 5000;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await lockProject(join(root, 'timeline-cache'));
    } catch (error) {
      if (
        !(error instanceof SessionError) ||
        error.code !== 'PROJECT_LOCKED' ||
        Date.now() >= deadline
      )
        throw error;
      await setTimeout(25, undefined, { signal });
    }
  }
}

async function ownedEntry(directory: string) {
  const file = join(directory, 'timeline.mp4');
  const manifest = join(directory, 'entry');
  const folder = await lstat(directory).catch(() => null);
  if (!folder?.isDirectory()) return null;
  const info = await lstat(file).catch(() => null);
  const stamp = await lstat(manifest).catch(() => null);
  if (
    !info?.isFile() ||
    info.nlink !== 1 ||
    !stamp?.isFile() ||
    stamp.size > 128 ||
    (await readFile(manifest, 'utf8').catch(() => '')) !== identity(info)
  )
    return null;
  return {
    directory,
    file,
    manifest,
    size: info.size,
    time: stamp.mtimeMs,
    identity: identity(info),
  };
}

async function removeEntry(
  entry: NonNullable<Awaited<ReturnType<typeof ownedEntry>>>,
) {
  const current = await ownedEntry(entry.directory);
  if (current?.identity !== entry.identity) return false;
  try {
    await unlink(entry.file);
    await unlink(entry.manifest);
    await rmdir(entry.directory);
    return true;
  } catch {
    return false;
  }
}

export async function renderPreviewCache(
  project: Project,
  projectPath: string,
  size = 960,
  options: Pick<RenderControls, 'signal' | 'onProgress'> = {},
  directory = defaultMediaCacheDirectory() + '-timeline-v2',
) {
  if (!Number.isInteger(size) || size < 64 || size > 1920)
    throw new Error('Preview size must be between 64 and 1920.');
  projectPath = await canonicalProjectFilePath(projectPath);
  const plan = await resolveProjectRender(project, projectPath);
  const files = [
    ...new Set([
      ...plan.visualClips.flatMap((clip) => (clip.path ? [clip.path] : [])),
      ...plan.audioClips.map((clip) => clip.path),
    ]),
  ].sort();
  const fingerprint = async () =>
    JSON.stringify(await Promise.all(files.map(sourceFileStamp)));
  const sources = await fingerprint();
  const checkSources = async () => {
    options.signal?.throwIfAborted();
    if (sources !== (await fingerprint()))
      throw new Error(
        'A source changed during preview rendering. Render the preview again.',
      );
    options.signal?.throwIfAborted();
  };
  const key = createHash('sha256')
    .update(JSON.stringify([2, size, plan, sources]))
    .digest('hex');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    (process.getuid &&
      (rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o022) !== 0))
  )
    throw new Error(
      'Timeline cache directory must be owned by the current user and protected from other writers.',
    );
  const snapshots = [
    project,
    ...[
      ...(project.editing?.undo ?? []),
      ...(project.editing?.redo ?? []),
    ].flatMap(({ before, after }) => [before, after]),
  ];
  const references = new Set(
    snapshots.flatMap(({ assets }) =>
      assets.map(({ file }) => resolveMediaReference(file, projectPath)),
    ),
  );
  const insideRoot = (source: string) => {
    const local = relative(root, source);
    return (
      !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep)
    );
  };
  for (const source of references) {
    if (
      insideRoot(source) ||
      insideRoot(await realpath(source).catch(() => source))
    )
      throw new Error(
        'Original media must be outside the dedicated timeline cache directory.',
      );
  }
  const folder = join(root, key);
  const path = join(folder, 'timeline.mp4');
  const verified = async () => {
    if (!(await ownedEntry(folder))) return false;
    const info = await probeMedia(path, options.signal);
    const [numerator, denominator] = (info.video?.frameRateRatio ?? '')
      .split('/')
      .map(Number);
    return (
      info.video?.codec === 'h264' &&
      info.audio?.codec === 'aac' &&
      numerator! * plan.frameRate.denominator ===
        denominator! * plan.frameRate.numerator &&
      Math.abs(
        (info.durationSeconds ?? -1) -
          (plan.frameCount * plan.frameRate.denominator) /
            plan.frameRate.numerator,
      ) < 0.002
    );
  };
  const hit = await verified().catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    return false;
  });
  if (hit) await checkSources();
  else {
    const existing = await lstat(folder).catch(
      (error: NodeJS.ErrnoException) => {
        if (missing(error)) return null;
        throw error;
      },
    );
    if (existing) {
      const owned = await ownedEntry(folder);
      if (!owned)
        throw new Error('Timeline cache entry is occupied by an unowned file.');
    }
    // Publish only after both the render and its inputs have been verified.
    const staging = await mkdtemp(join(root, '.preview-'));
    const output = join(staging, 'timeline.mp4');
    try {
      await renderVideoTimeline({
        ...plan,
        ...options,
        output,
        quality: 'draft',
        maxDimension: size,
      });
      await writeFile(join(staging, 'entry'), identity(await lstat(output)), {
        flag: 'wx',
        mode: 0o600,
      });
      await checkSources();
      const release = await lockCache(root, options.signal);
      try {
        if (await verified().catch(() => false)) await checkSources();
        else {
          const existing = await lstat(folder).catch(
            (error: NodeJS.ErrnoException) => {
              if (missing(error)) return null;
              throw error;
            },
          );
          if (existing) {
            const owned = await ownedEntry(folder);
            if (!owned || !(await removeEntry(owned)))
              throw new Error(
                'Timeline cache entry is occupied by an unowned file.',
              );
          }
          await checkSources();
          await rename(staging, folder);
        }
      } finally {
        release();
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const now = new Date();
  const published = await ownedEntry(folder);
  if (published) await utimes(published.manifest, now, now).catch(() => {});
  const entries = (
    await Promise.all(
      (await readdir(root))
        .filter((name) => entryName.test(name))
        .map((name) => ownedEntry(join(root, name))),
    )
  )
    .filter((item) => item !== null)
    .sort((a, b) => a.time - b.time);
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let count = entries.length;
  if (bytes > 2 * 1024 ** 3 || count > 64) {
    const release = await lockProject(join(root, 'timeline-cache')).catch(
      () => null,
    );
    if (release)
      try {
        for (const entry of entries) {
          if (bytes <= 2 * 1024 ** 3 && count <= 64) break;
          if (entry.file === path) continue;
          if (await removeEntry(entry)) {
            bytes -= entry.size;
            count--;
          }
        }
      } finally {
        release();
      }
  }
  return {
    path,
    hit,
    key,
    revision: projectRevision(project),
    frameCount: plan.frameCount,
    frameRate: plan.frameRate,
  };
}
