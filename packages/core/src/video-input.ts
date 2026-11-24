import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import {
  sourceIdentity as videoInputIdentity,
  SourceChangedError,
} from '@opencut/media';
import type { fingerprintSourceFile, MediaMetadata } from '@opencut/media';
export { videoInputIdentity };

export type VideoInputKind =
  'source' | 'media' | 'font' | 'graphic' | 'graphic-runtime';
export interface VideoInput {
  path: string;
  kind: VideoInputKind;
  identity: string | null;
  fingerprint?: Awaited<ReturnType<typeof fingerprintSourceFile>>;
}

export interface IdentifiedMedia {
  metadata: MediaMetadata;
  identity: string;
}

export type RecordVideoInput = (input: VideoInput) => void;

export function identifyVideoInput(
  path: string,
  kind: VideoInputKind,
): VideoInput {
  return { path, kind, identity: videoInputIdentity(path) };
}

/** A private copy keeps the renderer's source stable across in-place edits. */
export async function copyVideoInput(
  path: string,
  identity: string,
  output: string,
  signal?: AbortSignal,
  stage = 'source snapshot',
) {
  const check = () => {
    signal?.throwIfAborted();
    const observed = videoInputIdentity(path);
    if (observed !== identity)
      throw new SourceChangedError(path, stage, identity, observed);
  };
  check();
  try {
    await copyFile(
      path,
      output,
      constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    );
  } finally {
    check();
  }
}
