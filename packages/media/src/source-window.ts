import type { SourceWindow } from '@opencut/shared';
import type { MediaStream } from './probe.js';
import { MediaError } from './process.js';

export function orientedSource(stream: MediaStream) {
  const rotated = Math.abs(stream.rotation ?? 0) % 180 === 90;
  const sar = stream.sampleAspectRatio ?? 1;
  return {
    width: (rotated ? stream.height : stream.width) ?? 0,
    height: (rotated ? stream.width : stream.height) ?? 0,
    sar: rotated ? 1 / sar : sar,
  };
}

export function resolveSourceWindow(
  source: { width: number; height: number },
  clipId: string,
  window?: SourceWindow,
): SourceWindow {
  if (!window)
    return { x: 0, y: 0, width: source.width, height: source.height };
  const { x, y, width, height } = window;
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > source.width ||
    y + height > source.height
  )
    throw new MediaError(
      `Clip '${clipId}' sourceWindow must fit inside its ${source.width}×${source.height} oriented source pixels.`,
    );
  return window;
}

/** Decode to full-range RGB first so odd coordinates are exact with subsampled sources. */
export function sourceWindowFilter(window: SourceWindow, matrix: string) {
  return `scale=in_color_matrix=${matrix},format=rgba,crop=${window.width}:${window.height}:${window.x}:${window.y}:exact=1`;
}
