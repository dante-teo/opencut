import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { DEFAULT_TEXT_FONT, DEFAULT_TEXT_SIZE } from '@opencut/shared';
import type { TextLayer, VisualTransform } from '@opencut/shared';
import { checkRenderSignal, MediaError } from './process.js';

const bundledFamily = 'OpenCut Noto Sans SC';
const emojiFamily = 'OpenCut Noto Emoji';
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const words = new Intl.Segmenter('und', { granularity: 'word' });
let engine: Promise<typeof import('@napi-rs/canvas')> | undefined;
const registeredFonts = new Map<
  string,
  NonNullable<
    ReturnType<(typeof import('@napi-rs/canvas'))['GlobalFonts']['register']>
  >
>();

async function embeddedFamily(encoded: string) {
  const { GlobalFonts } = await loadEngine();
  const data = Buffer.from(encoded, 'base64');
  const signature = data.subarray(0, 4).toString('hex');
  if (data.length > 2_097_152 || !['00010000', '4f54544f'].includes(signature))
    throw new MediaError('Choose a TTF or OTF font up to 2 MiB.');
  const alias = `OpenCut ${createHash('sha256').update(data).digest('hex')}`;
  if (!registeredFonts.has(alias)) {
    const font = GlobalFonts.register(data, alias);
    if (!font) throw new MediaError('The font file could not be loaded.');
    registeredFonts.set(alias, font);
    if (registeredFonts.size > 32) {
      const oldest = registeredFonts.keys().next().value!;
      GlobalFonts.remove(registeredFonts.get(oldest)!);
      registeredFonts.delete(oldest);
    }
  }
  return alias;
}

export async function validateEmbeddedFont(data: Buffer) {
  await embeddedFamily(data.toString('base64'));
}

function loadEngine() {
  return (engine ??= import('@napi-rs/canvas').then((canvas) => {
    for (const [file, family] of [
      ['NotoSansSC.ttf', bundledFamily],
      ['NotoEmoji.ttf', emojiFamily],
    ] as const) {
      const path = fileURLToPath(new URL('../fonts/' + file, import.meta.url));
      if (!canvas.GlobalFonts.registerFromPath(path, family))
        throw new MediaError(
          `Could not load bundled font ${file}. Restore the fonts shipped with OpenCut.`,
        );
    }
    return canvas;
  }));
}

/** Probe growing ranges of whole segments, then narrow the wrap boundary. */
function fittingEnd(
  segments: string[],
  start: number,
  prefix: string,
  fits: (line: string) => boolean,
) {
  const fitsThrough = (end: number) =>
    fits(prefix + segments.slice(start, end).join(''));
  let low = start;
  let high = start + 1;
  while (fitsThrough(high)) {
    if (high === segments.length) return high;
    low = high;
    high = Math.min(segments.length, start + (high - start) * 2);
  }
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (fitsThrough(mid)) low = mid;
    else high = mid;
  }
  return low;
}

const normalizeLayoutText = (content: string) =>
  content.replace(/\r\n?/g, '\n').replaceAll('\t', '    ');

