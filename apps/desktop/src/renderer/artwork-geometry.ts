export function artworkTiles(
  offset: number,
  width: number,
  zoom: number,
  sourceIn: number,
  sourceOut: number,
  audio: boolean,
  image = false,
) {
  // Batch close-spaced video samples; distant samples use fast random seeks.
  const batch = !audio && !image && 72 / zoom <= 1.5 ? 4 : 1;
  const size = audio ? 512 : 72 * batch;
  const first = Math.floor(Math.max(0, offset) / size);
  const last = Math.ceil((offset + width) / size);
  return Array.from({ length: Math.max(0, last - first) }, (_, i) => {
    const index = first + i;
    const start = Math.min(
      sourceOut - 0.000001,
      sourceIn + (index * size) / zoom,
    );
    const duration = Math.min(size / zoom, sourceOut - start);
    const count = audio
      ? 1
      : Math.min(batch, Math.ceil((duration * zoom) / 72));
    return {
      x: index * size - offset,
      width: audio ? duration * zoom : count * 72,
      count,
      interval: 72 / zoom,
      start: Math.max(0, start),
      duration,
    };
  });
}
