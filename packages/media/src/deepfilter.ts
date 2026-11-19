import { constants } from 'node:fs';
import { access, mkdir, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { renderAudioFile } from './audio-mastering.js';
import {
  checkRenderSignal,
  localFile,
  MediaError,
  runMediaTool,
  sourceFileStamp,
} from './process.js';
import { accountRenderFile } from './render-budget.js';

const timeout = 600_000;

export async function localEnhancer(signal?: AbortSignal) {
  const configured = process.env.OPENCUT_DEEPFILTER;
  if (configured && !isAbsolute(configured))
    throw new MediaError(
      'OPENCUT_DEEPFILTER must be an absolute executable path.',
    );
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((part) => resolve(part, 'deep-filter'));
  let executable: string | undefined;
  for (const candidate of candidates) {
    checkRenderSignal(signal);
    const found = await access(candidate, constants.X_OK)
      .then(() => realpath(candidate))
      .catch(() => undefined);
    if (found) {
      executable = found;
      break;
    }
  }
  if (!executable)
    throw new MediaError(
      'DeepFilterNet needs a local deep-filter executable on PATH or in OPENCUT_DEEPFILTER.',
    );
  const backend = executable;
  const model = process.env.OPENCUT_DEEPFILTER_MODEL;
  const localModel = model ? await localFile(model) : undefined;
  const run = (args: string[], timeout: number, writesFile = false) =>
    runMediaTool(backend, args, 1024 * 1024, timeout, {
      signal,
      writesFile,
      onDiagnostics() {},
    });
  let version: string;
  try {
    version = (await run(['--version'], 5000)).toString().trim();
  } catch (cause) {
    checkRenderSignal(signal);
    throw new MediaError(
      'DeepFilterNet needs a local deep-filter executable on PATH or in OPENCUT_DEEPFILTER.',
      { cause },
    );
  }
  return {
    key: [
      version,
      await sourceFileStamp(backend),
      localModel && (await sourceFileStamp(localModel)),
    ],
    async enhance(input: string, folder: string, outputFolder: string) {
      await mkdir(outputFolder);
      const padded = join(folder, 'speech.wav');
      await renderAudioFile(
        ['-i', input, '-af', 'apad=pad_len=4800', '-c:a', 'pcm_s16le'],
        padded,
        signal,
      );
      try {
        await run(
          [
            '-D',
            '-o',
            outputFolder,
            ...(localModel ? ['-m', localModel] : []),
            padded,
          ],
          timeout,
          true,
        );
      } catch (cause) {
        checkRenderSignal(signal);
        throw new MediaError(
          `DeepFilterNet could not process the local dialogue. ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      const output = join(outputFolder, 'speech.wav');
      await accountRenderFile(output);
      return output;
    },
  };
}
