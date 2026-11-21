import { constants } from 'node:fs';
import { link, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  convertJsonVideoDefinition,
  packageEntryName,
  videoDefinitionFormats,
  VideoDefinitionError,
} from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { UsageError } from './usage.js';

const sourceSuffix = '.video.json';
const maxBytes = 8 * 1024 * 1024;

export async function runConvert(file: string, json: boolean | undefined) {
  if (!file.endsWith(sourceSuffix))
    throw new UsageError('Choose a .video.json file to convert.');
  await withCommandCancellation(async (signal) => {
    const input = await realpath(file);
    const sourceName = basename(input.endsWith(sourceSuffix) ? input : file);
    const stem = sourceName.slice(0, -sourceSuffix.length);
    const { suffix } = videoDefinitionFormats.typescript;
    const filename = stem + suffix;
    const path = join(
      dirname(input),
      filename === packageEntryName ? stem + '.converted' + suffix : filename,
    );
    const handle = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
    let source: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes)
        throw new VideoDefinitionError(
          'Choose a regular JSON file up to 8 MiB.',
        );
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, {
          offset: length,
          position: length,
        });
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (
        length !== info.size ||
        (await handle.stat()).mtimeMs !== info.mtimeMs
      )
        throw new VideoDefinitionError(
          'The JSON file changed while reading. Retry the conversion.',
        );
      source = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      );
    } finally {
      await handle.close();
    }

    const converted = convertJsonVideoDefinition(source);
    const temporary = await mkdtemp(join(dirname(path), '.opencut-convert-'));
    try {
      const staged = join(temporary, 'definition');
      await writeFile(staged, converted, { flag: 'wx', signal, flush: true });
      signal.throwIfAborted();
      await link(staged, path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'EEXIST') throw cause;
        throw new VideoDefinitionError(
          `Conversion destination '${path}' already exists.`,
          { cause },
        );
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    console.log(json ? JSON.stringify({ path }) : `Saved ${path}`);
  });
}