function layoutLines(ctx: SKRSContext2D, content: string, wrap?: number) {
  const paragraphs = content.split('\n');
  if (wrap === undefined) return paragraphs;
  const lines: string[] = [];
  const fits = (line: string) => ctx.measureText(line).width <= wrap;
  for (const paragraph of paragraphs) {
    const segments = Array.from(
      words.segment(paragraph),
      ({ segment }) => segment,
    );
    let line = '';
    for (let start = 0; start < segments.length;) {
      const end = fittingEnd(segments, start, line, fits);
      line += segments.slice(start, end).join('');
      if (end === segments.length) break;
      if (line) lines.push(line.trimEnd());
      const word = segments[end]!.trimStart();
      start = end + 1;
      if (fits(word)) {
        line = word;
        continue;
      }
      const glyphs = Array.from(
        graphemes.segment(word),
        ({ segment }) => segment,
      );
      for (let first = 0; first < glyphs.length;) {
        const next = Math.max(first + 1, fittingEnd(glyphs, first, '', fits));
        line = glyphs.slice(first, next).join('');
        if (next < glyphs.length) lines.push(line);
        first = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface TextRaster {
  x: number;
  y: number;
  width: number;
  height: number;
  png: Buffer | null;
  warning: string | null;
}

const rasters = new LRUCache<string, TextRaster>({
  max: 64,
  maxSize: 16 * 1024 ** 2,
  sizeCalculation: (raster) => Math.max(1, raster.png?.byteLength ?? 0),
});

/** One project-pixel raster per static style. Both compositors use its integer origin. */
export async function rasterizeTextLayer(
  width: number,
  height: number,
  text: TextLayer,
  visual: VisualTransform,
  signal?: AbortSignal,
  neutral = false,
): Promise<TextRaster> {
  checkRenderSignal(signal);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 3840 ||
    height > 3840 ||
    width * height > 3840 * 2160
  )
    throw new MediaError(
      'Text rendering requires a canvas up to 3840 pixels per side and 3840×2160 total pixels.',
    );
  const { x = 0, y = 0, scale = 1, opacity = 1 } = neutral ? {} : visual;
  const key = JSON.stringify([
    width,
    height,
    text,
    x,
    y,
    scale,
    opacity,
    neutral,
  ]);
  const cached = rasters.get(key);
  if (cached) return cached;
  const { createCanvas, GlobalFonts } = await loadEngine();
  checkRenderSignal(signal);
  if (text.canvasFill) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.globalAlpha = opacity;
    context.fillStyle = text.canvasFill;
    context.fillRect(0, 0, width, height);
    const raster = {
      x: 0,
      y: 0,
      width,
      height,
      png: canvas.toBuffer('image/png'),
      warning: null,
    };
    rasters.set(key, raster);
    return raster;
  }
  const requested = text.fontFamily ?? DEFAULT_TEXT_FONT;
  const family = text.embeddedFont
    ? await embeddedFamily(text.embeddedFont)
    : requested.toLowerCase() === DEFAULT_TEXT_FONT.toLowerCase()
      ? bundledFamily
      : requested.toLowerCase() === 'noto emoji'
        ? emojiFamily
        : GlobalFonts.families.find(
            ({ family }) =>
              family.toLowerCase() === requested.toLowerCase() &&
              !/["\\\p{Cc}]/u.test(family),
          )?.family;
  const warning = family
    ? null
    : `Font “${requested}” is unavailable. Using ${DEFAULT_TEXT_FONT}.`;
  const empty = { x: 0, y: 0, width: 0, height: 0, png: null, warning };
  if (!text.content || opacity === 0) {
    rasters.set(key, empty);
    return empty;
  }

  const size = text.fontSize ?? DEFAULT_TEXT_SIZE;
  const lineHeight = size * 1.25;
  const fallbackFonts = `"${bundledFamily}", "${emojiFamily}"`;
  const fontFamilies =
    family && family !== bundledFamily
      ? `"${family}", ${fallbackFonts}`
      : fallbackFonts;
  const font = `${text.fontWeight ?? 400} ${size}px ${fontFamilies}`;
  const metrics = createCanvas(1, 1).getContext('2d');
  metrics.font = font;
  const normalized = normalizeLayoutText(text.content);
  const lines = layoutLines(metrics, normalized, text.wrapWidth ?? undefined);
  const measured = lines.map((line) => metrics.measureText(line));
  const blockWidth = Math.max(
    text.wrapWidth ?? 0,
    ...measured.map((line) => line.width),
  );
  const blockHeight = lines.length * lineHeight;
  const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } =
    metrics.measureText('国Mg');
  const baseline = (lineHeight + ascent - descent) / 2 - blockHeight / 2;
  const align =
    text.alignment === 'left' ? 0 : text.alignment === 'right' ? 1 : 0.5;
  const padding = text.background?.padding ?? 0;
  const stroke = text.stroke?.width ?? 0;
  let left = -blockWidth / 2 - padding;
  let right = blockWidth / 2 + padding;
  let top = -blockHeight / 2 - padding;
  let bottom = blockHeight / 2 + padding;
  const positions = measured.map((line, i) => {
    const x = (blockWidth - line.width) * align - blockWidth / 2;
    const y = baseline + i * lineHeight;
    left = Math.min(left, x - line.actualBoundingBoxLeft);
    right = Math.max(right, x + line.actualBoundingBoxRight);
    top = Math.min(top, y - line.actualBoundingBoxAscent);
    bottom = Math.max(bottom, y + line.actualBoundingBoxDescent);
    return { x, y };
  });
  const radians = ((text.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians) * scale;
  const sin = Math.sin(radians) * scale;
  const cx = width / 2 + x;
  const cy = height / 2 + y;
  const corners = [
    [left - stroke, top - stroke],
    [right + stroke, top - stroke],
    [left - stroke, bottom + stroke],
    [right + stroke, bottom + stroke],
  ].map(
    ([u, v]) => [cx + u! * cos - v! * sin, cy + u! * sin + v! * cos] as const,
  );
  const shadow = text.shadow;
  const shadowX = shadow ? shadow.x * cos - shadow.y * sin : 0;
  const shadowY = shadow ? shadow.x * sin + shadow.y * cos : 0;
  const blur = (shadow?.blur ?? 0) * scale;
  const bleed = Math.ceil(blur * 3) + 2;
  const x0 = Math.max(
    neutral ? -Infinity : 0,
    Math.floor(Math.min(...corners.map(([u]) => u)) + Math.min(0, shadowX)) -
      bleed,
  );
  const x1 = Math.min(
    neutral ? Infinity : width,
    Math.ceil(Math.max(...corners.map(([u]) => u)) + Math.max(0, shadowX)) +
      bleed,
  );
  const y0 = Math.max(
    neutral ? -Infinity : 0,
    Math.floor(Math.min(...corners.map(([, v]) => v)) + Math.min(0, shadowY)) -
      bleed,
  );
  const y1 = Math.min(
    neutral ? Infinity : height,
    Math.ceil(Math.max(...corners.map(([, v]) => v)) + Math.max(0, shadowY)) +
      bleed,
  );
  if (x1 - x0 > 8192 || y1 - y0 > 8192 || (x1 - x0) * (y1 - y0) > 3840 * 2160)
    throw new MediaError(
      'Animated text raster exceeds 8192 pixels per side or 3840×2160 total pixels.',
    );
  if (x1 <= x0 || y1 <= y0) {
    rasters.set(key, empty);
    return empty;
  }
  const canvas = createCanvas(x1 - x0, y1 - y0);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(cos, sin, -sin, cos, cx - x0, cy - y0);
  if (text.background) {
    ctx.fillStyle = text.background.color;
    ctx.fillRect(
      -blockWidth / 2 - padding,
      -blockHeight / 2 - padding,
      blockWidth + 2 * padding,
      blockHeight + 2 * padding,
    );
  }
  ctx.font = font;
  ctx.fillStyle = text.color ?? '#ffffff';
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowOffsetX = shadowX;
    ctx.shadowOffsetY = shadowY;
    ctx.shadowBlur = blur;
  }
  if (text.stroke && stroke) {
    ctx.strokeStyle = text.stroke.color;
    ctx.lineWidth = stroke * 2;
    ctx.lineJoin = 'round';
  }
  const highlight = (
    line: string,
    x: number,
    y: number,
    from: number,
    to: number,
    onset = false,
  ) => {
    const left = ctx.measureText(line.slice(0, from)).width;
    const right = ctx.measureText(line.slice(0, to)).width;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + left, y - ascent - 2, right - left, ascent + descent + 4);
    ctx.clip();
    ctx.fillStyle = onset ? '#fff5ad' : '#ffe45c';
    ctx.fillText(line, x, y - (onset ? size * 0.06 : 0));
    ctx.restore();
  };
  let offsetInText = 0;
  const layoutOffset = (offset: number) =>
    normalizeLayoutText(text.content.slice(0, offset)).length;
  const active = text.activeWord && {
    from: layoutOffset(text.activeWord.from),
    to: layoutOffset(text.activeWord.to),
    phase: text.activeWord.phase,
  };
  for (const [i, line] of lines.entries()) {
    const { x, y } = positions[i]!;
    if (stroke) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
    for (const word of text.emphasis ?? []) {
      for (
        let offset = line.indexOf(word);
        offset >= 0;
        offset = line.indexOf(word, offset + word.length)
      ) {
        const isLatin = /^[a-z0-9]+$/i.test(word);
        if (
          isLatin &&
          (/[a-z0-9]/i.test(line[offset - 1] ?? '') ||
            /[a-z0-9]/i.test(line[offset + word.length] ?? ''))
        )
          continue;
        highlight(line, x, y, offset, offset + word.length);
      }
    }
    const lineStart = active ? normalized.indexOf(line, offsetInText) : -1;
    if (active && lineStart >= 0) {
      offsetInText = lineStart + line.length;
      if (active.to > lineStart && active.from < offsetInText)
        highlight(
          line,
          x,
          y,
          Math.max(0, active.from - lineStart),
          active.to - lineStart,
          active.phase === 0,
        );
    }
  }
  if (opacity !== 1) {
    ctx.resetTransform();
    ctx.shadowColor = 'transparent';
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${opacity})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const png = await canvas.encode('png');
  checkRenderSignal(signal);
  const raster = {
    x: x0,
    y: y0,
    width: canvas.width,
    height: canvas.height,
    png,
    warning,
  };
  rasters.set(key, raster);
  return raster;
}
