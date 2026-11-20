import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareRgb, decodeFrames } from './media-comparison.js';
import { fixtureDirectory } from '../fixture-paths.js';

const exec = promisify(execFile);
const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const canvas = { width: 160, height: 90, frameRate: 12, durationFrames: 12 };
async function fixture(t: { after(cleanup: () => Promise<void>): void }) {
  await mkdir(fixtureDirectory, { recursive: true });
  const d = await mkdtemp(join(fixtureDirectory, 'graphics-release-check-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return (name: string) => join(d, name);
}
function run(args: string[], env = process.env) {
  return exec(process.execPath, [cli, ...args], { timeout: 60_000, env });
}

test('static SVG text and declared fonts export and relocate without Chromium', async (t) => {
  const at = await fixture(t);
  const source = at('test.video.ts');
  await writeFile(
    at('Label.svg'),
    `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">
      <text x="80" y="35" text-anchor="middle" fill="white" font-size="18">中文 OpenCut</text>
      <text x="80" y="65" text-anchor="middle" fill="#f0c678" font-family="Icons" font-size="18">📊</text>
    </svg>`,
  );
  await copyFile(
    new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
    at('emoji.ttf'),
  );
  await writeFile(
    source,
    'export default ' +
      JSON.stringify({
        canvas,
        assets: {
          title: {
            kind: 'graphic',
            renderer: 'svg',
            path: 'Label.svg',
            fonts: { Icons: 'emoji.ttf' },
          },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'title', at: 0, duration: 12 }] },
        ],
      }),
  );
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: at('no-browser') };
  await run(
    [
      'preview',
      'frame',
      source,
      '--frame',
      '5',
      '--quality',
      'quality',
      '-o',
      at('preview.png'),
    ],
    env,
  );
  await run(['package', source, '-o', at('bundle')], env);
  await rename(at('bundle'), at('relocated'));
  await rm(at('emoji.ttf'));
  await run(
    ['render', at('relocated/opencut.bundle.video.ts'), '-o', at('final.mp4')],
    env,
  );
  const preview = decodeFrames(at('preview.png'), [0], 160, 90).get(0)!;
  const final = decodeFrames(at('final.mp4'), [5], 160, 90).get(5)!;
  assert.ok(preview.some((channel) => channel > 240));
  assert.ok(
    compareRgb(preview, final, { mean: 3, p95: 14, largePixelFraction: 0.08 })
      .passed,
  );
  await writeFile(at('relocated/project/emoji.ttf'), 'invalid');
  await assert.rejects(
    run(['package', 'verify', at('relocated')], env),
    /integrity check failed/,
  );
});

test('render failures map back to imported TS source in authored and portable graphics', async (t) => {
  const at = await fixture(t);
  const source = at('test.video.ts');
  await writeFile(
    at('Card.tsx'),
    "import { fail } from './helper';\nexport default function Card() { return <div>{fail()}</div>; }\n",
  );
  await writeFile(
    at('helper.ts'),
    "export function fail(): never {\n  throw new Error('mapped example');\n}\n",
  );
  await writeFile(
    source,
    'export default ' +
      JSON.stringify({
        canvas,
        assets: {
          card: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Card.tsx',
            durationFrames: 12,
          },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'card', at: 0, sourceOut: 12 }] },
        ],
      }),
  );
  await run(['validate', source]);
  await run(['package', source, '-o', at('bundle')]);
  await rename(at('bundle'), at('portable'));
  assert.match(
    await readFile(at('portable/graphics/notices.txt'), 'utf8'),
    /react@/,
  );
  for (const definition of [source, at('portable/opencut.bundle.video.ts')]) {
    await assert.rejects(
      run([
        'preview',
        'frame',
        definition,
        '--frame',
        '2',
        '-o',
        at('failed.png'),
      ]),
      (error: Error) =>
        /source frame 2/.test(error.message) &&
        /mapped example/.test(error.message) &&
        /helper\.ts:2:\d+/.test(error.message),
    );
  }
  assert.ok(!(await readdir(at('.'))).includes('failed.png'));
});

