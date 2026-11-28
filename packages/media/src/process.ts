import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { renderToolCommand, trackRenderProcess } from './render-budget.js';

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
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: Buffer) => void;
  writesFile?: boolean;
  videoToolboxEncoder?: boolean;
  onDiagnostics?: (diagnostics: string) => void;
  onNonfatalDiagnostic?: (diagnostic: string) => void;
  stage?: string;
}

const missingChapterTrack = 'Referenced QT chapter track not found';
const chapterDiagnostic =
  /^(?:\[[^\]\r\n]+\]\s*)?Referenced QT chapter track not found$/;

export function onlyMissingChapterDiagnostic(diagnostics: string) {
  return (
    !!diagnostics &&
    diagnostics
      .split(/\r?\n/)
      .every((line) => chapterDiagnostic.test(line.trim()))
  );
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

export function fileIdentity(info: BigIntStats) {
  return info.isFile()
    ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    : null;
}

export async function sourceFileStamp(path: string) {
  const identity = fileIdentity(await stat(path, { bigint: true }));
  if (!identity) throw new MediaError('Media source must be a regular file.');
  return identity;
}

// execFile passes arguments directly, without shell expansion. Bound both runtime
// and buffered output, and close stdin so tools cannot wait for user input.
export async function runMediaTool(
  tool: string,
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
  timeoutMs = 60_000,
  control?: MediaToolControl,
): Promise<Buffer> {
  checkRenderSignal(control?.signal);
  const command = renderToolCommand(tool, args, control?.writesFile);
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
    let untrack = () => {};
    const child = execFile(
      command.tool,
      command.args,
      {
        encoding: 'buffer',
        shell: false,
        timeout: control ? 0 : timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer,
        windowsHide: true,
        ...(control?.env && { env: control.env }),
      },
      (error, stdout, stderr) => {
        closed = true;
        untrack();
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
              `Required executable '${tool}' was not found on PATH.` +
                (tool === 'ffmpeg' || tool === 'ffprobe'
                  ? ' Install FFmpeg/ffprobe manually to use media commands.'
                  : ''),
              { cause: error },
            ),
          );
          return;
        }
        const diagnostics = stderr.toString('utf8').trim();
        if (
          error &&
          (error.signal === 'SIGXFSZ' || /File too large/i.test(diagnostics))
        ) {
          reject(
            new MediaError('Render exceeded its temporary disk budget.', {
              cause: error,
            }),
          );
          return;
        }
        // The guest scaler can log a failed lookup even when its hardware
        // encoder succeeds. Keep all other diagnostics and nonzero exits fatal.
        const remainingDiagnostics =
          tool === 'ffmpeg' && control?.videoToolboxEncoder
            ? diagnostics
                .split(/\r?\n/)
                .filter(
                  (line) =>
                    line.trim() !==
                    'IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver',
                )
                .join('\n')
                .trim()
            : diagnostics;
        const missingChapters =
          (tool === 'ffprobe' || tool === 'ffmpeg') &&
          onlyMissingChapterDiagnostic(remainingDiagnostics);
        if (
          error ||
          (remainingDiagnostics && !missingChapters && !control?.onDiagnostics)
        ) {
          const stage = control?.stage ? ` while ${control.stage}` : '';
          const status = error?.signal
            ? `signal ${error.signal}`
            : typeof error?.code === 'number'
              ? `exit status ${error.code}`
              : error
                ? 'execution error'
                : 'exit status 0 with unexpected diagnostics';
          reject(
            new MediaError(
              `${tool} failed${stage} (${status}): ${diagnostics.slice(-4096) || (typeof error?.code === 'number' ? 'no diagnostic output' : error?.message) || 'unknown execution failure'}`,
              { cause: error },
            ),
          );
          return;
        }
        try {
          if (missingChapters)
            control?.onNonfatalDiagnostic?.(missingChapterTrack);
          control?.onDiagnostics?.(diagnostics);
          resolve(stdout);
        } catch (cause) {
          reject(cause);
        }
      },
    );
    if (!closed)
      untrack = trackRenderProcess(child.pid, (error) => {
        callbackError = error;
        callbackFailed = true;
        stop();
      });
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
