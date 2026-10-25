/** Shared T03/T10 letterboxing; preserve display aspect ratio, then square pixels. */
export function fitVideo(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/** Fit to an even, scaled canvas rectangle; contain leaves transparent margins. */
export function fitVisual(
  width: number,
  height: number,
  scale: number,
  fit: 'contain' | 'cover' | 'stretch',
): string {
  const w = Math.max(2, Math.round((width * scale) / 2) * 2);
  const h = Math.max(2, Math.round((height * scale) / 2) * 2);
  if (fit === 'stretch') return `scale=${w}:${h}:reset_sar=1,setsar=1`;
  const mode = fit === 'cover' ? 'increase' : 'decrease';
  return (
    `scale=${w}:${h}:force_original_aspect_ratio=${mode}:force_divisible_by=2:reset_sar=1,` +
    (fit === 'cover' ? `crop=${w}:${h},` : '') +
    'setsar=1'
  );
}
