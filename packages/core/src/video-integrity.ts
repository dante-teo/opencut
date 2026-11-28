import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprintSourceFile as fingerprintFile } from '@opencut/media';
export { fingerprintFile };

export const hashJson = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function ifPresent<T>(result: Promise<T>) {
  return result.catch((error: unknown) => {
    if (!missing(error)) throw error;
    return undefined;
  });
}

export async function readOutputFingerprint(
  path: string,
  signal?: AbortSignal,
) {
  if ((await ifPresent(lstat(path)))?.isFile())
    return ifPresent(fingerprintFile(path, signal));
}

/** Keep inspection useful when a published path can no longer be verified. */
export function inspectOutputFingerprint(path: string, signal?: AbortSignal) {
  return readOutputFingerprint(path, signal).catch(() => {
    signal?.throwIfAborted();
    return undefined;
  });
}

export const fileFingerprintSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.int().nonnegative(),
});
export type FileFingerprint = z.infer<typeof fileFingerprintSchema>;

export function matchesFingerprint(
  actual: FileFingerprint | undefined,
  expected: FileFingerprint,
) {
  return actual?.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

export async function syncPath(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeCheckpoint(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncPath(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

// A rollback-mode write lease is released by the OS on process exit.
export async function fileLease(
  path: string,
  signal?: AbortSignal,
  wait = true,
) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    for (;;) {
      signal?.throwIfAborted();
      try {
        database.exec('BEGIN IMMEDIATE');
        return () => database.close();
      } catch (error) {
        if (!(
          error instanceof Error &&
          'errcode' in error &&
          typeof error.errcode === 'number' &&
          (error.errcode & 0xff) === 5
        ))
          throw error;
        if (!wait) {
          database.close();
          return null;
        }
        await delay(50, undefined, { signal });
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
}
