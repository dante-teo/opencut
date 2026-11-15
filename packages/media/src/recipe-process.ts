import { execFile, spawn } from 'node:child_process';
import { MediaError, checkRenderSignal, runMediaTool } from './process.js';

export interface RecipeProcessLimits {
  maxTemporaryBytes: number;
  maxNativeBytes: number;
  maxBufferedFrames: number;
  maxPixels: number;
  timeoutMs: number;
}

export async function runRecipeProcess(
  args: string[],
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onTime: (seconds: number) => void,
) {
  checkRenderSignal(signal);
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new MediaError('Bounded recipe processing requires macOS or Linux.');

  // Use KiB for the shell limit. Some Linux shells use 512-byte units,
  // so the kernel cap can be stricter there. FFmpeg writes one file.
  const blocks = Math.floor(limits.maxTemporaryBytes / 1024);
  // A dedicated stdin pipe stays open while the caller owns this process.
  // EOF also reaches the guard after SIGKILL, when the caller cannot clean up.
  const launch = `
    ulimit -f "$1" || exit 125
    shift
    exec 3<&0
    ( IFS= read -r _ <&3; kill -KILL "-$$" ) >/dev/null 2>&1 &
    exec ffmpeg "$@" </dev/null 3<&-
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        launch,
        'opencut-recipe',
        String(blocks),
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-max_alloc',
        String(Math.min(limits.maxNativeBytes, 2_147_483_647)),
        '-filter_threads',
        '1',
        '-filter_complex_threads',
        '1',
        '-filter_buffered_frames',
        String(limits.maxBufferedFrames),
        '-progress',
        'pipe:1',
        '-stats_period',
        '0.25',
        '-threads',
        '1',
        '-max_pixels',
        String(limits.maxPixels),
        ...args,
      ],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let diagnostic = '';
    let pending = '';
    let failure: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    let sampling = false;
    let closed = false;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ESRCH'
        ))
          failure ??= error;
      }
    };
    const stop = (cause: unknown) => {
      failure ??= cause;
      if (closed || killTimer) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
    };
    const cancel = () => stop(signal.reason);
    const timeout = setTimeout(
      () => stop(new MediaError('Recipe step exceeded its time limit.')),
      limits.timeoutMs,
    );
    const monitor = setInterval(() => {
      if (sampling || child.pid === undefined) return;
      sampling = true;
      execFile(
        '/bin/ps',
        ['-o', 'rss=', '-p', String(child.pid)],
        { timeout: 1000, maxBuffer: 1024 },
        (error, stdout) => {
          sampling = false;
          if (
            !closed &&
            !error &&
            Number(stdout.trim()) * 1024 > limits.maxNativeBytes
          )
            stop(
              new MediaError('Recipe step exceeded its native memory limit.'),
            );
        },
      );
    }, 50);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      const lines = (pending + chunk.toString('utf8')).split('\n');
      pending = lines.pop()!.slice(-1024);
      try {
        for (const line of lines) {
          const time = /^out_time_us=(\d+)/.exec(line);
          if (time) onTime(Number(time[1]) / 1_000_000);
        }
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192);
    });
    child.once('exit', () => child.stdin.destroy());
    child.on('error', (error) => {
      failure ??= error;
    });
    child.on('close', (code, sig) => {
      closed = true;
      clearTimeout(timeout);
      clearInterval(monitor);
      if (killTimer) kill('SIGKILL');
      clearTimeout(killTimer);
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (sig === 'SIGXFSZ' || /File too large/i.test(diagnostic))
        reject(
          new MediaError('Recipe step exceeded its temporary file limit.'),
        );
      else if (code !== 0 || diagnostic)
        reject(
          new MediaError(
            `FFmpeg recipe step failed: ${diagnostic.trim() || sig || code}`,
          ),
        );
      else resolve();
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export async function recipeBackendVersion(signal: AbortSignal) {
  const versions = await Promise.all([
    runMediaTool('ffmpeg', ['-version'], undefined, undefined, { signal }),
    runMediaTool('ffprobe', ['-version'], undefined, undefined, { signal }),
  ]);
  return versions.join('\0');
}
