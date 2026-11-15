import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  definitionLoadError,
  VideoDefinitionError,
} from './video-definition.js';
import { identifyVideoInput } from './video-input.js';
import type { RecordVideoInput, VideoInput } from './video-input.js';

export async function readDefinitionScript(
  path: string,
  record?: RecordVideoInput,
): Promise<unknown> {
  // Node keys ESM modules by URL. Pass the build ID along each local import
  // edge, including dynamic imports, while leaving package imports alone.
  const build = randomUUID();
  const parameter = 'opencut-build';
  const url = pathToFileURL(path);
  url.searchParams.set(parameter, build);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const { parentURL } = context;
      const local =
        parentURL?.startsWith('file:') &&
        new URL(parentURL).searchParams.get(parameter) === build &&
        /^(?:\.{1,2}\/|\/|file:)/.test(specifier);
      if (local && record) {
        const path = fileURLToPath(new URL(specifier, parentURL));
        record(identifyVideoInput(path, 'source'));
      }
      const resolved = nextResolve(specifier, context);
      if (!local || !resolved.url.startsWith('file:')) return resolved;
      const dependency = new URL(resolved.url);
      dependency.searchParams.set(parameter, build);
      return { ...resolved, url: dependency.href };
    },
    load(url, context, nextLoad) {
      if (
        record &&
        url.startsWith('file:') &&
        new URL(url).searchParams.get(parameter) === build
      ) {
        const path = fileURLToPath(url);
        record(identifyVideoInput(path, 'source'));
      }
      return nextLoad(url, context);
    },
  });
  try {
    // An async default export can still import helpers after module evaluation.
    return await ((
      await import(url.href)
    ).default as unknown);
  } catch (cause) {
    throw definitionLoadError(path, cause);
  } finally {
    hooks.deregister();
  }
}

export async function readIsolatedDefinitionScript(
  path: string,
  signal: AbortSignal,
  record?: RecordVideoInput,
): Promise<unknown> {
  signal.throwIfAborted();
  const worker = new Worker(
    new URL('./video-script-worker.js', import.meta.url),
    {
      workerData: path,
      execArgv: [],
      stdout: true,
      stderr: true,
    },
  );
  worker.stdout.pipe(process.stderr, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  let abort = () => {};
  try {
    return await new Promise<unknown>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.on(
        'message',
        (
          message:
            { input: VideoInput } | { value: unknown } | { error: string },
        ) => {
          if ('input' in message) {
            record?.(message.input);
          } else if ('error' in message)
            reject(new VideoDefinitionError(message.error));
          else resolve(message.value);
        },
      );
      worker.on('error', reject);
      worker.on('exit', (code) =>
        reject(
          new VideoDefinitionError(
            `Definition worker exited (${code}) while loading '${path}'.`,
          ),
        ),
      );
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
