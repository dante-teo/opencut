import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  previewClipSchema,
  previewFrameSchema,
  previewSheetSchema,
} from '@opencut/core';
import { requireTool, runTool } from '../../scripts/fixture-lib.js';
import { verifyVideoTimestamps } from '../desktop/t27-comparison.js';
import { decodeAudio } from '../desktop/t27-audio.js';

const root = fileURLToPath(new URL('../fixtures/generated/', import.meta.url));
const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
function decode(path: string, filter?: string) {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      path,
      '-an',
      ...(filter ? ['-vf', filter] : []),
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { maxBuffer: 64 * 1024 ** 2, timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  return result.stdout;
}
function meanError(a: Buffer, b: Buffer) {
  assert.equal(a.length, b.length);
  let error = 0;
  for (let i = 0; i < a.length; i++) error += Math.abs(a[i]! - b[i]!);
  return error / a.length;
}

test('T29 public CLI headless composition, contact sheet, synchronized range, safety and cleanup', async (t) => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't29-'));
  const project = join(directory, 'project.json');
  const source = join(directory, 'source.mp4');
  const overlay = join(directory, 'overlay.png');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120000,
    });
  const success = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    runTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      "color=red:s=160x96:r=30:d=3,drawbox=x=0:y=0:w=32:h=32:c=white:t=fill:enable='between(t,0.5,0.7)'",
      '-f',
      'lavfi',
      '-i',
      "sine=frequency=1000:sample_rate=48000:duration=3,volume='if(between(t,0.5,0.7),0.5,0)':eval=frame",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      source,
    ]);
    runTool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'color=lime@0.5:s=80x48,format=rgba',
      '-frames:v',
      '1',
      '-update',
      '1',
      overlay,
    ]);
    success(
      'project',
      'create',
      project,
      '--name',
      'T29 inspection',
      '--width',
      '160',
      '--height',
      '96',
    );
    const baseAsset = success('media', 'import', project, source).asset.id;
    const topAsset = success('media', 'import', project, overlay).asset.id;
    const baseTrack = success(
      'track',
      'add',
      project,
      '--name',
      'Base',
      '--type',
      'video',
    ).track.id;
    const topTrack = success(
      'track',
      'add',
      project,
      '--name',
      'Overlay',
      '--type',
      'video',
    ).track.id;
    const audioTrack = success(
      'track',
      'add',
      project,
      '--name',
      'Mix',
      '--type',
      'audio',
    ).track.id;
    success('canvas', 'set', project, '--background-color', '#102040');
    const clip = success(
      'clip',
      'add',
      project,
      baseAsset,
      '--track',
      baseTrack,
      '--at',
      '6',
      '--in',
      '3',
      '--out',
      '63',
      '--volume',
      '0.5',
    ).clip.id;
    success('clip', 'split', project, clip, '--at', '30');
    success(
      'clip',
      'add',
      project,
      topAsset,
      '--track',
      topTrack,
      '--at',
      '15',
      '--in',
      '0',
      '--out',
      '30',
      '--fit',
      'stretch',
      '--scale',
      '0.5',
      '--x',
      '20',
      '--opacity',
      '0.5',
    );
    success(
      'clip',
      'add',
      project,
      baseAsset,
      '--track',
      audioTrack,
      '--at',
      '6',
      '--in',
      '3',
      '--out',
      '63',
      '--volume',
      '0.25',
    );
    const original = await readFile(project);
    const originals = await Promise.all([source, overlay].map(hash));
    const inspected = success('project', 'inspect', project);
    assert.ok(inspected.revision > 0);
    assert.equal(inspected.clips.length, 4);
    const evaluated = success('timeline', 'inspect', project, '--frame', '20');
    assert.equal(evaluated.visualClips.length, 2);
    assert.equal(evaluated.mixingSources.length, 2);
    assert.deepEqual(evaluated.visualClips[0].sourceTime, {
      numerator: 17,
      denominator: 30,
    });

    await t.test(
      'lossless fully-composited PNG, layers, alpha and gaps',
      async () => {
        const report = previewFrameSchema.parse(
          success(
            'preview',
            'frame',
            project,
            '--frame',
            '20',
            '--output',
            'frame.png',
          ),
        );
        assert.equal(report.revision, inspected.revision);
        assert.equal(report.width, 160);
        assert.equal(report.height, 96);
        const rgb = decode(report.path);
        const pixel = (x: number, y: number) => [
          ...rgb.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3),
        ];
        assert.ok(
          pixel(100, 48)[0]! > 170 && pixel(100, 48)[0]! < 210,
          `Red blend ${pixel(100, 48)}`,
        );
        assert.ok(
          pixel(100, 48)[1]! > 45 && pixel(100, 48)[1]! < 85,
          `Green blend ${pixel(100, 48)}`,
        );
        assert.ok(
          pixel(4, 80)[0]! > 240 && pixel(4, 80)[1]! < 10,
          `Base ${pixel(4, 80)}`,
        );
        const gap = previewFrameSchema.parse(
          success(
            'preview',
            'frame',
            project,
            '--frame',
            '0',
            '--output',
            'gap.png',
          ),
        );
        const gapRGB = decode(gap.path);
        assert.ok(
          Math.abs(gapRGB[0]! - 16) < 3 &&
            Math.abs(gapRGB[1]! - 32) < 3 &&
            Math.abs(gapRGB[2]! - 64) < 3,
        );
        // Compare to the same saved timeline's production video export, independently decoded.
        const exported = run(
          'project',
          'render',
          project,
          '--output',
          'export.mp4',
        );
        assert.equal(exported.status, 0, exported.stderr);
        const exportFrame = decode(
          join(directory, 'export.mp4'),
          'select=eq(n\\,20)',
        );
        assert.ok(meanError(rgb, exportFrame) < 6);
      },
    );

    await t.test(
      'labeled contact sheet matches each independently requested exact frame',
      async () => {
        const sheet = previewSheetSchema.parse(
          success(
            'preview',
            'contact-sheet',
            project,
            '--from',
            '0',
            '--to',
            '66',
            '--count',
            '4',
            '--columns',
            '2',
            '--size',
            '160',
            '--output',
            'sheet.png',
          ),
        );
        assert.deepEqual(
          sheet.samples.map((sample) => sample.frame),
          [0, 21, 43, 65],
        );
        assert.equal(sheet.width, 320);
        assert.equal(sheet.height, 256);
        const label = decode(
          sheet.path,
          `crop=${sheet.tileWidth}:${sheet.labelHeight}:0:${sheet.tileHeight}`,
        );
        assert.ok(
          label.some((value) => value > 180),
          'Visible label glyphs',
        );
        for (const [index, sample] of sheet.samples.entries()) {
          const frame = previewFrameSchema.parse(
            success(
              'preview',
              'frame',
              project,
              '--frame',
              String(sample.frame),
              '--output',
              `sample${index}.png`,
            ),
          );
          const tile = decode(
            sheet.path,
            `crop=${sheet.tileWidth}:${sheet.tileHeight}:${sample.x}:${sample.y}`,
          );
          assert.equal(meanError(tile, decode(frame.path)), 0);
        }
      },
    );

    await t.test(
      'range video retains composition, project frame selection, audio gain and stored A/V PTS',
      async () => {
        const result = run(
          'preview',
          'clip',
          project,
          '--from',
          '12',
          '--to',
          '42',
          '--size',
          '160',
          '--quality',
          'high',
          '--output',
          'clip.mp4',
        );
        assert.equal(result.status, 0, result.stderr);
        assert.ok(
          result.stderr
            .trim()
            .split('\n')
            .every((line) => JSON.parse(line).event === 'progress'),
        );
        const report = previewClipSchema.parse(JSON.parse(result.stdout));
        assert.equal(report.frameCount, 30);
        assert.equal(report.durationSeconds, 1);
        verifyVideoTimestamps(report.path, report.frameRate, 30);
        decodeAudio(report.path);
        const preview = decode(report.path, 'select=eq(n\\,8)');
        assert.ok(meanError(preview, decode(join(directory, 'frame.png'))) < 6);
        const pcm = spawnSync(
          'ffmpeg',
          [
            '-v',
            'error',
            '-nostdin',
            '-i',
            report.path,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '48000',
            '-f',
            'f32le',
            'pipe:1',
          ],
          { maxBuffer: 4 * 1024 ** 2 },
        );
        assert.equal(pcm.status, 0, pcm.stderr.toString());
        const rms = (from: number, to: number) => {
          let energy = 0,
            count = 0;
          for (
            let i = Math.floor(from * 48000);
            i < Math.floor(to * 48000);
            i++
          ) {
            const value = pcm.stdout.readFloatLE(i * 4);
            energy += value * value;
            count++;
          }
          return Math.sqrt(energy / count);
        };
        // Source pulse at .5s, source-in .1s, timeline start .2s, range start .4s => .2s.
        assert.ok(rms(0.05, 0.15) < 0.002);
        assert.ok(rms(0.25, 0.35) > 0.02 && rms(0.25, 0.35) < 0.04);
        assert.ok(rms(0.5, 0.8) < 0.002);
      },
    );

    await t.test(
      'fractional frame ranges preserve exact timestamps and decoded frame identity',
      async () => {
        const fractional = join(directory, 'fractional.json');
        success(
          'project',
          'create',
          fractional,
          '--name',
          'Fractional',
          '--width',
          '96',
          '--height',
          '160',
          '--fps',
          '30000/1001',
        );
        const asset = success('media', 'import', fractional, source).asset.id;
        const track = success(
          'track',
          'add',
          fractional,
          '--name',
          'Video',
          '--type',
          'video',
        ).track.id;
        success(
          'clip',
          'add',
          fractional,
          asset,
          '--track',
          track,
          '--at',
          '0',
          '--in',
          '2',
          '--out',
          '62',
        );
        const result = previewClipSchema.parse(
          success(
            'preview',
            'clip',
            fractional,
            '--from',
            '7',
            '--to',
            '19',
            '--output',
            'fractional.mp4',
            '--size',
            '160',
          ),
        );
        assert.equal(result.frameCount, 12);
        verifyVideoTimestamps(result.path, result.frameRate, 12);
        decodeAudio(result.path);
        const portrait = previewSheetSchema.parse(
          success(
            'preview',
            'contact-sheet',
            fractional,
            '--count',
            '2',
            '--columns',
            '2',
            '--size',
            '64',
            '--output',
            'portrait-sheet.png',
          ),
        );
        assert.equal(portrait.cellWidth, 96);
        assert.ok(portrait.tileWidth < portrait.cellWidth);
        assert.equal(portrait.width, 192);
        const label = decode(
          portrait.path,
          `crop=${portrait.cellWidth}:${portrait.labelHeight}:0:${portrait.tileHeight}`,
        );
        assert.ok(label.some((value) => value > 180));
      },
    );

    await t.test(
      'existing outputs/symlinks, invalid ranges, missing tools/media and temporary cleanup',
      async () => {
        const before = await hash(join(directory, 'frame.png'));
        for (const action of ['frame', 'contact-sheet', 'clip']) {
          const args =
            action === 'frame'
              ? ['--frame', '20']
              : action === 'clip'
                ? ['--from', '12', '--to', '42']
                : ['--count', '2'];
          const output =
            action === 'frame'
              ? 'frame.png'
              : action === 'contact-sheet'
                ? 'sheet.png'
                : 'clip.mp4';
          const failure = run(
            'preview',
            action,
            project,
            ...args,
            '--output',
            output,
          );
          assert.equal(failure.status, 1, failure.stderr);
          assert.equal(failure.stdout, '');
          assert.equal(JSON.parse(failure.stderr).ok, false);
        }
        assert.equal(await hash(join(directory, 'frame.png')), before);
        const alias = join(directory, 'source-alias.png');
        await symlink(source, alias);
        assert.equal(
          run('preview', 'frame', project, '--frame', '20', '--output', alias)
            .status,
          1,
        );
        const missingTools = spawnSync(
          process.execPath,
          [
            entry,
            'preview',
            'frame',
            project,
            '--frame',
            '20',
            '--output',
            join(directory, 'no-tools.png'),
            '--json',
          ],
          { encoding: 'utf8', env: { ...process.env, PATH: '' } },
        );
        assert.equal(missingTools.status, 1);
        assert.match(JSON.parse(missingTools.stderr).error.message, /ffprobe/);
        const failedSheet = run(
          'preview',
          'contact-sheet',
          project,
          '--count',
          '2',
          '--output',
          'absent/sheet.png',
        );
        assert.equal(failedSheet.status, 1);
        // A missing referenced source must fail without publishing any partial sheet.
        await rm(overlay);
        const unavailable = run(
          'preview',
          'contact-sheet',
          project,
          '--count',
          '3',
          '--output',
          'offline.png',
        );
        assert.equal(unavailable.status, 1);
        assert.equal(unavailable.stdout, '');
        assert.ok(
          !(await readdir(directory)).some(
            (name) =>
              name.startsWith('.opencut-') ||
              name === 'offline.png' ||
              name === 'no-tools.png',
          ),
        );
        // Restore for byte-for-byte preservation checks below.
        runTool('ffmpeg', [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-f',
          'lavfi',
          '-i',
          'color=lime@0.5:s=80x48,format=rgba',
          '-frames:v',
          '1',
          '-update',
          '1',
          overlay,
        ]);
      },
    );
    assert.deepEqual(await readFile(project), original);
    assert.deepEqual(await Promise.all([source, overlay].map(hash)), originals);
    console.log(`T29 generated artifacts: ${directory}`);
  } finally {
    if (process.env.OPENCUT_T29_KEEP !== '1')
      await rm(directory, { recursive: true, force: true });
  }
});