test('React packages preserve reserved and case-distinct asset IDs', async (t) => {
  const at = await fixture(t);
  const source = at('test.video.ts');
  await writeFile(at('Card.tsx'), 'export default () => <b>ready</b>;');
  const asset = {
    kind: 'graphic',
    renderer: 'react',
    path: 'Card.tsx',
    durationFrames: 12,
  };
  await writeFile(
    source,
    'export default ' +
      JSON.stringify({
        canvas,
        assets: { con: asset, CON: asset },
        tracks: [
          {
            type: 'video',
            clips: [
              { asset: 'con', at: 0, sourceOut: 6 },
              { asset: 'CON', at: 6, sourceOut: 6 },
            ],
          },
        ],
      }),
  );
  await run(['package', source, '-o', at('bundle')]);
  await run(['package', 'verify', at('bundle')]);
  const manifest = JSON.parse(
    await readFile(at('bundle/opencut-package.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(manifest.graphics).sort(), ['CON', 'con']);
});

test('Chromium readiness agrees with launch in a shell-only cache', async (t) => {
  const at = await fixture(t);
  const doctor = async (env?: NodeJS.ProcessEnv) =>
    JSON.parse((await run(['doctor', '--json'], env)).stdout).graphics;
  const browser = await doctor();
  assert.equal(browser.status, 'available');
  assert.match(basename(browser.path), /^chrome-headless-shell(?:\.exe)?$/);
  const shell = dirname(dirname(browser.path));
  const shellCache = at('shell-only');
  await mkdir(shellCache);
  await symlink(shell, join(shellCache, basename(shell)), 'junction');
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: shellCache };
  assert.equal((await doctor(env)).status, 'available');

  const source = at('test.video.ts');
  await writeFile(at('Card.tsx'), 'export default () => <b>ready</b>;');
  await writeFile(
    source,
    'export default ' +
      JSON.stringify({
        canvas,
        assets: {
          card: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Card.tsx',
            durationFrames: 12,
          },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'card', at: 0, sourceOut: 12 }] },
        ],
      }),
  );
  await run(
    ['preview', 'frame', source, '--frame', '0', '-o', at('shell.png')],
    env,
  );

  const full = shell.replace(/chromium_headless_shell-(\d+)$/, 'chromium-$1');
  await t.test(
    'a full Chromium cache without the shell reports missing',
    async (fullOnly) => {
      if (
        !(await access(full).then(
          () => true,
          () => false,
        ))
      ) {
        fullOnly.skip('Full Chromium is not installed.');
        return;
      }
      const fullCache = at('full-only');
      await mkdir(fullCache);
      await symlink(full, join(fullCache, basename(full)), 'junction');
      assert.equal(
        (await doctor({ ...env, PLAYWRIGHT_BROWSERS_PATH: fullCache })).status,
        'missing-browser',
      );
    },
  );
});

test('direct templates validate asset defaults and placement overrides without a browser', async (t) => {
  const at = await fixture(t);
  const source = at('test.video.ts');
  const write = (props: object, override?: object) =>
    writeFile(
      source,
      'export default ' +
        JSON.stringify({
          canvas,
          assets: {
            chart: {
              kind: 'graphic',
              renderer: 'react',
              path: 'Chart.tsx',
              durationFrames: 12,
              props,
            },
          },
          tracks: [
            {
              type: 'video',
              clips: [
                { asset: 'chart', at: 0, sourceOut: 12, props: override },
              ],
            },
          ],
        }),
    );
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: at('no-browser') };
  await write({ data: [{ label: '错误', value: 'wrong' }] });
  for (const component of [
    "export { BarChart as default } from '@opencut/graphics/templates';",
    "export { Chart as default };\nimport { BarChart as Chart } from '@opencut/graphics/templates';",
  ]) {
    await writeFile(at('Chart.tsx'), component);
    await assert.rejects(
      run(['validate', source], env),
      /assets\.chart\.props: BarChart props: data\.0\.value/,
    );
  }
  await write({ data: [] }, { title: 42 });
  await assert.rejects(
    run(['validate', source], env),
    /tracks\.0\.clips\.0\.props: BarChart props: title/,
  );
  await assert.rejects(
    run(['package', source, '-o', at('invalid')], env),
    /BarChart props: title/,
  );
  await write({ theme: 'light', data: [] }, { title: '中文 English' });
  await run(['validate', source], env);
  await run([
    'preview',
    'frame',
    source,
    '--frame',
    '6',
    '-o',
    at('valid.png'),
  ]);
});

test('single-frame preview skips other frames and a renderer deadline removes staging', async (t) => {
  const at = await fixture(t);
  const source = at('test.video.ts');
  await writeFile(
    at('Card.tsx'),
    `import { useGraphicFrame } from '@opencut/graphics/react';
    export default function Card() { if (useGraphicFrame() !== 0) for (;;) {} return <b>ready</b>; }`,
  );
  await writeFile(
    source,
    'export default ' +
      JSON.stringify({
        canvas,
        assets: {
          card: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Card.tsx',
            durationFrames: 12,
          },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'card', at: 0, sourceOut: 12 }] },
        ],
      }),
  );
  await run([
    'preview',
    'frame',
    source,
    '--frame',
    '0',
    '-o',
    at('ready.png'),
  ]);
  await assert.rejects(
    run(['render', source, '-o', at('failed.mp4')]),
    /source frame 1: Graphics frame timed out/,
  );
  assert.deepEqual(
    (await readdir(at('.'))).filter(
      (name) => name.startsWith('.opencut-') || name.endsWith('.mp4'),
    ),
    [],
  );
});
