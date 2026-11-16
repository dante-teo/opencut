import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readSubtitleFile } from '@opencut/sdk';
import { requireTool } from '../../scripts/fixture-lib.js';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

test('a TypeScript definition renders without loading Electron, sessions or the durable queue', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(
    join(fixtureDirectory, 'definition-runtime-'),
  );
  const entry = resolve('apps/cli/dist/index.js');
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        // SQLite backs foreground leases; the retired queue itself must stay unloaded.
        if (specifier === 'electron' ||
          /\\/(?:legacy|project-files|project-writer|session-transport|editing|local-jobs|job-store|job-worker)\\.js$/.test(resolved.url)) {
          throw new Error('Foreground render loaded compatibility code: ' + resolved.url);
        }
        return resolved;
      },
    });
  `;
  try {
    const source = videoExample('showcase.video.ts');
    const output = join(directory, 'showcase.mp4');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' + encodeURIComponent(guard),
        entry,
        'render',
        source,
        '--output',
        output,
        '--json',
      ],
      { encoding: 'utf8', cwd: directory, timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).frameCount, 480);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'definition render honors output controls and preserves existing files on failure or cancellation',
  { timeout: 45_000 },
  async () => {
    requireTool('ffmpeg');
    requireTool('ffprobe');
    const directory = await mkdtemp(
      join(fixtureDirectory, 'definition-output-'),
    );
    const entry = resolve('apps/cli/dist/index.js');
    const source = videoExample('showcase.video.ts');
    const output = join(directory, 'export.mp4');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [entry, ...args, '--json'], {
        encoding: 'utf8',
        timeout: 30_000,
      });
    try {
      const sidecar = join(directory, 'captions.vtt');
      const captionSource = join(directory, 'captioned.video.ts');
      await writeFile(
        captionSource,
        `export default ${JSON.stringify({
          canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 24 },
          tracks: [],
          subtitles: {
            style: {},
            cues: [
              {
                id: 'cue',
                text: 'A caption',
                start: { numerator: 0, denominator: 1 },
                end: { numerator: 1, denominator: 1 },
              },
            ],
          },
        })};\n`,
      );
      const captions = run(
        'subtitles',
        'export',
        captionSource,
        '--output',
        sidecar,
      );
      assert.equal(captions.status, 0, captions.stderr);
      const { cues } = await readSubtitleFile(sidecar);
      assert.equal(cues.length, JSON.parse(captions.stdout).cueCount);
      assert.ok(cues.length > 0);

      const sentinel = Buffer.from('existing delivery');
      await writeFile(output, sentinel);
      const attempt = run('render', source, '--output', output);
      assert.equal(attempt.status, 1, attempt.stderr);
      assert.match(attempt.stderr, /Refusing to overwrite/);
      assert.deepEqual(await readFile(output), sentinel);

      const child = spawn(
        process.execPath,
        [entry, 'render', source, '--output', output, '--overwrite'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      try {
        let diagnostics = '';
        child.stderr.setEncoding('utf8');
        let cancelled = false;
        child.stderr.on('data', (chunk: string) => {
          diagnostics += chunk;
          if (!cancelled && diagnostics.includes('rendering:')) {
            cancelled = true;
            child.kill('SIGTERM');
          }
        });
        const [code] = await once(child, 'close', {
          signal: AbortSignal.timeout(25_000),
        });
        assert.equal(code, 143, diagnostics);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
      assert.deepEqual(await readFile(output), sentinel);
      assert.deepEqual((await readdir(directory)).sort(), [
        'captioned.video.ts',
        'captions.vtt',
        'export.mp4',
      ]);

      const recovered = run(
        'render',
        source,
        '--output',
        output,
        '--overwrite',
        '--quality',
        'fast',
        '--width',
        '160',
        '--height',
        '90',
        '--fps',
        '12',
        '--audio-rate',
        '44100',
        '--audio-channels',
        '1',
        '--no-subtitles',
      );
      assert.equal(recovered.status, 0, recovered.stderr);
      const result = JSON.parse(recovered.stdout);
      assert.equal(result.frameCount, 240);
      assert.equal(result.width, 160);
      assert.equal(result.height, 90);
      assert.equal(result.metadata.audio.sampleRate, 44100);
      assert.equal(result.metadata.audio.channels, 1);
      assert.notDeepEqual(await readFile(output), sentinel);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('explicit overwrite refuses a declared but unused media input', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  const directory = await mkdtemp(join(fixtureDirectory, 'definition-input-'));
  const asset = join(directory, 'unused.mp4');
  const source = join(directory, 'guard.video.ts');
  try {
    await copyFile(join(fixtureDirectory, 'video-short.mp4'), asset);
    const before = await readFile(asset);
    await writeFile(
      source,
      `export default ${JSON.stringify({
        canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 24 },
        tracks: [],
        assets: { unused: { path: 'unused.mp4', kind: 'video' } },
      })};\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve('apps/cli/dist/index.js'),
        'render',
        source,
        '--output',
        asset,
        '--overwrite',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /must not replace input/);
    assert.deepEqual(await readFile(asset), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
