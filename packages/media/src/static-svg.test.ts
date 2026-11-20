import { expect, it } from 'vitest';
import sharp from 'sharp';
import { compileStaticSvg, rasterizeStaticSvg } from './static-svg.js';

const svg = (body: string) =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10">' +
      body +
      '</svg>',
  );

it('fits a static SVG logical surface and preserves transparent gradient pixels', async () => {
  const source = await compileStaticSvg(
    svg(`
    <defs><linearGradient id="paint">
      <stop offset="0" stop-color="red" stop-opacity=".5"/>
      <stop offset="1" stop-color="red"/>
    </linearGradient></defs>
    <rect x="5" y="2" width="10" height="6" fill="url(#paint)"/>
  `),
    40,
    20,
  );
  const { data, info } = await sharp(await rasterizeStaticSvg(source))
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info).toMatchObject({ width: 40, height: 20, channels: 4 });
  expect(data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 0]));
  const pixel = (10 * 40 + 15) * 4;
  expect(data[pixel]).toBe(255);
  expect(data[pixel + 3]).toBeGreaterThan(127);
  expect(data[pixel + 3]).toBeLessThan(255);
});

it.each([
  '<script/>',
  '<rect onclick="alert(1)"/>',
  '<rect fill="url(https://example.invalid/a)"/>',
  '<rect fill="url(#missing)"/>',
  '<foreignObject/>',
  '<animate/>',
  '<use href="#foo"/>',
  '<style>rect {fill: red}</style>',
])('rejects unsupported SVG input %s', async (content) => {
  await expect(compileStaticSvg(svg(content), 40, 20)).rejects.toThrow(/SVG/);
});

it('rejects entity declarations and malformed XML', async () => {
  await expect(
    compileStaticSvg(
      Buffer.from('<!DOCTYPE svg SYSTEM "a">' + svg('').toString()),
      40,
      20,
    ),
  ).rejects.toThrow(/DTD/);
  await expect(compileStaticSvg(svg('<g>'), 40, 20)).rejects.toThrow();
});

it('rejects a document stylesheet before or after the SVG root', async () => {
  const declaration = '<?xml version="1.0"?>';
  const stylesheet = '<?xml-stylesheet type="text/css" href="brand.css"?>';
  const root = svg('<rect width="10" height="10"/>').toString();
  for (const markup of [stylesheet + root, root + stylesheet])
    await expect(
      compileStaticSvg(Buffer.from(declaration + markup), 40, 20),
    ).rejects.toThrow(/external stylesheets/);
  await expect(
    compileStaticSvg(Buffer.from(declaration + root), 40, 20),
  ).resolves.toMatchObject({ text: false });
});

it('rasterizes bilingual text and anchored tspans with bundled and declared fonts', async () => {
  const font = await (
    await import('node:fs/promises')
  ).readFile(new URL('../fonts/NotoEmoji.ttf', import.meta.url));
  const bytes =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80">
    <text x="110" y="30" text-anchor="middle" font-size="24" fill="white">中文 OpenCut
      <tspan x="110" dy="30" font-family="Icons">📊</tspan>
    </text>
  </svg>`);
  const bundle = await compileStaticSvg(bytes, 220, 80, { Icons: font });
  const { rasterizeStaticSvg: rasterizeBuiltSvg } =
    await import('../dist/static-svg.js');
  const { data, info } = await sharp(await rasterizeBuiltSvg(bundle))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = (start: number, end: number) => {
    let count = 0;
    for (let y = start; y < end; y++)
      for (let x = 24; x < 196; x++)
        if (data[(y * info.width + x) * info.channels + 3]! > 0) count++;
    return count;
  };
  expect(pixels(8, 36)).toBeGreaterThan(400);
  expect(pixels(37, 77)).toBeGreaterThan(40);
  expect(data.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 0]));
  await expect(compileStaticSvg(bytes, 220, 80)).rejects.toThrow(
    /Unknown static SVG font family/,
  );
  await expect(
    compileStaticSvg(bytes, 220, 80, { Icons: Buffer.from('bad') }),
  ).rejects.toThrow(/TTF or OTF/);
});
