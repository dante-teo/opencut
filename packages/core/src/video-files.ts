import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  compileDefinition,
  definitionLoadError,
  VideoDefinitionError,
} from './video-compiler.js';
import type { CompilationOptions, CompiledVideo } from './video-compiler.js';
import { canonicalProjectFilePath } from './project-files.js';
import { deserializeProject } from './project.js';
import { identifyVideoInput } from './video-input.js';
import { readDefinitionScript } from './video-script.js';

export function isVideoDefinitionPath(file: string) {
  return file.endsWith('.video.ts') || file.endsWith('.video.json');
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
export function compileVideo(
  file: string,
  options: Pick<CompilationOptions, 'signal' | 'preview'> = {},
): Promise<CompiledVideo> {
  return compileVideoInput(file, options);
}

export async function compileVideoInput(
  file: string,
  options: CompilationOptions & {
    loadScript?: typeof readDefinitionScript;
  },
): Promise<CompiledVideo> {
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
    ? (await readDefinitionJson(path)).value
    : await (options.loadScript ?? readDefinitionScript)(path, record);
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
