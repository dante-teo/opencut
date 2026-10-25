import type { PreviewMetrics } from '../bridge.js';
import type { FrameRate } from '@opencut/core';

/** Non-drop timecode: nominal frame labels at the project rate, not source frame IDs. */
export function previewTimecode(seconds: number, rate: FrameRate): string {
  const fps = rate.numerator / rate.denominator;
  const frame = Math.max(0, Math.floor(seconds * fps + 0.000001));
  const base = Math.max(1, Math.round(fps));
  const fields = [
    Math.floor(frame / (base * 3600)),
    Math.floor(frame / (base * 60)) % 60,
    Math.floor(frame / base) % 60,
    frame % base,
  ];
  return fields.map((field) => String(field).padStart(2, '0')).join(':');
}

// Presentation time is observed; a frame index derived from average FPS is nominal.
export function frameAt(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
}

export function lastFrameIndex(duration: number, fps: number): number {
  // ffprobe rounds durations to microseconds; avoid a phantom final CFR frame.
  return Math.max(0, Math.ceil(duration * fps - 0.0001) - 1);
}

export function frameTarget(
  frame: number,
  fps: number,
  duration: number,
): number {
  const last = lastFrameIndex(duration, fps);
  return Math.min(
    duration - 0.000001,
    (Math.max(0, Math.min(last, frame)) + 0.5) / fps,
  );
}

