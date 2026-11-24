import { createHash, randomUUID } from 'node:crypto';
import { SourceChangedError } from '@opencut/media';
import { findPackageJSON, isBuiltin, registerHooks } from 'node:module';
import { dirname, isAbsolute, relative, sep } from 'node:path';
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
import { identifyVideoInput, videoInputIdentity } from './video-input.js';
import type { RecordVideoInput, VideoInput } from './video-input.js';

export type ScriptImport = {
  parent: string;
  specifier: string;
  path?: string;
  unresolved?: boolean;
};

const sdk = '@opencut/sdk';

function isModuleNotFound(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  );
}

function isSdkAbsent(parentURL: string) {
  // Find the manifest independently of the exported entry point.
  try {
    return findPackageJSON(sdk, parentURL) === undefined;
  } catch (error) {
    return isModuleNotFound(error);
  }
}

function localPackageTarget(parentURL: string, target: string) {
  const manifest = findPackageJSON('.', parentURL);
  if (!manifest) return false;
  const fromPackage = relative(dirname(manifest), target);
  const parts = fromPackage.split(sep);
  return (
    !isAbsolute(fromPackage) &&
    parts[0] !== '..' &&
    !parts.includes('node_modules')
  );
}

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
  const loadedSources = new Map<string, VideoInput>();
  function checkSource(input: VideoInput) {
    const observed = videoInputIdentity(input.path);
    if (input.identity && observed !== input.identity)
      throw new SourceChangedError(
        input.path,
        'definition loading',
        input.identity,
        observed,
      );
  }
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
        // A global CLI or review app has its SDK beside the core, outside
        // the authored project's normal Node module search path.
        if (
          specifier === sdk &&
          isModuleNotFound(error) &&
          isSdkAbsent(parentURL)
        ) {
          resolved = nextResolve(sdk, {
            ...context,
            parentURL: import.meta.url,
          });
        } else {
          trace?.({
            parent: fileURLToPath(parentURL),
            specifier,
            unresolved: true,
          });
          throw error;
        }
      }
      const resolvedPath = resolved.url.startsWith('file:')
        ? fileURLToPath(resolved.url)
        : undefined;
      const isLocalFile =
        resolvedPath !== undefined &&
        (local ||
          (specifier.startsWith('#') &&
            localPackageTarget(parentURL, resolvedPath)));
      if (trace && !isBuiltin(specifier))
        trace({
          parent: fileURLToPath(parentURL),
          specifier,
          ...(isLocalFile && { path: resolvedPath }),
        });
      if (!isLocalFile) return resolved;
      const dependency = new URL(resolved.url);
      dependency.searchParams.set(parameter, build);
      return { ...resolved, url: dependency.href };
    },
    load(url, context, nextLoad) {
      if (
        url.startsWith('file:') &&
        new URL(url).searchParams.get(parameter) === build
      ) {
        const path = fileURLToPath(url);
        const input = identifyVideoInput(path, 'source');
        loadedSources.set(path, input);
        let result: ReturnType<typeof nextLoad>;
        try {
          result = nextLoad(url, context);
        } finally {
          checkSource(input);
        }
        // Node's TypeScript loader returns the source bytes before stripping types.
        if (input.identity && ArrayBuffer.isView(result.source)) {
          const bytes = Buffer.from(
            result.source.buffer,
            result.source.byteOffset,
            result.source.byteLength,
          );
          input.fingerprint = {
            identity: input.identity,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        }
        record?.(input);
        return result;
      }
      return nextLoad(url, context);
    },
  });
  try {
    // An async default export can still import helpers after module evaluation.
    const value: unknown = await (await import(url.href)).default;
    const result = await resolveVideoDefinition(value, params);
    for (const input of loadedSources.values()) checkSource(input);
    return result;
  } catch (cause) {
    if (cause instanceof SourceChangedError)
      await cause.compareContent(
        loadedSources.get(cause.change.path)?.fingerprint,
      );
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
            | { error: string; sourceChange?: SourceChangedError['change'] },
        ) => {
          if ('input' in message) {
            record?.(message.input);
          } else if ('edge' in message) trace?.(message.edge);
          else if ('error' in message) {
            const change = message.sourceChange;
            const cause =
              change &&
              new SourceChangedError(
                change.path,
                change.stage,
                change.before,
                change.after,
              );
            if (cause) Object.assign(cause.change, change);
            reject(new VideoDefinitionError(message.error, { cause }));
          } else resolve(message.result);
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
