import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compileDefinition,
  definitionLoadError,
  VideoDefinitionError,
} from './video-compiler.js';
import type { CompiledVideo } from './video-compiler.js';
import { canonicalProjectFilePath } from './project-files.js';
import { deserializeProject } from './project.js';

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts') || file.endsWith('.video.json');
}

async function readDefinitionScript(path: string): Promise<unknown> {
  // Node keys ESM modules by URL. Pass the build ID along each local import
  // edge, including dynamic imports, while leaving package imports alone.
  const build = randomUUID();
  const parameter = 'opencut-build';
  const url = pathToFileURL(path);
  url.searchParams.set(parameter, build);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const { parentURL } = context;
      if (
        !parentURL?.startsWith('file:') ||
        new URL(parentURL).searchParams.get(parameter) !== build ||
        !resolved.url.startsWith('file:') ||
        !/^(?:\.{1,2}\/|\/|file:)/.test(specifier)
      )
        return resolved;
      const dependency = new URL(resolved.url);
      dependency.searchParams.set(parameter, build);
      return { ...resolved, url: dependency.href };
    },
  });
  try {
    return (await import(url.href)).default as unknown;
  } catch (cause) {
    throw definitionLoadError(path, cause);
  } finally {
    hooks.deregister();
  }
}

async function readDefinitionJson(path: string) {
  try {
    const json = await readFile(path, 'utf8');
    return { json, value: JSON.parse(json) as unknown };
  } catch (cause) {
    throw definitionLoadError(path, cause);
  }
}

/** Compile a fresh definition using shared project rules and metadata-only probes. */
export async function compileVideo(
  file: string,
  options: { signal?: AbortSignal | undefined; preview?: boolean } = {},
): Promise<CompiledVideo> {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts or .video.json file.');
  options.signal?.throwIfAborted();
  const resolved = resolve(file);
  const path = await realpath(resolved).catch((cause: unknown) => {
    throw new VideoDefinitionError(
      `Cannot open video definition '${resolved}'.`,
      { cause },
    );
  });
  // The selected filename determines how to load a symlink alias. Both loading
  // and media resolution use the same physical definition path.
  const value = file.endsWith('.video.json')
    ? (await readDefinitionJson(path)).value
    : await readDefinitionScript(path);
  return compileDefinition(path, value, options);
}

/** A .video.json filename can also belong to a saved project. Read it once. */
export async function readVideoJsonForPreview(
  file: string,
  signal: AbortSignal,
) {
  const path = await canonicalProjectFilePath(resolve(file));
  const { json, value } = await readDefinitionJson(path);
  if (
    value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'schemaVersion')
  )
    return { path, project: deserializeProject(json) };
  return compileDefinition(await realpath(path), value, {
    signal,
    preview: true,
  });
}
