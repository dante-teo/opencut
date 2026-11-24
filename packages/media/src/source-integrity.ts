import { createHash } from 'node:crypto';
import { constants, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { PictureRange } from './picture-cache.js';
import { fileIdentity, MediaError } from './process.js';

export function sourceIdentity(path: string) {
  try {
    return fileIdentity(statSync(path, { bigint: true }));
  } catch {
    return null;
  }
}

interface Fingerprint {
  identity: string;
  sha256: string;
  bytes: number;
}

export class SourceChangedError extends MediaError {
  readonly code = 'SOURCE_CHANGED';
  readonly change: {
    path: string;
    stage: string;
    before: string | null;
    after: string | null;
    content: 'unchanged' | 'changed' | 'unknown';
    beforeSha256?: string;
    afterSha256?: string;
    completedPictureRanges?: PictureRange[];
  };

  constructor(
    path: string,
    stage: string,
    before: string | null,
    after = sourceIdentity(path),
  ) {
    super(
      `Source '${path}' changed during ${stage}. Retry after the write completes.`,
    );
    this.change = { path, stage, before, after, content: 'unknown' };
  }

  async compareContent(baseline?: Fingerprint, signal?: AbortSignal) {
    if (!baseline || baseline.identity !== this.change.before) return;
    this.change.beforeSha256 = baseline.sha256;
    if (this.change.after === null) return;
    try {
      const current = await fingerprintSourceFile(
        this.change.path,
        signal,
        this.change.stage,
        true,
      );
      if (current.identity !== this.change.after) return;
      this.change.afterSha256 = current.sha256;
      this.change.content =
        current.sha256 === baseline.sha256 ? 'unchanged' : 'changed';
    } catch {
      signal?.throwIfAborted();
    }
  }
}

export function findSourceChange(error: unknown) {
  const seen = new Set<Error>();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) continue;
    if (current instanceof SourceChangedError) return current;
    seen.add(current);
    if (current instanceof AggregateError)
      for (const detail of current.errors) pending.push(detail);
    pending.push(current.cause);
  }
}

/** Hash through a single descriptor and require its identity to stay stable. */
export async function fingerprintSourceFile(
  path: string,
  signal?: AbortSignal,
  stage = 'fingerprinting',
  followSymlink = false,
) {
  signal?.throwIfAborted();
  // The descriptor can follow an intentional source symlink. Both the
  // descriptor and its path must still refer to the same revision afterward.
  const file = await open(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (followSymlink ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const info = await file.stat({ bigint: true });
    const identity = fileIdentity(info);
    if (!identity) throw new MediaError(`Expected a regular file: '${path}'.`);
    if (sourceIdentity(path) !== identity)
      throw new SourceChangedError(path, stage, identity);
    const hash = createHash('sha256');
    for await (const bytes of file.createReadStream({
      signal,
      autoClose: false,
    }))
      hash.update(bytes);
    if (
      fileIdentity(await file.stat({ bigint: true })) !== identity ||
      sourceIdentity(path) !== identity
    )
      throw new SourceChangedError(path, stage, identity);
    return { bytes: Number(info.size), sha256: hash.digest('hex'), identity };
  } finally {
    await file.close();
  }
}
