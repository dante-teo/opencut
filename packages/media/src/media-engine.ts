import { spawn } from 'node:child_process';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { inspectNativeExecutable } from './native-executable.js';
import {
  checkRenderSignal,
  MediaError,
  onlyMissingChapterDiagnostic,
} from './process.js';
import { renderAllocationLimit, trackRenderProcess } from './render-budget.js';

const protocol = 1;
const executable = new URL('../dist/opencut-media-engine', import.meta.url);
const reinstall = 'Reinstall OpenCut or rebuild @opencut/media with Cargo.';
const maxAudioBytes = 64 * 1024 * 1024;

type Job =
  | {
      kind: 'graphicAudio';
      path: string;
      samples: number;
      window: number;
      hop: number;
      waveform: number;
      bins: number;
    }
  | { kind: 'frameIndex'; path: string; stream: number }
  | { kind: 'countVideo'; path: string };

export async function inspectMediaEngine() {
  const helper = await inspectNativeExecutable(executable, protocol);
  return helper.status === 'available'
    ? helper
    : {
        ...helper,
        hint: `OpenCut media engine: ${helper.status}. ${reinstall}`,
      };
}

async function runMediaJob(
  job: Job,
  stage: string,
  maxBytes: number,
  signal?: AbortSignal,
  destination?: Buffer,
): Promise<Buffer> {
  checkRenderSignal(signal);
  const request = {
    protocol,
    release: manifest.version,
    maxAllocationBytes: renderAllocationLimit(),
    job,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      fileURLToPath(executable),
      ['--job', JSON.stringify(request)],
      { detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let failure: Error | undefined;
    let closed = false;
    let diagnostics = '';
    let received = 0;
    const chunks: Buffer[] = [];
    function stop(error?: Error) {
      failure ??= error;
      if (closed || child.pid === undefined) return;
      try {
        // The worker and its codec subprocess share a private group.
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') {
          failure ??= new MediaError('Cannot stop the native media job.', {
            cause,
          });
          child.kill('SIGKILL');
        }
      }
    }
    const cancel = () => stop();
    const untrack = trackRenderProcess(child.pid, stop, true);
    const timeout = setTimeout(
      () =>
        stop(new MediaError(`OpenCut media engine timed out while ${stage}.`)),
      600_000,
    );
    child.on('error', (cause: NodeJS.ErrnoException) => {
      failure ??= new MediaError(
        `Cannot run the OpenCut media engine while ${stage}. ${reinstall}`,
        { cause },
      );
    });
    child.once('exit', (code) => {
      // A crashed worker can leave its codec holding stderr open. Stop the
      // group on exit so close still runs and releases the render budget.
      if (code !== 0) stop();
    });
    child.stderr.setEncoding('utf8').on('data', (part: string) => {
      diagnostics = (diagnostics + part).slice(-8192);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure || signal?.aborted) return;
      if (received + chunk.length > maxBytes) {
        stop(
          new MediaError(
            `OpenCut media engine exceeded its response limit while ${stage}.`,
          ),
        );
        return;
      }
      if (destination) chunk.copy(destination, received);
      else chunks.push(chunk);
      received += chunk.length;
    });
    // Keep an idle owner pipe open. After a crash its EOF stops the whole job.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    child.once('close', (code, killedBy) => {
      closed = true;
      clearTimeout(timeout);
      untrack();
      child.stdin.destroy();
      signal?.removeEventListener('abort', cancel);
      try {
        checkRenderSignal(signal);
        if (failure) throw failure;
        const details = diagnostics.trim();
        if (code !== 0 || (details && !onlyMissingChapterDiagnostic(details)))
          throw new MediaError(
            `OpenCut media engine failed while ${stage}: ${details || killedBy || `exit status ${code}`}`,
          );
        resolve(
          destination !== undefined
            ? destination.subarray(0, received)
            : Buffer.concat(chunks, received),
        );
      } catch (error) {
        reject(error);
      }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function analyzeGraphicAudio(
  path: string,
  samples: number,
  {
    window,
    hop,
    waveform,
    bins,
  }: {
    window: number;
    hop: number;
    waveform: number;
    bins: number;
  },
  signal?: AbortSignal,
) {
  const count = Math.ceil(samples / hop) + 1;
  const length = count * (1 + waveform + bins);
  if (length * 4 > maxAudioBytes)
    throw new MediaError(
      'Audio analysis exceeds 64 MiB. Increase hop or reduce output features.',
    );
  // An owned, aligned buffer binds the response to this one analysis. A failed
  // job never returns a partial view or makes it available to the cache.
  const output = Buffer.allocUnsafeSlow(4 + length * 4);
  const result = await runMediaJob(
    { kind: 'graphicAudio', path, samples, window, hop, waveform, bins },
    `analyzing graphics audio '${path}'`,
    output.length,
    signal,
    output,
  );
  if (result.length !== output.length || result.readUInt32LE() !== count)
    throw new MediaError(
      'OpenCut media engine returned an incomplete audio analysis.',
    );
  if (endianness() === 'BE') result.subarray(4).swap32();
  const features = new Float32Array(
    result.buffer,
    result.byteOffset + 4,
    length,
  );
  return { count, features };
}

export async function indexDecodedVideo(
  path: string,
  stream: number,
  signal?: AbortSignal,
) {
  const result = await runMediaJob(
    { kind: 'frameIndex', path, stream },
    `indexing decoded MP4 frames in '${path}'`,
    32 * 1024 * 1024,
    signal,
  );
  if (result.length < 32 || (result.length - 8) % 24 !== 0)
    throw new MediaError(
      'OpenCut media engine returned an incomplete frame index.',
    );
  const firstPts = Number(result.readBigInt64LE());
  function optionalTick(offset: number) {
    const value = result.readBigInt64LE(offset);
    return value === -(1n << 63n) ? undefined : Number(value);
  }
  const ticks: number[] = [];
  const frameClock: {
    pts: number | undefined;
    duration: number | undefined;
  }[] = [];
  for (let offset = 8; offset < result.length; offset += 24) {
    frameClock.push({
      pts: optionalTick(offset),
      duration: optionalTick(offset + 8),
    });
    ticks.push(Number(result.readBigInt64LE(offset + 16)));
  }
  return { firstPts, ticks, frameClock };
}

export async function countDecodedVideo(path: string, signal?: AbortSignal) {
  const result = await runMediaJob(
    { kind: 'countVideo', path },
    `counting decoded frames in '${path}'`,
    8,
    signal,
  );
  if (!result.length) return undefined;
  if (result.length !== 8)
    throw new MediaError(
      'OpenCut media engine returned an incomplete frame count.',
    );
  return Number(result.readBigUInt64LE());
}
