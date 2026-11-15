import { readFile } from 'node:fs/promises';
import { UsageError } from './usage.js';

export async function readJsonArgument(
  flag: string,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(path, { encoding: 'utf8', signal }),
    ) as unknown;
  } catch (error) {
    signal.throwIfAborted();
    throw new UsageError(
      `--${flag}: Cannot read JSON file '${path}': ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function readParams(path: string | undefined, signal: AbortSignal) {
  return path === undefined
    ? undefined
    : readJsonArgument('params', path, signal);
}
