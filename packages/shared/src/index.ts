export const WAVEFORM_CHUNK_SECONDS = 16;
export const WAVEFORM_BINS_PER_SECOND = 100;

/** Headless composition rules used by both FFmpeg and the browser preview. */
export interface VisualTransform {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  fit?: 'contain' | 'cover' | 'stretch';
}

export const DEFAULT_TEXT_FONT = 'Noto Sans SC';
export const DEFAULT_TEXT_SIZE = 48;

export interface TextLayer {
  content: string;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  fontWeight?: number | undefined;
  color?: string | undefined;
  alignment?: 'left' | 'center' | 'right' | undefined;
  wrapWidth?: number | null | undefined;
  rotation?: number | undefined;
  stroke?: { color: string; width: number } | null | undefined;
  shadow?:
    { color: string; x: number; y: number; blur: number } | null | undefined;
  background?: { color: string; padding: number } | null | undefined;
}

export const canvasColorPattern =
  /^(?:#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|transparent)$/;

/** H.264 has no alpha. Flatten a transparent canvas over black at export. */
export function opaqueCanvasColor(color: string): string {
  if (color === 'transparent') return '#000000';
  if (color.length === 7) return color;
  const alpha = parseInt(color.slice(7, 9), 16) / 255;
  return (
    '#' +
    [1, 3, 5]
      .map((i) =>
        Math.round(parseInt(color.slice(i, i + 2), 16) * alpha)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

export function fittingBox(width: number, height: number, scale = 1) {
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

/**
 * Project pixels, top-left origin, centered fitting rectangle; positive x/y right/down.
 * sourceWidth/Height describe DISPLAY pixels (sample aspect and rotation applied).
 * Match FFmpeg's even scale/crop and yuv420 overlay coordinate quantization.
 */
export function visualGeometry(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  visual: VisualTransform = {},
) {
  const box = fittingBox(width, height, visual.scale);
  const fit = visual.fit ?? 'contain';
  const aspect = sourceWidth / sourceHeight;
  const even = (n: number) =>
    Math.max(2, (fit === 'cover' ? Math.ceil(n / 2) : Math.floor(n / 2)) * 2);
  const scaledWidth =
    fit === 'stretch'
      ? box.width
      : even(
          Math[fit === 'cover' ? 'max' : 'min'](
            box.width,
            Math.round(box.height * aspect),
          ),
        );
  const scaledHeight =
    fit === 'stretch'
      ? box.height
      : even(
          Math[fit === 'cover' ? 'max' : 'min'](
            box.height,
            Math.round(box.width / aspect),
          ),
        );
  const layerWidth = fit === 'cover' ? box.width : scaledWidth;
  const layerHeight = fit === 'cover' ? box.height : scaledHeight;
  const cropX =
    fit === 'cover' ? Math.floor((scaledWidth - layerWidth) / 4) * 2 : 0;
  const cropY =
    fit === 'cover' ? Math.floor((scaledHeight - layerHeight) / 4) * 2 : 0;
  const grid = (n: number) => Math.floor(Math.trunc(n) / 2) * 2;
  const x = grid((width - layerWidth) / 2 + (visual.x ?? 0));
  const y = grid((height - layerHeight) / 2 + (visual.y ?? 0));
  return {
    x,
    y,
    scaledWidth,
    scaledHeight,
    layerWidth,
    layerHeight,
    cropX,
    cropY,
    opacity: visual.opacity ?? 1,
    visible:
      (visual.opacity ?? 1) > 0 &&
      x < width &&
      y < height &&
      x + layerWidth > 0 &&
      y + layerHeight > 0,
  };
}

/** Browser-compatible SDR YUV matrix fallback for untagged sources. */
export function sourceColorMatrix(
  colorSpace: string | null | undefined,
  width: number,
  height: number,
  codec?: string | null,
): string {
  if (
    [
      'bt709',
      'bt470bg',
      'smpte170m',
      'smpte240m',
      'bt2020nc',
      'bt2020c',
    ].includes(colorSpace ?? '')
  )
    return colorSpace!;
  // Untagged VP9 uses BT.709 in Chromium even at SD resolutions.
  return codec === 'vp9' || width >= 1280 || height > 576 ? 'bt709' : 'bt601';
}

/** Exact source and timeline boundaries passed from the evaluator to the renderer. */
export interface RenderTimeMapping {
  timelineStart: { numerator: number; denominator: number };
  timelineEnd: { numerator: number; denominator: number };
  sourceIn: { numerator: number; denominator: number };
  sourceOut: { numerator: number; denominator: number };
  speed: { numerator: number; denominator: number };
}
