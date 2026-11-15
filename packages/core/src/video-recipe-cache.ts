import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';
import { videoInputIdentity } from './video-input.js';
import type { IdentifiedMedia } from './video-input.js';
import type { RecipeFormat } from './video-recipe-schema.js';

export async function materializeRecipeEntry(
  directory: string,
  key: string,
  format: RecipeFormat,
  signal: AbortSignal,
  encode: (output: string) => Promise<MediaMetadata>,
) {
  const release = await lockEntry(directory, key, signal);
  const staging = join(directory, `.${key}.stage`);
  try {
    signal.throwIfAborted();
    const target = join(directory, key);
    const filename = `media.${format}`;
    await rm(staging, { recursive: true, force: true });
    const cached = await readEntry(target, filename);
    if (cached) return { entry: cached, reused: true };
    await rm(target, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    const attempt = await mkdtemp(join(staging, 'attempt-'));
    const output = join(attempt, filename);
    const metadata = await encode(output);
    const identity = videoInputIdentity(output);
    if (!identity) throw new MediaError('Cannot identify recipe output.');
    const entry: IdentifiedMedia = {
      metadata: { ...metadata, path: join(target, filename) },
      identity,
    };
    await writeFile(join(attempt, 'result.json'), JSON.stringify(entry), {
      mode: 0o600,
    });
    signal.throwIfAborted();
    await rename(attempt, target);
    return { entry, reused: false };
  } finally {
    try {
      await rm(staging, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

async function readEntry(
  directory: string,
  filename: string,
): Promise<IdentifiedMedia | undefined> {
  const path = join(directory, filename);
  const manifest = join(directory, 'result.json');
  try {
    const media = await lstat(path);
    if (!media.isFile() || !media.size || !(await lstat(manifest)).isFile())
      return;
    const identity = videoInputIdentity(path);
    if (!identity) return;
    const entry = JSON.parse(
      await readFile(manifest, 'utf8'),
    ) as Partial<IdentifiedMedia> | null;
    if (entry?.metadata?.path === path && entry.identity === identity)
      return { metadata: entry.metadata, identity };
  } catch (error) {
    if (!(
      error instanceof SyntaxError ||
      (error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(String(error.code)))
    ))
      throw error;
  }
}

// A writer lock is released by the OS if its process exits. Sharding keeps
// unrelated steps independent without allocating a lock file for every key.
async function lockEntry(directory: string, key: string, signal: AbortSignal) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(
    join(directory, `.lock-${key.slice(0, 2)}.sqlite`),
  );
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        database.exec('BEGIN IMMEDIATE');
        return () => database.close();
      } catch (error) {
        // Extended SQLite codes keep SQLITE_BUSY (5) in their low byte.
        if (!(
          error instanceof Error &&
          'errcode' in error &&
          typeof error.errcode === 'number' &&
          (error.errcode & 0xff) === 5
        ))
          throw error;
        await delay(50, undefined, { signal });
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}