export function distribution(values: number[]): {
  median: number;
  p95: number;
} {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw new Error('Expected finite measurement samples.');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

export interface SeekSample {
  targetSeconds: number;
  presentedSeconds: number;
  seekedMs: number;
  presentedMs: number;
}

// Resolve only after BOTH seek completion and a new compositor frame callback.
// Never use fastSeek: it may intentionally select a nearby keyframe.
export function seekPresented(
  video: HTMLVideoElement,
  target: number,
  signal?: AbortSignal,
): Promise<SeekSample> {
  signal?.throwIfAborted();
  video.pause();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let seekedMs: number | null = null;
    let presentedMs: number | null = null;
    let presentedSeconds = 0;
    let callback = 0;
    const cleanup = () => {
      clearTimeout(timeout);
      video.cancelVideoFrameCallback(callback);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      video.removeEventListener('emptied', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (seekedMs === null || presentedMs === null) return;
      cleanup();
      resolve({
        targetSeconds: target,
        presentedSeconds,
        seekedMs,
        presentedMs,
      });
    };
    const onSeeked = () => {
      seekedMs = performance.now() - started;
      finish();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Video changed or could not be decoded during seek.'));
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'No presented frame within 5 seconds. Keep the preview visible and use supported video.',
        ),
      );
    }, 5000);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.addEventListener('emptied', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    callback = video.requestVideoFrameCallback((_now, metadata) => {
      presentedMs = performance.now() - started;
      presentedSeconds = metadata.mediaTime;
      finish();
    });
    try {
      video.currentTime = target;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export interface PreviewBenchmark {
  schemaVersion: 1;
  userAgent: string;
  frameRate: number | null;
  durationSeconds: number;
  warmupSeeks: number;
  seek: {
    count: number;
    seekedMs: ReturnType<typeof distribution>;
    presentedMs: ReturnType<typeof distribution>;
    nominalFrameMismatches: number | null;
    samples: SeekSample[];
  };
  playback: {
    wallSeconds: number;
    mediaSeconds: number;
    totalFrames: number;
    droppedFrames: number;
    droppedPercent: number;
    callbacks: number;
    callbackGapMs: ReturnType<typeof distribution> | null;
    gapsOverTwoFrames: number | null;
    waitingEvents: number;
    stalledEvents: number;
  };
  resources: {
    samples: PreviewMetrics[];
    cpuPercent: ReturnType<typeof distribution> | null;
    workingSetMiB: ReturnType<typeof distribution> | null;
  };
}

export async function benchmarkPreview(
  video: HTMLVideoElement,
  fps: number | null,
  metrics: () => Promise<PreviewMetrics>,
  signal?: AbortSignal,
): Promise<PreviewBenchmark> {
  signal?.throwIfAborted();
  if (
    document.visibilityState !== 'visible' ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0
  )
    throw new Error(
      'Load a finite-duration video and keep the window visible.',
    );
  const duration = video.duration;
  const targetFor = (index: number) => {
    // Fixed alternating long/short jumps; no random seed or filesystem-cache claims.
    const fraction = (((index * 17 + 7) % 31) + 0.5) / 32;
    return fps
      ? frameTarget(Math.floor(fraction * duration * fps), fps, duration)
      : fraction * duration;
  };
  // Establish a distinct starting frame even when validation follows an interactive seek.
  await seekPresented(
    video,
    video.currentTime < duration / 2 ? duration * 0.9 : duration * 0.1,
    signal,
  );
  for (let i = 0; i < 3; i++) await seekPresented(video, targetFor(i), signal);
  const samples: SeekSample[] = [];
  for (let i = 0; i < 30; i++)
    samples.push(await seekPresented(video, targetFor(i + 3), signal));
  await seekPresented(
    video,
    fps ? frameTarget(0, fps, duration) : 0.001,
    signal,
  );
  const baseline = video.getVideoPlaybackQuality();
  const mediaStart = video.currentTime;
  const resources: PreviewMetrics[] = [];
  let waitingEvents = 0;
  let stalledEvents = 0;
  const waiting = () => {
    waitingEvents++;
  };
  const stalled = () => {
    stalledEvents++;
  };
  // Prime delta CPU counters before installing observers that need cleanup.
  await metrics();
  signal?.throwIfAborted();
  video.addEventListener('waiting', waiting);
  video.addEventListener('stalled', stalled);
  const callbackTimes: number[] = [];
  let callback = 0;
  const observe: VideoFrameRequestCallback = (now) => {
    callbackTimes.push(now);
    callback = video.requestVideoFrameCallback(observe);
  };
  callback = video.requestVideoFrameCallback(observe);
  video.playbackRate = 1;
  const started = performance.now();
  try {
    await video.play();
    const playUntil = Math.min(duration, mediaStart + 8);
    while (!video.ended && video.currentTime < playUntil) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          video.removeEventListener('ended', complete);
          signal?.removeEventListener('abort', abort);
        };
        const complete = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason);
        };
        const timer = setTimeout(
          complete,
          Math.min(500, Math.max(1, (playUntil - video.currentTime) * 1000)),
        );
        video.addEventListener('ended', complete, { once: true });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      if (document.visibilityState !== 'visible')
        throw new Error('Benchmark window became hidden.');
      if (video.error) throw new Error('Playback decoding failed.');
      if (performance.now() - started > 15000)
        throw new Error('Playback did not advance within 15 seconds.');
      resources.push(await metrics());
      signal?.throwIfAborted();
    }
  } finally {
    video.pause();
    video.cancelVideoFrameCallback(callback);
    video.removeEventListener('waiting', waiting);
    video.removeEventListener('stalled', stalled);
  }
  const quality = video.getVideoPlaybackQuality();
  const totalFrames = quality.totalVideoFrames - baseline.totalVideoFrames;
  const droppedFrames =
    quality.droppedVideoFrames - baseline.droppedVideoFrames;
  const gaps = callbackTimes
    .slice(1)
    .map((time, i) => time - callbackTimes[i]!);
  return {
    schemaVersion: 1,
    userAgent: navigator.userAgent,
    frameRate: fps,
    durationSeconds: duration,
    warmupSeeks: 3,
    seek: {
      count: samples.length,
      seekedMs: distribution(samples.map((sample) => sample.seekedMs)),
      presentedMs: distribution(samples.map((sample) => sample.presentedMs)),
      nominalFrameMismatches: fps
        ? samples.filter(
            (sample) =>
              frameAt(sample.presentedSeconds, fps) !==
              Math.floor(sample.targetSeconds * fps),
          ).length
        : null,
      samples,
    },
    playback: {
      wallSeconds: (performance.now() - started) / 1000,
      mediaSeconds: video.currentTime - mediaStart,
      totalFrames,
      droppedFrames,
      droppedPercent: totalFrames ? (droppedFrames / totalFrames) * 100 : 0,
      callbacks: callbackTimes.length,
      callbackGapMs: gaps.length ? distribution(gaps) : null,
      gapsOverTwoFrames: fps
        ? gaps.filter((gap) => gap > 2000 / fps + 2).length
        : null,
      waitingEvents,
      stalledEvents,
    },
    resources: {
      samples: resources,
      cpuPercent: resources.length
        ? distribution(resources.map((sample) => sample.cpuPercent))
        : null,
      workingSetMiB: resources.length
        ? distribution(resources.map((sample) => sample.workingSetMiB))
        : null,
    },
  };
}
