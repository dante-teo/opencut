import { constants, statSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';

export type VideoInputKind = 'source' | 'media' | 'font';
export interface VideoInput {
  path: string;
  kind: VideoInputKind;
  identity: string | null;
}

export type RecordVideoInput = (input: VideoInput) => void;

export function identifyVideoInput(
  path: string,
  kind: VideoInputKind,
): VideoInput {
  return { path, kind, identity: videoInputIdentity(path) };
}

/** Include inode and high-resolution change time for replacements and in-place edits. */
export function videoInputIdentity(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isFile()) return null;
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

/** A private copy keeps the renderer's source stable across in-place edits. */
export async function copyVideoInput(
  path: string,
  identity: string,
  output: string,
  signal?: AbortSignal,
) {
  const check = () => {
    signal?.throwIfAborted();
    if (videoInputIdentity(path) !== identity)
      throw new Error(
        `Media '${path}' changed after it was read. Compile the definition again.`,
      );
  };
  check();
  await copyFile(
    path,
    output,
    constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
  );
  check();
}
