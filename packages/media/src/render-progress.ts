import { performance } from 'node:perf_hooks';

export interface RenderProgress {
  event: 'progress';
  phase: 'rendering' | 'verifying';
  stage?:
    | 'graphics'
    | 'composition'
    | 'audio-analysis'
    | 'audio-mastering'
    | 'encoding'
    | 'muxing'
    | 'verification'
    | 'review-labels';
  clipId?: string;
  percent: number;
  processedFrames: number;
  totalFrames: number;
  elapsedSeconds: number;
  remainingSeconds: number | null;
}

/** FFmpeg -progress records end with progress=continue/end, independent of chunks. */
export function renderProgress(
  totalFrames: number,
  onProgress?: (progress: RenderProgress) => void,
  details?: Pick<RenderProgress, 'stage' | 'clipId'>,
) {
  let started: number | undefined;
  let pending = '';
  let frames = 0;
  let processedFrames = 0;
  const emit = (phase: RenderProgress['phase']) => {
    const now = performance.now();
    const elapsedSeconds = (now - (started ??= now)) / 1000;
    onProgress?.({
      event: 'progress',
      phase,
      ...details,
      percent: (processedFrames / totalFrames) * 100,
      processedFrames,
      totalFrames,
      elapsedSeconds,
      remainingSeconds:
        phase === 'rendering' &&
        processedFrames > 0 &&
        processedFrames < totalFrames
          ? (elapsedSeconds * (totalFrames - processedFrames)) / processedFrames
          : null,
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
