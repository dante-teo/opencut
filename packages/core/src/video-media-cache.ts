import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MediaMetadata } from '@opencut/media';
import {
  fileLease,
  fingerprintFile,
  hashJson,
  missing,
  syncPath,
  writeCheckpoint,
} from './video-integrity.js';
import type { IdentifiedMedia } from './video-input.js';

type MediaEntry = IdentifiedMedia & { sha256: string };
const stageDirectory = (directory: string, key: string) =>
  join(directory, `.${key}.stage`);

export const mediaCacheReceipt = z.strictObject({
  version: z.literal(1),
  key: z.string(),
  bytes: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataSha256: z.string(),
  metadata: z.custom<Omit<MediaMetadata, 'path'>>(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      'streams' in value &&
      Array.isArray(value.streams) &&
      !('path' in value),
  ),
});

export async function materializeMediaEntry(
  directory: string,
  key: string,
  format: string,
  signal: AbortSignal,
  encode: (output: string) => Promise<MediaMetadata>,
) {
  const release = await fileLease(
    join(directory, `.lock-${key.slice(0, 2)}.sqlite`),
    signal,
  );
  const staging = stageDirectory(directory, key);
  try {
    signal.throwIfAborted();
    const target = join(directory, key);
    const filename = `media.${format}`;
    const publish = async (
      attempt: string,
      entry: MediaEntry,
      reused: boolean,
    ) => {
      signal.throwIfAborted();
      await rename(attempt, target);
      await syncPath(directory);
      return {
        entry: {
          ...entry,
          metadata: { ...entry.metadata, path: join(target, filename) },
        },
        reused,
      };
    };
    const cached = await findMediaEntry(directory, key, format, signal);
    if (cached?.directory === target)
      return { entry: cached.entry, reused: true };
    await rm(target, { recursive: true, force: true });
    if (cached) return await publish(cached.directory, cached.entry, true);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    const attempt = await mkdtemp(join(staging, 'attempt-'));
    const output = join(attempt, filename);
    const metadata: Omit<MediaMetadata, 'path'> & { path?: string } = {
      ...(await encode(output)),
    };
    delete metadata.path;
    const { bytes, sha256, identity } = await fingerprintFile(output, signal);
    await syncPath(output);
    await writeCheckpoint(join(attempt, 'result.json'), {
      version: 1,
      key,
      bytes,
      sha256,
      metadataSha256: hashJson(metadata),
      metadata,
    });
    return await publish(
      attempt,
      { metadata: { ...metadata, path: output }, identity, sha256 },
      false,
    );
  } finally {
    try {
      await rm(staging, { recursive: true, force: true });
    } finally {
      release?.();
    }
  }
}

/** Find validated media without publishing or removing anything. */
export async function findMediaEntry(
  directory: string,
  key: string,
  format: string,
  signal?: AbortSignal,
): Promise<{ directory: string; entry: MediaEntry } | undefined> {
  const target = join(directory, key);
  const published = async () => {
    const entry = await readMediaEntry(target, key, format, signal);
    return entry && { directory: target, entry };
  };
  const cached = await published();
  if (cached) return cached;

  const staging = stageDirectory(directory, key);
  if (!(await statIfPresent(staging))?.isDirectory()) return published();
  // A process may have stopped after writing a valid receipt but before publishing.
  const attempts = await readdir(staging).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return [];
  });
  for (const name of attempts) {
    if (!/^attempt-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const attempt = join(staging, name);
    const entry = await readMediaEntry(attempt, key, format, signal).catch(
      async (error: unknown) => {
        // An inspector can race a writer moving the attempt to its final location.
        if (signal?.aborted || (await statIfPresent(attempt))) throw error;
      },
    );
    if (entry) return { directory: attempt, entry };
  }
  return published();
}

async function statIfPresent(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
}

async function readMediaEntry(
  target: string,
  key: string,
  format: string,
  signal?: AbortSignal,
): Promise<MediaEntry | undefined> {
  const path = join(target, `media.${format}`);
  const manifest = join(target, 'result.json');
  try {
    if (
      !(await lstat(target)).isDirectory() ||
      !(await lstat(manifest)).isFile() ||
      !(await lstat(path)).isFile()
    )
      return;
    const parsed = mediaCacheReceipt.safeParse(
      JSON.parse(await readFile(manifest, 'utf8')),
    );
    if (
      !parsed.success ||
      parsed.data.key !== key ||
      hashJson(parsed.data.metadata) !== parsed.data.metadataSha256
    )
      return;
    const { bytes, sha256, identity } = await fingerprintFile(path, signal);
    if (parsed.data.bytes === bytes && parsed.data.sha256 === sha256)
      return { metadata: { ...parsed.data.metadata, path }, identity, sha256 };
  } catch (error) {
    if (
      !missing(error) &&
      !(error instanceof SyntaxError) &&
      !(
        error instanceof Error &&
        'code' in error &&
        ['ENOTDIR', 'EISDIR'].includes(String(error.code))
      )
    )
      throw error;
  }
}
