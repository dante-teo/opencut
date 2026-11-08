import { constants } from 'node:fs';
import { link, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  parseSubtitles,
  serializeSubtitles,
  SubtitleError,
  subtitleFormat,
} from './subtitle-formats.js';
import type { SubtitleCueInput } from './subtitles.js';

const maxBytes = 16 * 1024 * 1024;

export async function readSubtitleFile(file: string, signal?: AbortSignal) {
  const format = subtitleFormat(file);
  signal?.throwIfAborted();
  const handle = await open(
    resolve(file),
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new SubtitleError('Choose a regular subtitle file up to 16 MiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== stat.size)
      throw new SubtitleError(
        'Subtitle file size changed while reading. Retry the import.',
      );
    let data: string;
    try {
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? 'utf-16be'
            : 'utf-8';
      data = new TextDecoder(encoding, { fatal: true }).decode(
        bytes.subarray(0, count),
      );
    } catch (cause) {
      throw new SubtitleError(
        'Subtitle file must be UTF-8 or BOM-marked UTF-16.',
        { cause },
      );
    }
    return { format, cues: parseSubtitles(data, format) };
  } finally {
    await handle.close();
  }
}

export async function writeSubtitleFile(
  file: string,
  cues: readonly SubtitleCueInput[],
  signal?: AbortSignal,
) {
  const path = resolve(file);
  const format = subtitleFormat(path);
  const data = serializeSubtitles(cues, format);
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(dirname(path), '.opencut-subtitles-'));
  try {
    const staged = join(temporary, 'sidecar');
    await writeFile(staged, data, { flag: 'wx', signal });
    signal?.throwIfAborted();
    try {
      await link(staged, path);
    } catch (cause) {
      throw new SubtitleError(
        `Cannot publish subtitle sidecar '${path}'. Choose a new path on a filesystem that supports hard links.`,
        { cause },
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { path, format, cueCount: cues.length };
}
