import { performance } from 'node:perf_hooks';

export interface RenderProgress {
  event: 'progress';
  phase: 'rendering' | 'verifying';
  stage?:
    | 'preparation'
    | 'graphics'
    | 'composition'
    | 'audio-analysis'
    | 'audio-mastering'
    | 'encoding'
    | 'encoding-complete'
    | 'ready'
    | 'muxing'
    | 'verification'
    | 'review-labels';
  clipId?: string;
  detail?: 'browser-capture' | 'intermediate-writing' | 'graphic-rasterization';
  cacheHits?: number;
  percent: number;
  processedFrames: number;
  totalFrames: number;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  /** Stage throughput estimate, when available. */
  estimateScope?: 'stage';
  /** Active wall-clock time across the export and time since meaningful progress. */
  exportElapsedSeconds?: number;
  idleSeconds?: number;
  heartbeat?: true;
  indeterminate?: true;
}

type ProgressReporter = (event: RenderProgress) => void;
const trackedCallbacks = new WeakSet<ProgressReporter>();

/** Use the outermost render entry point's clock through every nested stage. */
export async function withExportProgress<T>(
  onProgress: ProgressReporter | undefined,
  run: (report: ProgressReporter | undefined) => Promise<T>,
) {
  if (!onProgress || trackedCallbacks.has(onProgress)) return run(onProgress);
  const notify = onProgress;
  const started = performance.now();
  let lastVisible = started;
  let lastEvent = started;
  let current: RenderProgress | undefined;
  function emit(event: RenderProgress, now: number) {
    lastEvent = now;
    notify({
      ...event,
      exportElapsedSeconds: (now - started) / 1000,
      idleSeconds: (now - lastVisible) / 1000,
    });
  }
  const timer = setInterval(() => {
    const now = performance.now();
    if (current && now - lastEvent >= 4000)
      emit({ ...current, heartbeat: true }, now);
  }, 5000);
  timer.unref();
  function report(event: RenderProgress) {
    const now = performance.now();
    if (
      !current ||
      current.stage !== event.stage ||
      current.phase !== event.phase ||
      current.clipId !== event.clipId ||
      current.detail !== event.detail ||
      current.processedFrames !== event.processedFrames
    )
      lastVisible = now;
    current = event;
    emit(event, now);
  }
  trackedCallbacks.add(report);
  try {
    renderProgress(1, report, {
      stage: 'preparation',
      indeterminate: true,
    }).start();
    return await run(report);
  } finally {
    clearInterval(timer);
    trackedCallbacks.delete(report);
  }
}

/** FFmpeg -progress records end with progress=continue/end, independent of chunks. */
export function renderProgress(
  totalFrames: number,
  onProgress?: (progress: RenderProgress) => void,
  details?: Pick<
    RenderProgress,
    'stage' | 'clipId' | 'detail' | 'indeterminate'
  >,
  cacheHits?: () => number,
) {
  let started: number | undefined;
  let pending = '';
  let frames = 0;
  let processedFrames = 0;
  const emit = (phase: RenderProgress['phase']) => {
    const now = performance.now();
    const elapsedSeconds = (now - (started ??= now)) / 1000;
    const remainingSeconds =
      phase === 'rendering' &&
      !details?.indeterminate &&
      processedFrames > 0 &&
      processedFrames < totalFrames
        ? (elapsedSeconds * (totalFrames - processedFrames)) / processedFrames
        : null;
    onProgress?.({
      event: 'progress',
      phase,
      ...details,
      ...(cacheHits && { cacheHits: cacheHits() }),
      percent: (processedFrames / totalFrames) * 100,
      processedFrames,
      totalFrames,
      elapsedSeconds,
      remainingSeconds,
      ...(remainingSeconds !== null && { estimateScope: 'stage' }),
    });
  };
  function update(frames: number) {
    processedFrames = Math.max(processedFrames, Math.min(totalFrames, frames));
    emit('rendering');
  }
  return {
    start: () => emit('rendering'),
    update,
    chunk: (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        const separator = line.indexOf('=');
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === 'frame' && /^\d+$/.test(value)) {
          const n = Number(value);
          if (Number.isSafeInteger(n)) frames = n;
        }
        if (key === 'progress' && (value === 'continue' || value === 'end'))
          update(frames);
      }
    },
    verifying: (complete = true) => {
      processedFrames = complete ? totalFrames : 0;
      emit('verifying');
    },
  };
}
