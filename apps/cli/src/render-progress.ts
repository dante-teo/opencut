import type { RenderProgress } from '@opencut/media';

/** Keep machine-readable events on stderr and give interactive users the layer and frame count. */
export function writeRenderProgress(event: RenderProgress, json?: boolean) {
  if (json) {
    process.stderr.write(JSON.stringify(event) + '\n');
    return;
  }
  const labels = {
    preparation: 'Preparing export',
    composition: 'Compositing',
    graphics: 'Rendering graphics',
    'audio-analysis': 'Analyzing audio',
    'audio-mastering': 'Mastering audio',
    encoding: 'Encoding',
    muxing: 'Combining picture and audio',
    'encoding-complete': 'Encoding complete',
    verification: 'Verifying',
    'review-labels': 'Rendering review labels',
    ready: 'Ready',
  };
  const stage = event.stage ? labels[event.stage] : event.phase;
  const details = [
    event.clipId && event.detail && `${event.detail} ${event.clipId}`,
    !event.indeterminate &&
      `${event.processedFrames}/${event.totalFrames} frames`,
    `${(event.exportElapsedSeconds ?? event.elapsedSeconds).toFixed(1)}s elapsed`,
    event.idleSeconds !== undefined &&
      `${event.idleSeconds.toFixed(1)}s since last progress`,
    event.remainingSeconds !== null &&
      `stage ETA ${event.remainingSeconds.toFixed(1)}s`,
    event.cacheHits !== undefined && `${event.cacheHits} cache hits`,
  ].filter(Boolean);
  process.stderr.write(`${stage} · ${details.join(' · ')}\n`);
}
