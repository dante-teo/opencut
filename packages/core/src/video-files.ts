import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { inspectAssetRecipes } from './video-assets.js';
import { compileDefinition } from './video-compiler.js';
import {
  definitionLoadError,
  parseVideoDefinition,
  VideoDefinitionError,
} from './video-definition.js';
import type { CompilationOptions, CompiledVideo } from './video-compiler.js';
import { identifyVideoInput } from './video-input.js';
import { readDefinitionScript } from './video-script.js';

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts') || file.endsWith('.video.json');
}

async function readDefinitionJson(path: string) {
  try {
    const json = await readFile(path, 'utf8');
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw definitionLoadError(path, cause);
  }
}

/** Compile a fresh definition using shared project rules and materialize referenced recipes. */
export function compileVideo(
  file: string,
  options: Pick<CompilationOptions, 'signal' | 'preview' | 'processing'> = {},
): Promise<CompiledVideo> {
  return compileVideoInput(file, options);
}

export async function compileVideoInput(
  file: string,
  options: CompilationOptions & {
    loadScript?: typeof readDefinitionScript;
  },
): Promise<CompiledVideo> {
  const { path, value } = await readVideoInput(file, options);
  return compileDefinition(path, value, options);
}

/** Validate recipe order and input streams without transcoding or writing a cache. */
export async function inspectVideoRecipes(
  file: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  const { path, value } = await readVideoInput(file, { signal });
  const { assets = {} } = parseVideoDefinition(value);
  const recipes = await inspectAssetRecipes(dirname(path), assets, signal);
  return { path, recipes };
}

async function readVideoInput(
  file: string,
  options: CompilationOptions & { loadScript?: typeof readDefinitionScript },
) {
  if (!isVideoDefinitionPath(file))
    throw new VideoDefinitionError('Expected a .video.ts or .video.json file.');
  options.signal?.throwIfAborted();
  const record = options.inputs?.record;
  const resolved = resolve(file);
  record?.(identifyVideoInput(resolved, 'source'));
  const path = await realpath(resolved).catch((cause: unknown) => {
    throw new VideoDefinitionError(
      `Cannot open video definition '${resolved}'.`,
      { cause },
    );
  });
  if (path !== resolved) record?.(identifyVideoInput(path, 'source'));
  // The selected filename determines how to load a symlink alias. Both loading
  // and media resolution use the same physical definition path.
  const value = file.endsWith('.video.json')
    ? await readDefinitionJson(path)
    : await (options.loadScript ?? readDefinitionScript)(path, record);
  return { path, value };
}
