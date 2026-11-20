import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountRenderBytes } from './render-budget.js';
import { runMediaTool } from './process.js';
import { validateEmbeddedFont } from './text.js';
import { svgRaster } from './static-svg-raster.js';
import {
  DOMParser,
  Node,
  XMLSerializer,
  onErrorStopParsing,
} from '@xmldom/xmldom';
import sharp from 'sharp';

const namespace = 'http://www.w3.org/2000/svg';
const tags = new Set(
  'svg g defs path rect circle ellipse line polyline polygon linearGradient radialGradient stop clipPath mask title desc text tspan'.split(
    ' ',
  ),
);
const attributes = new Set(
  (
    'id width height viewBox preserveAspectRatio x y x1 y1 x2 y2 cx cy r rx ry fx fy fr d points ' +
    'transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap ' +
    'stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit opacity clip-path clip-rule ' +
    'clipPathUnits mask maskUnits maskContentUnits gradientUnits gradientTransform spreadMethod ' +
    'offset stop-color stop-opacity color shape-rendering vector-effect ' +
    'font-family font-size font-style font-weight letter-spacing text-anchor dominant-baseline dx dy'
  ).split(' '),
);
const referenceTypes: Record<string, readonly string[]> = {
  fill: ['linearGradient', 'radialGradient'],
  stroke: ['linearGradient', 'radialGradient'],
  'clip-path': ['clipPath'],
  mask: ['mask'],
};

export interface StaticSvgBundle {
  key: string;
  svg: string;
  text: boolean;
  fonts?: Readonly<Record<string, string>>;
}

const builtinFamilies = ['OpenCut Sans', 'OpenCut Emoji'] as const;
let bundledFonts:
  Promise<{ family: string; bytes: Buffer; key: string }[]> | undefined;
function loadBundledFonts() {
  return (bundledFonts ??= Promise.all(
    ['NotoSansSC.ttf', 'NotoEmoji.ttf'].map(async (name, index) => {
      const bytes = await readFile(
        new URL('../fonts/' + name, import.meta.url),
      );
      return {
        family: builtinFamilies[index]!,
        bytes,
        key: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  ));
}

export async function compileStaticSvg(
  bytes: Buffer,
  width: number,
  height: number,
  fonts: Readonly<Record<string, Buffer>> = {},
): Promise<StaticSvgBundle> {
  if (bytes.length > 4 * 1024 * 1024)
    throw new Error('Static SVG files are limited to 4 MiB.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Reject document-level declarations before handing input to the parser.
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('Static SVG cannot contain a DTD or entity declaration.');
  const doc = new DOMParser({ onError: onErrorStopParsing }).parseFromString(
    source,
    'image/svg+xml',
  );
  for (let node = doc.firstChild; node; node = node.nextSibling)
    if (
      node.nodeType === Node.PROCESSING_INSTRUCTION_NODE &&
      node.nodeName === 'xml-stylesheet'
    )
      throw new Error('Static SVG cannot reference external stylesheets.');
  const root = doc.documentElement;
  if (root?.namespaceURI !== namespace || root.localName !== 'svg')
    throw new Error('Expected an SVG document with the SVG namespace.');
  const ids = new Map<string, string>();
  const refs: Array<{ id: string; attr: string }> = [];
  let count = 0;
  let hasText = false;
  let characters = 0;
  const visit = (
    element: NonNullable<typeof root>,
    depth: number,
    defs: boolean,
  ) => {
    const tag = element.localName ?? '';
    if (depth > 64 || ++count > 16_384)
      throw new Error('Static SVG exceeds its element or nesting limit.');
    if (
      element.namespaceURI !== namespace ||
      !tags.has(tag) ||
      (depth > 0 && tag === 'svg')
    )
      throw new Error(`Unsupported static SVG element '${element.tagName}'.`);
    if (tag === 'text' || tag === 'tspan') hasText = true;
    const isDefinition =
      defs ||
      ['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient'].includes(
        tag,
      );
    for (let i = 0; i < element.attributes.length; i++) {
      const { name, value, namespaceURI } = element.attributes.item(i)!;
      if (name === 'xmlns' && value === namespace) continue;
      if (namespaceURI || !attributes.has(name) || /\\/.test(value))
        throw new Error(`Unsupported static SVG attribute '${name}'.`);
      if (
        name === 'font-family' &&
        value.split(',').some((family) => {
          const alias = family.trim().replace(/^['"]|['"]$/g, '');
          return (
            alias !== 'sans-serif' &&
            !builtinFamilies.some((name) => name === alias) &&
            !Object.hasOwn(fonts, alias)
          );
        })
      )
        throw new Error(
          `Unknown static SVG font family '${value}'. Declare a local font alias or use OpenCut Sans.`,
        );
      if (name === 'id') {
        if (!/^[\w.-]+$/.test(value) || ids.has(value))
          throw new Error(`Invalid or duplicate static SVG ID '${value}'.`);
        ids.set(value, tag);
      }
      if (/url\s*\(/i.test(value)) {
        const ref = /^url\(#([\w.-]+)\)$/i.exec(value.trim())?.[1];
        if (!ref || !Object.hasOwn(referenceTypes, name) || isDefinition)
          throw new Error(
            'Static SVG references must point to a local gradient, clip path, or mask.',
          );
        refs.push({ id: ref, attr: name });
      }
    }
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1)
        visit(node as NonNullable<typeof root>, depth + 1, isDefinition);
      else if (node.nodeType === 3 || node.nodeType === 4) {
        if (tag === 'text' || tag === 'tspan')
          characters += node.nodeValue?.length ?? 0;
      } else if (node.nodeType !== 8)
        throw new Error('Static SVG contains an unsupported XML node.');
    }
  };
  visit(root, 0, false);
  if (characters > 16_384)
    throw new Error('Static SVG text exceeds 16,384 characters.');
  if (hasText && !root.hasAttribute('font-family'))
    root.setAttribute('font-family', builtinFamilies.join(', '));
  for (const { id, attr } of refs)
    if (!referenceTypes[attr]!.includes(ids.get(id) ?? ''))
      throw new Error(
        `Static SVG '${attr}' refers to a missing or incompatible ID '${id}'.`,
      );

  const dimension = (name: string, fallback: number) => {
    const value = root.getAttribute(name);
    if (!value) return fallback;
    const parsed = /^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/.exec(value.trim());
    const number = Number(parsed?.[1]);
    if (!Number.isFinite(number) || !(number > 0))
      throw new Error(
        'An SVG without a viewBox requires positive pixel dimensions.',
      );
    return number;
  };
  const box = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number) ?? [
    0,
    0,
    dimension('width', width),
    dimension('height', height),
  ];
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value)) ||
    !(box[2]! > 0 && box[3]! > 0)
  )
    throw new Error('Static SVG requires a valid viewBox.');
  root.setAttribute('viewBox', box.join(' '));
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const svg = new XMLSerializer().serializeToString(root);
  const entries = Object.entries(fonts);
  const captured = Object.create(null) as Record<string, string>;
  for (const [family, bytes] of entries) {
    await validateEmbeddedFont(bytes);
    captured[family] = bytes.toString('base64');
  }
  const bundled = hasText ? await loadBundledFonts() : [];
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        2,
        sharp.versions,
        svg,
        bundled.map(({ key }) => key),
        captured,
      ]),
    )
    .digest('hex');
  return {
    key,
    svg,
    text: hasText,
    ...(entries.length && { fonts: captured }),
  };
}

