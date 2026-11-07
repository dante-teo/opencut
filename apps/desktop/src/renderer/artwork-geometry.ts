import {
  WAVEFORM_BINS_PER_SECOND,
  WAVEFORM_CHUNK_SECONDS,
} from '@opencut/shared';

export function filmstripTiles(
  offset: number,
  width: number,
  zoom: number,
  sourceIn: number,
  sourceOut: number,
  image = false,
) {
  // Batch close-spaced video samples. Distant samples use fast random seeks.
  const interval = 72 / zoom;
  const batch = !image && interval <= 1.5 ? 4 : 1;
  const size = 72 * batch;
  const first = Math.floor(offset / size);
  const last = Math.ceil(
    Math.min(offset + width, (sourceOut - sourceIn) * zoom) / size,
  );
  return Array.from({ length: Math.max(0, last - first) }, (_, i) => {
    const index = first + i;
    const start = sourceIn + index * batch * interval;
    let count = Math.min(batch, Math.ceil((sourceOut - start) / interval));
    if (count > 1 && start + (count - 1) * interval >= sourceOut) count--;
    return {
      index,
      x: index * size - offset,
      width: count * 72,
      count,
      interval: count > 1 ? interval : 0,
      start: image ? 0 : start,
    };
  }).filter((tile) => tile.count > 0);
}

interface WaveformTile {
  start: number;
  x: number;
  width: number;
  from: number;
  to: number;
  clipFrom: number;
  clipTo: number;
}

export function waveformTiles(
  offset: number,
  width: number,
  zoom: number,
  sourceIn: number,
  sourceOut: number,
): WaveformTile[] {
  const from = sourceIn + offset / zoom;
  const to = Math.min(sourceOut, from + width / zoom);
  if (to <= from) return [];
  const first = Math.floor(from / WAVEFORM_CHUNK_SECONDS);
  const last = Math.ceil(to / WAVEFORM_CHUNK_SECONDS);
  return Array.from({ length: last - first }, (_, i) => {
    const start = (first + i) * WAVEFORM_CHUNK_SECONDS;
    const left = Math.max(from, start);
    const right = Math.min(to, start + WAVEFORM_CHUNK_SECONDS);
    return {
      start,
      x: (left - from) * zoom,
      width: (right - left) * zoom,
      from: left - start,
      to: right - start,
      clipFrom: Math.max(0, sourceIn - start),
      clipTo: Math.min(WAVEFORM_CHUNK_SECONDS, sourceOut - start),
    };
  });
}

export function waveformPath(
  peaks: Uint8Array,
  tile: WaveformTile,
  zoom: number,
  height: number,
) {
  const rate = WAVEFORM_BINS_PER_SECOND;
  // Aggregate about one pixel per column, retaining transients at coarse zoom.
  const stride = Math.max(1, Math.floor(rate / zoom));
  const first = Math.floor((tile.from * rate) / stride) * stride;
  const last = Math.ceil(tile.to * rate);
  // Omit partial bins at clip cuts so excluded source audio cannot bleed in.
  const clipFirst = Math.ceil(tile.clipFrom * rate - 1e-8);
  const clipLast = Math.floor(tile.clipTo * rate + 1e-8);
  const center = height / 2;
  const columns: string[] = [];
  for (let bin = first; bin < last; bin += stride) {
    const from = Math.max(bin, clipFirst);
    const to = Math.min(bin + stride, clipLast, peaks.length);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, peaks[i]!);
    if (!peak) continue;
    const x = (Math.max(tile.from, from / rate) - tile.from) * zoom;
    const right = (Math.min(tile.to, to / rate) - tile.from) * zoom;
    if (right <= x) continue;
    const amplitude = (peak / 255) * (center - 0.5);
    columns.push(
      `M${x.toFixed(2)} ${(center - amplitude).toFixed(2)}H${right.toFixed(2)}V${(center + amplitude).toFixed(2)}H${x.toFixed(2)}Z`,
    );
  }
  return columns.join('');
}