test('T29 cancellation cleans contact-sheet temporary files before exit', async () => {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 't29-cancel-'));
  try {
    // Reuse only synthetic fixtures; make a long project so cancellation occurs during decoding.
    const project = join(directory, 'project.json');
    const source = join(root, 'video-medium.mp4');
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    cli(
      'project',
      'create',
      project,
      '--name',
      'Cancel',
      '--width',
      '1920',
      '--height',
      '1080',
    );
    const asset = cli('media', 'import', project, source).asset.id;
    const track = cli(
      'track',
      'add',
      project,
      '--name',
      'Video',
      '--type',
      'video',
    ).track.id;
    cli(
      'clip',
      'add',
      project,
      asset,
      '--track',
      track,
      '--at',
      '0',
      '--in',
      '0',
      '--out',
      '60',
    );
    const child = spawn(process.execPath, [
      entry,
      'preview',
      'contact-sheet',
      project,
      '--count',
      '16',
      '--output',
      join(directory, 'cancelled.png'),
      '--json',
    ]);
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    const closed = once(child, 'close');
    const deadline = Date.now() + 10000;
    while (
      !(await readdir(directory)).some((name) =>
        name.startsWith('.opencut-sheet-'),
      )
    ) {
      assert.ok(Date.now() < deadline, `No sheet started: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGTERM');
    assert.equal((await closed)[0], 143, stderr);
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr).ok, false);
    assert.ok(
      !(await readdir(directory)).some(
        (name) => name.startsWith('.opencut-') || name === 'cancelled.png',
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
