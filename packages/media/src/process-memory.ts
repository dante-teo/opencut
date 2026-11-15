import { execFile } from 'node:child_process';
import { MediaError } from './process.js';

export function sampleProcessMemory(
  args: string[],
  maxBuffer: number,
  result: (failure: MediaError | null, output: string) => void,
) {
  const failed = (cause: unknown) =>
    new MediaError(
      `Cannot sample native memory with /bin/ps: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  try {
    execFile(
      '/bin/ps',
      args,
      { timeout: 1000, maxBuffer },
      (error, stdout, stderr) => {
        // ps exits with status 1 and no diagnostic if the requested PIDs are gone.
        if (error && (error.code !== 1 || stderr.trim()))
          result(failed(error), '');
        else result(null, stdout);
      },
    );
  } catch (cause) {
    result(failed(cause), '');
  }
}
