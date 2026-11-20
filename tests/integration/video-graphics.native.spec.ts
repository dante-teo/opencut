import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compileVideo, previewVideo, renderCompiledVideo } from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import {
  compareRgb,
  decodeFrames,
  ffmpeg,
  verifyVideoTimestamps,
} from './media-comparison.js';
import { fixtureDirectory } from '../fixture-paths.js';

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const readFont = (name: string) =>
  fileURLToPath(new URL('../../packages/media/fonts/' + name, import.meta.url));
const width = 384;
const height = 216;
const fps = 24;
const canvas = { width, height, frameRate: fps, durationFrames: 240 };
const code = (definition: VideoDefinition) =>
  'export default ' + JSON.stringify(definition);
const options = { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };
async function run(...args: string[]) {
  const { stdout } = await exec(
    process.execPath,
    [cli, ...args, '--json'],
    options,
  );
  return JSON.parse(stdout);
}

const card = `
import { useGraphicFrame, useGraphicResource, useGraphicData } from '@opencut/graphics/react';
import { ink } from './palette';
import './card.css';
export default function Card({ title, tint }) {
  const frame = useGraphicFrame();
  const opacity = Math.min(1, frame / 20, (205 - frame) / 18);
  const icon = useGraphicResource('icon');
  const mark = useGraphicData('words').mark;
  return <div style={{ opacity }}>
    <div className="card" style={{ backgroundColor: tint }}>
      <img src={icon} width="18" height="18" />
      <strong style={{ color: ink }}>{title} {mark}</strong>
      <small>Source {frame}</small>
    </div>
    <svg width="144" height="24" viewBox="0 0 144 24" style={{ position:'absolute', left: 180, top: 152 }}>
      <rect width="144" height="24" rx="5" fill="#202020"/>
      <rect x="4" y="4" width={Math.min(frame, 118)} height="16" rx="4" fill="#56efae"/>
    </svg>
  </div>;
}
`;
const css = `
@font-face {font-family: Fixture; src: url("./emoji.ttf") format("truetype"); unicode-range: U+1F300-1FAFF}
.card {
  position:absolute; left:20px; top:30px; width:244px; height:90px; box-sizing:border-box;
  border-radius:12px; padding:14px; color:white; font: 18px Fixture,"OpenCut CJK",sans-serif;
  background-image:linear-gradient(120deg,#0e888aa0,#046a4d19);
  box-shadow:0 6px 16px #020818a0;
}
.card strong { margin-left:8px }
.card small { display:block; margin-top:5px }
`;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 216"><rect x="332" y="12" width="32" height="12" rx="3" fill="#ffc35b" opacity=".8"/></svg>`;
const pixel = (pixels: Buffer, x: number, y: number) =>
  pixels.subarray((width * y + x) * 3, (width * y + x) * 3 + 3);
const stamp = () => performance.now();

