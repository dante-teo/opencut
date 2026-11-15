import { randomUUID } from 'node:crypto';
import { isBuiltin, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  definitionLoadError,
  resolveVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import type {
  ResolvedVideoDefinition,
  VideoParameters,
} from './video-definition.js';
import { identifyVideoInput } from './video-input.js';
import type { RecordVideoInput, VideoInput } from './video-input.js';

export type ScriptImport = {
  parent: string;
  specifier: string;
  path?: string;
  unresolved?: boolean;
};

export async function readDefinitionScript(
  path: string,
  record?: RecordVideoInput,
  params?: VideoParameters,
  trace?: (edge: ScriptImport) => void,
): Promise<ResolvedVideoDefinition> {
  // Node keys ESM modules by URL. Pass the build ID along each local import
  // edge, including dynamic imports, while leaving package imports alone.
  const build = randomUUID();
  const parameter = 'opencut-build';
  const url = pathToFileURL(path);
  url.searchParams.set(parameter, build);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const { parentURL } = context;
      if (
        !parentURL?.startsWith('file:') ||
        new URL(parentURL).searchParams.get(parameter) !== build
      )
        return nextResolve(specifier, context);
      const local = /^(?:\.{1,2}\/|\/|file:)/.test(specifier);
      if (local && record) {
        const path = fileURLToPath(new URL(specifier, parentURL));
        record(identifyVideoInput(path, 'source'));
      }
      let resolved: ReturnType<typeof nextResolve>;
      try {
        resolved = nextResolve(specifier, context);
      } catch (error) {
        trace?.({
          parent: fileURLToPath(parentURL),
          specifier,
          unresolved: true,
        });
        throw error;
      }
      if (trace && !isBuiltin(specifier))
        trace({
          parent: fileURLToPath(parentURL),
          specifier,
          ...(local &&
            resolved.url.startsWith('file:') && {
              path: fileURLToPath(resolved.url),
            }),
        });
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
    const value: unknown = await (await import(url.href)).default;
    return await resolveVideoDefinition(value, params);
  } catch (cause) {
    throw definitionLoadError(path, cause);
  } finally {
    hooks.deregister();
  }
}

export async function readIsolatedDefinitionScript(
  path: string,
  signal: AbortSignal | undefined,
  record?: RecordVideoInput,
  params?: VideoParameters,
  authoringHeapMb?: number,
  trace?: (edge: ScriptImport) => void,
): Promise<ResolvedVideoDefinition> {
  signal?.throwIfAborted();
  const worker = new Worker(
    new URL('./video-script-worker.js', import.meta.url),
    {
      workerData: { path, params, traceImports: trace !== undefined },
      execArgv: [],
      ...(authoringHeapMb !== undefined && {
        resourceLimits: { maxOldGenerationSizeMb: authoringHeapMb },
      }),
      stdout: true,
      stderr: true,
    },
  );
  worker.stdout.pipe(process.stderr, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  let abort = () => {};
  try {
    return await new Promise<ResolvedVideoDefinition>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      worker.on(
        'message',
        (
          message:
            | { input: VideoInput }
            | { edge: ScriptImport }
            | { result: ResolvedVideoDefinition }
            | { error: string },
        ) => {
          if ('input' in message) {
            record?.(message.input);
          } else if ('edge' in message) trace?.(message.edge);
          else if ('error' in message)
            reject(new VideoDefinitionError(message.error));
          else resolve(message.result);
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
    signal?.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
