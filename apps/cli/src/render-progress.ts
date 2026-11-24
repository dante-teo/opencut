import type { RenderProgress } from '@opencut/media';

/** Keep machine-readable events on stderr and give interactive users the layer and frame count. */
export function writeRenderProgress(event: RenderProgress, json?: boolean) {
  if (json) {
    process.stderr.write(JSON.stringify(event) + '\n');
    return;
  }
  if (event.clipId && event.detail) {
    const hits =
      event.cacheHits === undefined ? '' : `, ${event.cacheHits} cache hits`;
    process.stderr.write(
      `${event.detail} ${event.clipId}: ${event.processedFrames}/${event.totalFrames} frames in ${event.elapsedSeconds.toFixed(1)}s${hits}\n`,
    );
    return;
  }
  process.stderr.write(
    `${event.phase}: ${event.percent.toFixed(1)}% (${event.stage ?? event.phase})\n`,
  );
}
