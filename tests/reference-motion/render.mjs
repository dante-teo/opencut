import process from 'node:process';
import * as console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const from = (path) => fileURLToPath(new URL(path, import.meta.url));
const scratch = from('../fixtures/generated/reference-motion/');
const dist = join(scratch, 'remotion');
const browserExecutable = process.env.OPENCUT_REFERENCE_CHROMIUM;
if (!browserExecutable)
  throw new Error(
    'Set OPENCUT_REFERENCE_CHROMIUM to the pinned Chromium executable.',
  );
const targets = {
  FieldNotes: [0, 45, 164, 239, 240, 359, 360, 539, 540, 689, 690, 899],
  Prism: [0, 14, 28, 61, 89, 314, 315, 330, 344, 345, 450, 599],
  Waterline: [0, 50, 100, 180, 250, 300, 355, 390, 470, 599],
  Signal: [0, 14, 15, 44, 45, 75, 134, 135, 255, 449],
  Relay: [0, 24, 74, 148, 149, 150, 189, 224, 274, 299],
  Parallax: [0, 30, 65, 100, 150, 200, 230, 265, 299],
};
const variants = {
  WaterlineAlt: ['Waterline', { values: [35, 55, 65, 80] }],
  SignalAlt: ['Signal', { pitch: 880 }],
};
const names = process.argv.slice(2);
if (!names.length)
  names.push(...Object.keys(targets), ...Object.keys(variants));
for (const name of names)
  if (!(name in targets || name in variants))
    throw new Error('Unknown composition ' + name);

await mkdir(dist, { recursive: true });
const serveUrl = await bundle({
  entryPoint: from('./reference.jsx'),
  publicDir: join(scratch, 'assets'),
  outDir: join(dist, 'site'),
  onProgress: () => {},
});
for (const name of names) {
  const [id, inputProps] = variants[name] ?? [name, {}];
  const chromiumOptions = { gl: id === 'Parallax' ? 'angle' : undefined };
  const composition = await selectComposition({
    serveUrl,
    id,
    inputProps,
    browserExecutable,
    chromiumOptions,
  });
  const outputLocation = join(dist, name + '.mp4');
  if (!(await stat(outputLocation).catch(() => false))) {
    console.error('Rendering ' + name);
    let last = -1;
    await renderMedia({
      codec: 'h264',
      imageFormat: 'png',
      pixelFormat: 'yuv420p',
      x264Preset: 'fast',
      concurrency: 2,
      composition,
      serveUrl,
      inputProps,
      outputLocation,
      browserExecutable,
      chromiumOptions,
      overwrite: false,
      onProgress: ({ progress }) => {
        const checkpoint = Math.floor(progress * 10) * 10;
        if (checkpoint !== last)
          console.error(name + ' ' + (last = checkpoint) + '%');
      },
    });
  }
  const indices = targets[id];
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      outputLocation,
      '-vf',
      'select=' +
        indices.map((n) => 'eq(n\\,' + n + ')').join('+') +
        ',scale=320:-2,tile=4x' +
        Math.ceil(indices.length / 4),
      '-frames:v',
      '1',
      join(dist, name + '-boundaries.png'),
    ],
    { stdio: 'inherit' },
  );
  console.log(outputLocation);
}