test(
  'G12 produces a ten-second graphic export with alpha, source timing, preview parity and a portable revision',
  { timeout: 180_000 },
  async (t) => {
    await mkdir(fixtureDirectory, { recursive: true });
    const directory = await mkdtemp(join(fixtureDirectory, 'graphics-10s-'));
    try {
      const at = (name: string) => join(directory, name);
      const source = at('graphics.video.ts');
      const output = at('graphics-10s.mp4');
      const plain = at('plain.video.ts');
      const background = { kind: 'video', path: 'background.mp4' } as const;
      const baseTrack = {
        type: 'video',
        clips: [{ asset: 'background', at: 0, sourceOut: 240 }],
      } as const;
      const definition: VideoDefinition = {
        version: 2,
        canvas,
        assets: {
          background,
          card: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Card.tsx',
            durationFrames: 205,
            props: { title: '季度报告 · Results', tint: 'rgba(6,22,72,.6)' },
            resources: { icon: 'icon.png', words: 'words.json' },
          },
          logo: { kind: 'graphic', renderer: 'svg', path: 'Badge.svg' },
        },
        tracks: [
          { ...baseTrack, clips: [...baseTrack.clips] },
          {
            type: 'video',
            clips: [
              {
                id: 'card-placement',
                asset: 'card',
                at: 20,
                sourceIn: 10,
                sourceOut: 205,
              },
              {
                asset: 'card',
                at: 220,
                sourceIn: 44,
                sourceOut: 84,
                speed: { numerator: 2, denominator: 1 },
                props: { title: '第二幕 · Second look' },
                visual: { x: 12, y: -4, scale: 0.84, rotation: -2 },
              },
            ],
          },
          { type: 'video', clips: [{ asset: 'logo', at: 0, duration: 240 }] },
        ],
      };
      const plainDefinition: VideoDefinition = {
        canvas,
        assets: { background },
        tracks: [{ ...baseTrack, clips: [...baseTrack.clips] }],
      };
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x223452:s=384x216:r=24:d=10',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=384x20:r=24:d=10',
        '-filter_complex',
        '[0:v][1:v]overlay=0:196',
        '-an',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        at('background.mp4'),
      ]);
      ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'color=c=0xffaa30:s=18x18',
        '-frames:v',
        '1',
        '-threads',
        '1',
        at('icon.png'),
      ]);
      await Promise.all([
        copyFile(readFont('NotoEmoji.ttf'), at('emoji.ttf')),
        writeFile(at('Card.tsx'), card),
        writeFile(at('palette.ts'), "export const ink = '#f7fffa';"),
        writeFile(at('card.css'), css),
        writeFile(at('words.json'), JSON.stringify({ mark: '📊' })),
        writeFile(at('Badge.svg'), logo),
        writeFile(source, code(definition)),
        writeFile(plain, code(plainDefinition)),
      ]);
      const validation = await run('validate', source);
      assert.equal(validation.frameCount, 240);
      assert.equal(validation.graphics.status, 'available');
      const preview = (frame: number, name: string) =>
        run(
          'preview',
          'frame',
          source,
          '--quality',
          'quality',
          '--frame',
          String(frame),
          '--output',
          at(name),
        );
      const cold = stamp();
      await preview(65, 'first.png');
      const firstMs = stamp() - cold;
      await preview(22, 'early.png');
      await preview(216, 'gap.png');
      await preview(65, 'repeat.png');
      assert.deepEqual(
        await readFile(at('repeat.png')),
        await readFile(at('first.png')),
      );

      const cache = at('picture-cache');
      const renderStart = stamp();
      await run('render', source, '--output', output, '--picture-cache', cache);
      const renderMs = stamp() - renderStart;
      const relaunched = stamp();
      const reuse = await run(
        'render',
        source,
        '--output',
        at('cached.mp4'),
        '--picture-cache',
        cache,
      );
      const reuseMs = stamp() - relaunched;
      assert.ok(reuse.pictureRanges.length > 0);
      assert.ok(
        reuse.pictureRanges.every(
          ({ status }: { status: string }) => status === 'reused',
        ),
      );
      const timestamps = verifyVideoTimestamps(
        output,
        { numerator: 24, denominator: 1 },
        240,
      );
      assert.equal(timestamps.at(-1), 239 / 24);
      const delivered = decodeFrames(output, [22, 65, 216, 229], width, height);
      const raw = (name: string) =>
        decodeFrames(at(name), [0], width, height).get(0)!;
      const active = raw('first.png');
      const gap = raw('gap.png');
      for (const [frame, png] of [
        [22, 'early.png'],
        [65, 'first.png'],
        [216, 'gap.png'],
      ] as const) {
        const metrics = compareRgb(raw(png), delivered.get(frame)!, {
          mean: 3,
          p95: 14,
          largePixelFraction: 0.08,
        });
        assert.ok(metrics.passed, JSON.stringify(metrics));
      }
      assert.deepEqual(pixel(active, 10, 150), pixel(gap, 10, 150));
      // The chart’s second progress pixel is filled at source frame 55 but not source frame 12.
      assert.ok(pixel(active, 218, 163)[1]! > 175);
      assert.ok(pixel(raw('early.png'), 218, 163)[1]! < 80);
      assert.ok(pixel(gap, 218, 163)[1]! < 100);
      assert.ok(pixel(active, 46, 53)[0]! > 130);
      assert.ok(pixel(active, 345, 18)[0]! > 160);
      assert.notDeepEqual(pixel(active, 90, 104), pixel(gap, 90, 104));

      const compiled = await compileVideo(source);
      const oldHash = compiled.build?.graphics?.card;
      const originalVisuals = (await compiled.resolveRender()).visualClips;
      const originalPlacement = originalVisuals.find(
        ({ clipId }) => clipId === 'card-placement',
      )?.graphic?.key;
      await writeFile(
        source,
        code(definition).replace('季度报告 · Results', '最新报告 · Updated'),
      );
      const newVisuals = (await (await compileVideo(source)).resolveRender())
        .visualClips;
      assert.notEqual(
        newVisuals.find(({ clipId }) => clipId === 'card-placement')?.graphic
          ?.key,
        originalPlacement,
      );
      await writeFile(source, code(definition));
      await writeFile(at('palette.ts'), "export const ink = '#ffd442';");
      const changed = await compileVideo(source);
      assert.notEqual(changed.build?.graphics?.card, oldHash);
      await previewVideo(compiled).frame(65, at('pinned.png'), {
        quality: 'quality',
      });
      assert.deepEqual(
        await readFile(at('pinned.png')),
        await readFile(at('first.png')),
      );
      const resources = await readFile(at('words.json'));
      await writeFile(at('words.json'), JSON.stringify({ mark: '新' }));
      assert.notEqual(
        (await compileVideo(source)).build?.graphics?.card,
        changed.build?.graphics?.card,
      );
      await writeFile(at('words.json'), resources);
      await writeFile(at('palette.ts'), "export const ink = '#f7fffa';");
      for (const name of ['card.css', 'emoji.ttf', 'icon.png']) {
        const previous = await readFile(at(name));
        // These inputs are content-fingerprinted before rendering reads them.
        await writeFile(at(name), Buffer.concat([previous, Buffer.from(' ')]));
        assert.notEqual(
          (await compileVideo(source)).build?.graphics?.card,
          oldHash,
          name,
        );
        await writeFile(at(name), previous);
      }

      await run(
        'preview',
        'contact-sheet',
        source,
        '--count',
        '4',
        '--output',
        at('sheet.png'),
      );
      await run(
        'preview',
        'clip',
        source,
        '--from',
        '20',
        '--to',
        '26',
        '--output',
        at('clip.mp4'),
      );
      const portable = await run('package', source, '--output', at('portable'));
      const verified = await run('package', 'verify', portable.directory);
      assert.equal(verified.manifest.version, 2);
      for (const dependency of [
        'Card.tsx',
        'palette.ts',
        'card.css',
        'emoji.ttf',
        'icon.png',
        'words.json',
      ])
        assert.ok(
          verified.manifest.files.some(
            ({ path }: { path: string }) => path === 'project/' + dependency,
          ),
        );
      await rename(at('Card.tsx'), at('Card.source'));
      await run(
        'preview',
        'frame',
        portable.entry,
        '--quality',
        'quality',
        '--frame',
        '65',
        '--output',
        at('offline.png'),
      );
      await rename(at('Card.source'), at('Card.tsx'));
      assert.deepEqual(
        await readFile(at('offline.png')),
        await readFile(at('first.png')),
      );

      const noChromium = {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: at('missing-browser-cache'),
      };
      await exec(
        process.execPath,
        [cli, 'render', plain, '--output', at('plain.mp4')],
        { ...options, env: noChromium },
      );
      const withoutGraphics = decodeFrames(
        at('plain.mp4'),
        [65],
        width,
        height,
      ).get(65)!;
      assert.deepEqual(
        pixel(withoutGraphics, 10, 150),
        pixel(delivered.get(65)!, 10, 150),
      );
      t.diagnostic(
        `cold CLI frame ${Math.round(firstMs)} ms, ten-second cached export ${Math.round(renderMs)} ms, warm picture reuse ${Math.round(reuseMs)} ms`,
      );
      if (process.env.OPENCUT_KEEP_GRAPHICS_FIXTURE === '1')
        t.diagnostic(output);
    } finally {
      if (process.env.OPENCUT_KEEP_GRAPHICS_FIXTURE !== '1')
        await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'cancelling a stalled Chromium graphic never publishes an MP4',
  { timeout: 25_000 },
  async () => {
    await mkdir(fixtureDirectory, { recursive: true });
    const directory = await mkdtemp(join(fixtureDirectory, 'graphics-cancel-'));
    try {
      const file = join(directory, 'cancel.video.ts');
      const output = join(directory, 'cancel.mp4');
      await writeFile(
        join(directory, 'Stall.tsx'),
        'export default function Stall() { for (;;) {} }',
      );
      await writeFile(
        file,
        code({
          canvas,
          assets: {
            stall: {
              kind: 'graphic',
              renderer: 'react',
              path: 'Stall.tsx',
              durationFrames: 10,
            },
          },
          tracks: [
            {
              type: 'video',
              clips: [{ asset: 'stall', at: 0, sourceOut: 10 }],
            },
          ],
        }),
      );
      const compiled = await compileVideo(file);
      const signal = AbortSignal.timeout(1500);
      await assert.rejects(
        renderCompiledVideo(compiled, output, { signal }),
        /cancel|abort|timeout/i,
      );
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a Chromium crash invalidates the surface and closes its tracked process',
  { timeout: 25_000 },
  async () => {
    const { compileReactGraphic, openReactGraphics } =
      await import('../../packages/graphics/dist/renderer.js');
    const directory = await mkdtemp(join(fixtureDirectory, 'graphics-crash-'));
    const component = join(directory, 'Graphic.jsx');
    let browserPid: number | undefined;
    let closed = false;
    const worker = openReactGraphics(
      () => readFile(readFont('NotoSansSC.ttf')),
      (pid) => {
        browserPid = pid;
        return () => {
          closed = true;
        };
      },
    );
    try {
      await writeFile(
        component,
        'export default function Graphic() { return <b>OpenCut</b>; }',
      );
      const bundle = await compileReactGraphic(component, {}, (path) =>
        readFile(path),
      );
      const request = {
        timing: {
          frame: 0,
          durationFrames: 4,
          frameRate: { numerator: 24, denominator: 1 },
          seconds: 0,
          width: 96,
          height: 64,
        },
        props: {},
      };
      let startedAfterClose = false;
      const closing = openReactGraphics(
        () => readFile(readFont('NotoSansSC.ttf')),
        () => {
          startedAfterClose = true;
          return () => {};
        },
      );
      const pending = closing.frame(bundle, request);
      await closing.close();
      await assert.rejects(pending, /graphics renderer is closed/i);
      assert.equal(startedAfterClose, false);

      await worker.frame(bundle, request);
      assert.ok(browserPid);
      process.kill(browserPid, 'SIGKILL');
      await assert.rejects(
        worker.frame(bundle, request),
        /Chromium graphics render failed/,
      );
      await worker.close();
      assert.ok(closed);
      assert.throws(() => process.kill(browserPid!, 0), { code: 'ESRCH' });
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
