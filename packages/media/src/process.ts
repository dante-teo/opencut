import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

export class MediaError extends Error {
  override name = 'MediaError';
}

export class RenderCancelledError extends MediaError {
  override name = 'RenderCancelledError';
  constructor() {
    super('Render cancelled.');
  }
}

export function checkRenderSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

export interface MediaToolControl {
  signal?: AbortSignal | undefined;
  onStdout?: (chunk: Buffer) => void;
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

export async function sourceFileStamp(path: string) {
  const info = await stat(path, { bigint: true });
  if (!info.isFile())
    throw new MediaError('Media source must be a regular file.');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

// execFile passes arguments directly, without shell expansion. Bound both runtime
// and buffered output; close stdin so neither executable can wait for user input.
export async function runMediaTool(
  tool: 'ffprobe' | 'ffmpeg',
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  timeoutMs = 60_000,
  control?: MediaToolControl,
): Promise<Buffer> {
  checkRenderSignal(control?.signal);
  return new Promise((resolve, reject) => {
    let closed = false;
    let callbackError: unknown;
    let callbackFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const stop = () => {
      if (closed || killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const child = execFile(
      tool,
      args,
      {
        encoding: 'buffer',
        shell: false,
        timeout: control ? 0 : timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        closed = true;
        clearTimeout(killTimer);
        clearTimeout(timeout);
        control?.signal?.removeEventListener('abort', stop);
        if (control?.signal?.aborted) {
          reject(new RenderCancelledError());
          return;
        }
        if (callbackFailed) {
          reject(callbackError);
          return;
        }
        if (timedOut) {
          reject(
            new MediaError(
              `${tool} timed out after ${timeoutMs} ms: ${stderr.toString('utf8').trim()}`,
            ),
          );
          return;
        }
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
    if (control && !closed) {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!control.onStdout || callbackFailed) return;
        try {
          control.onStdout(chunk);
        } catch (error) {
          callbackError = error;
          callbackFailed = true;
          stop();
        }
      });
      control.signal?.addEventListener('abort', stop, { once: true });
      // Covers cancellation between the initial check and listener registration.
      if (control.signal?.aborted) stop();
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
    }
  });
}