export async function rasterizeStaticSvg(
  bundle: StaticSvgBundle,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const png = await (bundle.text
    ? rasterizeSvgWithFonts(bundle, signal)
    : svgRaster(sharp, Buffer.from(bundle.svg)));
  signal?.throwIfAborted();
  return png;
}

// Fontconfig initializes process-wide. Keep the selected fonts private to the native worker.
async function rasterizeSvgWithFonts(
  bundle: StaticSvgBundle,
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), 'opencut-svg-'));
  const input = join(directory, 'graphic.svg');
  const config = join(directory, 'fonts.conf');
  const escapeXml = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const value = (s: string) => '<string>' + escapeXml(s) + '</string>';
  try {
    const available = [
      ...(await loadBundledFonts()),
      ...Object.entries(bundle.fonts ?? {}).map(([family, base64]) => ({
        family,
        bytes: Buffer.from(base64, 'base64'),
      })),
    ];
    const rules: string[] = [];
    for (const [index, { family, bytes }] of available.entries()) {
      const path = join(
        directory,
        `font-${index}.${bytes.subarray(0, 4).toString() === 'OTTO' ? 'otf' : 'ttf'}`,
      );
      accountRenderBytes(bytes.length);
      await writeFile(path, bytes, { flag: 'wx', signal });
      rules.push(
        `<match target="scan"><test name="file" compare="eq">${value(path)}</test><edit name="family" mode="assign_replace">${value(family)}</edit></match>`,
      );
    }
    const fonts =
      '<?xml version="1.0"?><fontconfig>' +
      `<dir>${escapeXml(directory)}</dir><cachedir>${escapeXml(join(directory, 'cache'))}</cachedir>` +
      '<alias><family>sans-serif</family><prefer><family>OpenCut Sans</family><family>OpenCut Emoji</family></prefer></alias>' +
      rules.join('') +
      '</fontconfig>';
    accountRenderBytes(
      Buffer.byteLength(bundle.svg) + Buffer.byteLength(fonts),
    );
    await writeFile(config, fonts, { flag: 'wx', signal });
    await writeFile(input, bundle.svg, { flag: 'wx', signal });
    return await runMediaTool(
      process.execPath,
      [
        fileURLToPath(new URL('./static-svg-worker.js', import.meta.url)),
        input,
      ],
      36 * 1024 * 1024,
      15_000,
      {
        signal,
        env: {
          ...process.env,
          FONTCONFIG_FILE: config,
          FONTCONFIG_PATH: directory,
          NODE_OPTIONS: '',
          ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: '1' }),
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
