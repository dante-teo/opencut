import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, release, version } from 'node:os';
import { MediaError, checkRenderSignal, runMediaTool } from './process.js';

export interface RecipeProcessLimits {
  maxTemporaryBytes: number;
  maxNativeBytes: number;
  maxBufferedFrames: number;
  maxPixels: number;
  timeoutMs: number;
}

const progress = ['-progress', 'pipe:1', '-stats_period', '0.25'];

type NativeRecipePipeline = {
  label: string;
  timingPipe: string;
  decoder: string[];
  worker: { executable: string; args: string[] };
  encoder: string[];
};

function ffmpegLimits(limits: RecipeProcessLimits) {
  return [
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
    '-threads',
    '1',
    '-max_pixels',
    String(limits.maxPixels),
  ];
}

export async function runRecipeProcess(
  invocation: string[] | NativeRecipePipeline,
  limits: RecipeProcessLimits,
  signal: AbortSignal,
  onTime: (seconds: number) => void,
) {
  checkRenderSignal(signal);
  const pipeline = !Array.isArray(invocation);
  if (
    !pipeline &&
    process.platform !== 'darwin' &&
    process.platform !== 'linux'
  )
    throw new MediaError('Bounded recipe processing requires macOS or Linux.');
  const ffmpeg = ffmpegLimits(limits);
  let command = 'exec ffmpeg "$@" </dev/null 3<&-';
  let args: string[];
  if (pipeline) {
    const { timingPipe, decoder, worker, encoder } = invocation;
    const decode = [...ffmpeg, ...decoder];
    // Pair the raw stream with one timing record per frame. The shell opens
    // the metadata pipe before exec so a decoder startup failure closes it.
    command = `
      set -o pipefail
      fifo=$1
      worker=$2
      nativeCount=$3
      decodeCount=$4
      shift 4
      native=("\${@:1:nativeCount}")
      shift "$nativeCount"
      decode=("\${@:1:decodeCount}")
      shift "$decodeCount"
      mkfifo "$fifo" || exit 1
      trap 'rm -f "$fifo"' EXIT
      ffmpeg "\${decode[@]}" </dev/null 3>"$fifo" |
        OS_ACTIVITY_MODE=disable "$worker" "\${native[@]}" 3<"$fifo" |
        ffmpeg "$@" 3<&-
    `;
    args = [
      timingPipe,
      worker.executable,
      String(worker.args.length),
      String(decode.length),
      ...worker.args,
      ...decode,
      ...ffmpeg,
      ...progress,
      ...encoder,
    ];
  } else {
    args = [...ffmpeg, ...progress, ...invocation];
  }
  // The caller holds stdin open. EOF kills the group even after a caller SIGKILL.
  const launch = `
    ulimit -f "$1" || exit 125
    shift
    exec 3<&0
    ( IFS= read -r _ <&3; kill -KILL "-$$" ) >/dev/null 2>&1 &
    ${command}
  `;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      pipeline ? '/bin/bash' : '/bin/sh',
      [
        '-c',
        launch,
        'opencut-recipe',
        String(Math.floor(limits.maxTemporaryBytes / 1024)),
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
        pipeline
          ? ['-axo', 'pgid=,rss=']
          : ['-o', 'rss=', '-p', String(child.pid)],
        { timeout: 1000, maxBuffer: pipeline ? 1024 * 1024 : 1024 },
        (error, stdout) => {
          sampling = false;
          if (
            !closed &&
            !error &&
            recipeMemory(stdout, pipeline ? child.pid : undefined) >
              limits.maxNativeBytes
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
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(error);
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
      else if (
        sig === 'SIGXFSZ' ||
        /File too large|File ?size limit exceeded/i.test(diagnostic)
      )
        reject(
          new MediaError('Recipe step exceeded its temporary file limit.'),
        );
      else if (code !== 0 || (!pipeline && diagnostic))
        reject(
          new MediaError(
            `${pipeline ? invocation.label : 'FFmpeg recipe step'} failed: ${diagnostic.trim() || sig || code}`,
          ),
        );
      else resolve();
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function recipeMemory(output: string, group: number | undefined) {
  if (group === undefined) return Number(output.trim()) * 1024;
  let kib = 0;
  for (const line of output.trim().split('\n')) {
    const [pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pgid === group) kib += rss ?? 0;
  }
  return kib * 1024;
}

export async function nativeRecipeFingerprint(
  worker: string,
  backendVersion: string,
  effect: string,
  signal: AbortSignal,
) {
  const bytes = await readFile(worker, { signal }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new MediaError(
      `The VideoToolbox ${effect} worker is missing. Build @opencut/media with a macOS 26+ SDK.`,
      { cause },
    );
  });
  return [
    backendVersion,
    cpus()[0]?.model ?? process.arch,
    release(),
    version(),
    createHash('sha256').update(bytes).digest('hex'),
  ];
}

export async function recipeBackendVersion(signal: AbortSignal) {
  const versions = await Promise.all([
    runMediaTool('ffmpeg', ['-version'], undefined, undefined, { signal }),
    runMediaTool('ffprobe', ['-version'], undefined, undefined, { signal }),
  ]);
  return versions.join('\0');
}
