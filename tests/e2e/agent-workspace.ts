import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const generated = join(root, 'tests/fixtures/generated');
const sources = ['camera.mp4', 'music.wav', 'logo.png'] as const;

function run(cwd: string, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'buffer',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}

function checkedOutput(result: ReturnType<typeof run>) {
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

export function succeed(cwd: string, command: string, args: string[]) {
  return checkedOutput(run(cwd, command, args));
}

export async function prepareWorkspace() {
  try {
    assert.ok(
      (await lstat(generated)).isDirectory(),
      `Expected a fixture directory at ${generated}`,
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    succeed(root, process.execPath, [
      '--import',
      'tsx',
      'scripts/fixtures.ts',
      'generate',
    ]);
  }
  const directory = await mkdtemp(
    join(await realpath(generated), 't31-agent-'),
  );
  try {
    // Deploy the compiled packages with their production dependencies.
    succeed(root, 'pnpm', [
      '--offline',
      '--config.inject-workspace-packages=true',
      '--filter',
      '@opencut/cli',
      'deploy',
      '--prod',
      directory,
    ]);
    await symlink('dist/index.js', join(directory, 'opencut'), 'file');
    await cp(
      join(root, 'skills/video-editor'),
      join(directory, 'video-editor'),
      {
        recursive: true,
      },
    );
    await mkdir(join(directory, 'media'));
    const ffmpeg = (...args: string[]) =>
      succeed(directory, 'ffmpeg', ['-v', 'error', '-nostdin', ...args]);
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=160x90:r=30:d=3',
      '-vf',
      "drawbox=c=red:t=fill:enable='gte(t,1)'",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      'media/camera.mp4',
    );
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=3',
      'media/music.wav',
    );
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=yellow:s=160x90',
      '-frames:v',
      '1',
      '-threads',
      '1',
      'media/logo.png',
    );
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Apply this to both ESM and CommonJS resolution before the deployed entry
// point loads. Real paths also catch symlinks into the checkout.
const deployedModuleBoundary = `
  import { realpathSync } from 'node:fs';
  import { registerHooks } from 'node:module';
  import { isAbsolute, relative, sep } from 'node:path';
  import { fileURLToPath } from 'node:url';

  const workspace = realpathSync(process.cwd());
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolution = nextResolve(specifier, context);
      if (resolution.url.startsWith('file:')) {
        const path = relative(workspace, realpathSync(fileURLToPath(resolution.url)));
        if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
          throw new Error('Module resolves outside the deployed workspace: ' + specifier);
      }
      return resolution;
    },
  });
`;

export function runDeployedNode(directory: string, ...args: string[]) {
  return run(directory, process.execPath, [
    '--import',
    `data:text/javascript,${encodeURIComponent(deployedModuleBoundary)}`,
    ...args,
  ]);
}

export function succeedDeployedNode(directory: string, ...args: string[]) {
  return checkedOutput(runDeployedNode(directory, ...args)).toString();
}

export function cli(directory: string, ...args: string[]) {
  return succeedDeployedNode(directory, 'dist/index.js', '--json', ...args);
}

export async function sourceHashes(directory: string) {
  return Promise.all(
    sources.map(async (file) =>
      createHash('sha256')
        .update(await readFile(join(directory, 'media', file)))
        .digest('hex'),
    ),
  );
}

const pictureWidth = 160;
const pictureHeight = 90;
const frameBytes = pictureWidth * pictureHeight * 3;

function rgbAt(bytes: Buffer, frame: number, x: number, y: number) {
  const offset = frame * frameBytes + (y * pictureWidth + x) * 3;
  return [...bytes.subarray(offset, offset + 3)];
}

export function verifyDelivery(directory: string) {
  const artifact = (file: string) => resolve(directory, file);
  const project = artifact('cut.opencut.json');
  // Both the executable and its working directory belong to the checkout.
  const command = (...args: string[]) =>
    JSON.parse(
      succeed(root, process.execPath, [
        join(root, 'apps/cli/dist/index.js'),
        '--json',
        ...args,
      ]).toString(),
    );
  const inspected = command('project', 'inspect', project);
  assert.deepEqual(inspected.duration, { numerator: 2, denominator: 1 });
  assert.deepEqual(inspected.settings.frameRate, {
    numerator: 30,
    denominator: 1,
  });
  assert.equal(inspected.assets.length, 3);
  assert.equal(inspected.tracks.length, 3);
  assert.equal(inspected.clips.length, 4);
  const inspectAt = (frame: number) =>
    command('timeline', 'inspect', project, '--frame', String(frame));
  const before = inspectAt(29);
  const cut = inspectAt(30);
  assert.notEqual(before.visualClips[0].id, cut.visualClips[0].id);
  assert.deepEqual(inspectAt(0).visualClips[0].sourceTime, {
    numerator: 1,
    denominator: 2,
  });
  assert.deepEqual(cut.visualClips[0].sourceTime, {
    numerator: 3,
    denominator: 2,
  });
  assert.equal(inspectAt(14).visualClips.length, 1);
  assert.equal(inspectAt(15).visualClips.length, 2);
  assert.equal(inspectAt(44).visualClips.length, 2);
  assert.equal(inspectAt(45).visualClips.length, 1);
  assert.equal(cut.visualClips[1].kind, 'image');
  const { scale, x, y } = cut.visualClips[1].visual;
  assert.deepEqual({ scale, x, y }, { scale: 0.25, x: 0, y: 0 });
  assert.equal(cut.mixingSources.length, 1);
  assert.equal(cut.mixingSources[0].effectiveVolume, 0.25);
  assert.equal(inspectAt(60).boundary, 'end');
  command('project', 'validate', project);

  const video = command('probe', artifact('final.mp4'));
  assert.equal(video.video.codec, 'h264');
  assert.equal(video.video.frameRateRatio, '30/1');
  assert.equal(video.audio.codec, 'aac');
  assert.equal(video.video.width, pictureWidth);
  assert.equal(video.video.height, pictureHeight);
  assert.equal(video.durationSeconds, 2);
  const review = command('probe', artifact('review.png'));
  assert.equal(review.video.codec, 'png');
  assert.equal(review.video.width, pictureWidth);
  assert.equal(review.video.height, pictureHeight);
  const decode = (file: string, ...options: string[]) =>
    succeed(root, 'ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-nostdin',
      '-i',
      artifact(file),
      ...options,
      'pipe:1',
    ]);
  const frames = (file: string) =>
    decode(file, '-map', '0:v:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo');
  const rgb = frames('final.mp4');
  assert.equal(rgb.length, 60 * frameBytes);
  const reviewRgb = frames('review.png');
  assert.equal(reviewRgb.length, frameBytes);
  const red = (r = 0, g = 0, b = 0) => r > 220 && g < 35 && b < 35;
  const yellow = (r = 0, g = 0, b = 0) => r > 220 && g > 220 && b < 35;
  const blue = (r = 0, g = 0, b = 0) => r < 35 && g < 35 && b > 220;
  assert.ok(blue(...rgbAt(rgb, 14, 80, 45)));
  for (const frame of [15, 30, 44])
    assert.ok(yellow(...rgbAt(rgb, frame, 80, 45)));
  assert.ok(red(...rgbAt(rgb, 45, 80, 45)));
  assert.ok(red(...rgbAt(rgb, 30, 8, 8)));
  for (const [bytes, frame] of [
    [rgb, 30],
    [reviewRgb, 0],
  ] as const) {
    for (const [x, y] of [
      [64, 45],
      [96, 45],
      [80, 37],
      [80, 52],
    ] as const)
      assert.ok(
        yellow(...rgbAt(bytes, frame, x, y)),
        `Expected centered logo at (${x}, ${y})`,
      );
    for (const [x, y] of [
      [56, 45],
      [104, 45],
      [80, 31],
      [80, 58],
    ] as const)
      assert.ok(
        red(...rgbAt(bytes, frame, x, y)),
        `Expected background outside centered logo at (${x}, ${y})`,
      );
  }
  const pcm = decode(
    'final.mp4',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
  );
  assert.ok(Math.abs(pcm.length / 4 - 96_000) < 1024);
  const samples = 2400;
  for (const start of [480, 48_000, 93_120]) {
    let real = 0;
    let imaginary = 0;
    for (let i = 0; i < samples; i++) {
      const sample = pcm.readFloatLE((start + i) * 4);
      const phase = (2 * Math.PI * i * 880) / 48000;
      real += sample * Math.cos(phase);
      imaginary += sample * Math.sin(phase);
    }
    const amplitude = (2 * Math.hypot(real, imaginary)) / samples;
    assert.ok(
      amplitude > 0.02 && amplitude < 0.05,
      `880 Hz amplitude: ${amplitude}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, directory] = process.argv.slice(2);
  if (action === 'prepare' && !directory) {
    console.log(await prepareWorkspace());
  } else if (action === 'verify' && directory) {
    verifyDelivery(directory);
    console.log(
      'Verified project, composited PNG, 60 decoded frames and AAC mix.',
    );
  } else {
    throw new Error('Usage: agent-workspace.ts prepare | verify <workspace>');
  }
}
