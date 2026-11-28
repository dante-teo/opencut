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
import { fileIdentity, MediaError } from '@opencut/media';
import { beautyReportSchema } from './beauty-report.js';
import type { BeautyRenderReport } from './beauty-report.js';
import type { MediaMetadata } from '@opencut/media';
import {
  fileLease,
  fingerprintFile,
  hashJson,
  ifPresent,
  missing,
  syncPath,
  writeCheckpoint,
} from './video-integrity.js';
import type { IdentifiedMedia } from './video-input.js';

export type MediaEntry = IdentifiedMedia & {
  sha256: string;
  beauty?: BeautyRenderReport;
};
export type MediaFingerprint = Pick<MediaEntry, 'identity' | 'sha256'>;
export const mediaStageDirectory = (directory: string, key: string) =>
  join(directory, `.${key}.stage`);

const mediaCacheReceipt = z.strictObject({
  version: z.literal(1),
  key: z.string(),
  bytes: z.int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataSha256: z.string(),
  beauty: beautyReportSchema.optional(),
  beautySha256: z.string().optional(),
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
  encode: (
    output: string,
  ) => Promise<MediaMetadata | Pick<MediaEntry, 'metadata' | 'beauty'>>,
  requiresBeauty = false,
) {
  const release = await fileLease(
    join(directory, `.lock-${key.slice(0, 2)}.sqlite`),
    signal,
  );
  const staging = mediaStageDirectory(directory, key);
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
    const cached = await findMediaEntry(
      directory,
      key,
      format,
      signal,
      requiresBeauty,
    );
    if (cached?.directory === target)
      return { entry: cached.entry, reused: true };
    await rm(target, { recursive: true, force: true });
    if (cached) return await publish(cached.directory, cached.entry, true);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    const attempt = await mkdtemp(join(staging, 'attempt-'));
    const output = join(attempt, filename);
    const encoded = await encode(output);
    const result = 'metadata' in encoded ? encoded : { metadata: encoded };
    const metadata: Omit<MediaMetadata, 'path'> & { path?: string } = {
      ...result.metadata,
    };
    delete metadata.path;
    const beauty = result.beauty;
    if (requiresBeauty && !beauty)
      throw new MediaError(
        'Beauty cache entry is missing its processing report.',
      );
    const { bytes, sha256, identity } = await fingerprintFile(output, signal);
    await syncPath(output);
    await writeCheckpoint(join(attempt, 'result.json'), {
      version: 1,
      key,
      bytes,
      sha256,
      metadataSha256: hashJson(metadata),
      metadata,
      ...(beauty && { beauty, beautySha256: hashJson(beauty) }),
    });
    return await publish(
      attempt,
      {
        metadata: { ...metadata, path: output },
        identity,
        sha256,
        ...(beauty && { beauty }),
      },
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
  requiresBeauty = false,
): Promise<{ directory: string; entry: MediaEntry } | undefined> {
  const target = join(directory, key);
  const published = async () => {
    const entry = await readMediaEntry(target, key, format, signal, {
      requiresBeauty,
    });
    return entry && { directory: target, entry };
  };
  const cached = await published();
  if (cached) return cached;

  const staging = mediaStageDirectory(directory, key);
  if (!(await ifPresent(lstat(staging)))?.isDirectory()) return published();
  // A process may have stopped after writing a valid receipt but before publishing.
  const attempts = await readdir(staging).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return [];
  });
  for (const name of attempts) {
    if (!/^attempt-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const attempt = join(staging, name);
    const entry = await readMediaEntry(attempt, key, format, signal, {
      requiresBeauty,
    }).catch(async (error: unknown) => {
      // An inspector can race a writer moving the attempt to its final location.
      if (signal?.aborted || (await ifPresent(lstat(attempt)))) throw error;
    });
    if (entry) return { directory: attempt, entry };
  }
  return published();
}

export async function mediaCacheMissReason(directory: string, key: string) {
  return (await ifPresent(lstat(join(directory, key))))
    ? ('entry-invalid' as const)
    : ('entry-missing' as const);
}

export async function readMediaEntry(
  target: string,
  key: string,
  format: string,
  signal?: AbortSignal,
  {
    requiresBeauty = false,
    fingerprint,
  }: {
    requiresBeauty?: boolean;
    fingerprint?: MediaFingerprint | undefined;
  } = {},
): Promise<MediaEntry | undefined> {
  const path = join(target, `media.${format}`);
  const manifest = join(target, 'result.json');
  try {
    if (
      !(await lstat(target)).isDirectory() ||
      !(await lstat(manifest)).isFile()
    )
      return;
    const info = await lstat(path);
    if (!info.isFile()) return;
    const parsed = mediaCacheReceipt.safeParse(
      JSON.parse(await readFile(manifest, 'utf8')),
    );
    if (!parsed.success) return;
    const receipt = parsed.data;
    const { metadata, beauty } = receipt;
    if (
      receipt.key !== key ||
      (requiresBeauty && !beauty) ||
      receipt.bytes !== info.size ||
      hashJson(metadata) !== receipt.metadataSha256 ||
      (beauty && hashJson(beauty) !== receipt.beautySha256)
    )
      return;
    signal?.throwIfAborted();
    // The receipt was read again. Reuse the hash only for the same payload identity.
    const { bytes, sha256, identity } =
      fingerprint?.sha256 === receipt.sha256 &&
      fingerprint.identity === fileIdentity(await lstat(path, { bigint: true }))
        ? { ...fingerprint, bytes: info.size }
        : await fingerprintFile(path, signal);
    if (receipt.bytes === bytes && receipt.sha256 === sha256)
      return {
        metadata: { ...metadata, path },
        identity,
        sha256,
        ...(beauty && { beauty }),
      };
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
