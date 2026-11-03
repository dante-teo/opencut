/** Shared T03/T10 letterboxing; preserve display aspect ratio, then square pixels. */
export function fitVideo(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  );
}

/** FFmpeg consumes the same resolved geometry as the browser compositor. */
export function fitVisual(
  geometry: {
    scaledWidth: number;
    scaledHeight: number;
    layerWidth: number;
    layerHeight: number;
    cropX: number;
    cropY: number;
  },
  colorMatrix: string,
): string {
  const { scaledWidth, scaledHeight, layerWidth, layerHeight, cropX, cropY } =
    geometry;
  return (
    `scale=${scaledWidth}:${scaledHeight}:reset_sar=1:in_color_matrix=${colorMatrix},` +
    (scaledWidth !== layerWidth || scaledHeight !== layerHeight
      ? `crop=${layerWidth}:${layerHeight}:${cropX}:${cropY},`
      : '') +
    'setsar=1'
  );
}
