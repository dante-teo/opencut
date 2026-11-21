import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { fileIdentity, videoInputIdentity } from './video-input.js';

export const hashJson = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

export async function fingerprintFile(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat({ bigint: true });
    const identity = fileIdentity(info);
    if (!identity) throw new Error(`Expected a regular file: '${path}'.`);
    const hash = createHash('sha256');
    for await (const bytes of file.createReadStream({
      signal,
      autoClose: false,
    }))
      hash.update(bytes);
    if (videoInputIdentity(path) !== identity)
      throw new Error(`File '${path}' changed while it was being read.`);
    return { bytes: Number(info.size), sha256: hash.digest('hex'), identity };
  } finally {
    await file.close();
  }
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
