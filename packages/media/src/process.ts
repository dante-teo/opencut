import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

export class MediaError extends Error {
  override name = 'MediaError';
}

export async function localFile(file: string): Promise<string> {
  const path = resolve(file);
  try {
    if (!(await stat(path)).isFile()) throw new Error('Not a regular file');
    await access(path, constants.R_OK);
  } catch (error) {
    throw new MediaError(`Cannot read media file '${path}'.`, { cause: error });
  }
  return path;
}

// execFile passes arguments directly, without shell expansion. Bound both runtime
// and buffered output; close stdin so neither executable can wait for user input.
export function runMediaTool(
  tool: 'ffprobe' | 'ffmpeg',
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      tool,
      args,
      {
        encoding: 'buffer',
        shell: false,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && 'code' in error && error.code === 'ENOENT') {
          reject(
            new MediaError(
              `Required executable '${tool}' was not found on PATH. Install FFmpeg/ffprobe manually to use media commands.`,
              { cause: error },
            ),
          );
          return;
        }
        const diagnostics = stderr.toString('utf8').trim();
        if (error || diagnostics) {
          reject(
            new MediaError(
              `${tool} failed: ${diagnostics || error?.message || 'unknown execution failure'}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end();
  });
}
