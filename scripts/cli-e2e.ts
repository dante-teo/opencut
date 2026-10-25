import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtures, requireTool, validateFixture } from './fixture-lib.js';
import type { Probe } from './fixture-lib.js';

// Every project read/edit goes through the built public executable in a fresh process.
// Native tools below are independent output oracles, never project-building shortcuts.
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'apps/cli/dist/index.js');
const generated = join(root, 'tests/fixtures/generated');
const keep = process.argv.slice(2).includes('--keep');
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--keep'),
  'Usage: pnpm e2e [--keep]',
);
const hash = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const fixtureHashes = () =>
  Promise.all(fixtures.map((fixture) => hash(join(generated, fixture.file))));
interface History {
  revision: number;
  undo: unknown[];
  redo: unknown[];
}
interface Clip {
  id: string;
  sourceIn: Time;
  sourceOut: Time;
  timelineStart: Time;
  timelineEnd: Time;
  visual?: unknown;
}
interface Time {
  numerator: number;
  denominator: number;
}
interface Timeline {
  duration: Time;
  tracks: { id: string; type: string; clips: Clip[] }[];
}
const seconds = (time: Time) => time.numerator / time.denominator;

function tool(tool: string, args: string[]): Buffer {
  const result = spawnSync(tool, args, {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${tool}: ${result.stderr.toString()}`);
  assert.equal(result.stderr.length, 0, result.stderr.toString());
  return result.stdout;
}

async function main() {
  requireTool('ffmpeg');
  requireTool('ffprobe');
  // Reuse the fixture generator, exclusively creating its directory on a clean checkout.
  try {
    await lstat(generated);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    tool(process.execPath, [
      '--import',
      'tsx',
      join(root, 'scripts/fixtures.ts'),
      'generate',
    ]);
  }
  for (const fixture of fixtures)
    validateFixture(fixture, join(generated, fixture.file));
  const before = await fixtureHashes();
  const directory = await mkdtemp(join(generated, 't14-e2e-'));
  const project = join(directory, 'project.opencut.json');
  const output = join(directory, 'final.mp4');
  const transcript: unknown[] = [];
  let succeeded = false;
  const invoke = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    transcript.push({
      argv: args,
      pid: result.pid,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    assert.ifError(result.error);
    return result;
  };
  const json = <T>(...args: string[]): T => {
    const result = invoke(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as T;
  };
  const history = () => json<History>('edit', 'history', project);
  const timeline = () => json<Timeline>('timeline', 'list', project);
  const edit = (...args: string[]) => {
    json(...args);
    return history();
  };
  try {
    json(
      'project',
      'create',
      project,
      '--name',
      'T14 CLI end-to-end',
      '--width',
      '320',
      '--height',
      '180',
      '--fps',
      '30',
    );
    assert.deepEqual(history(), {
      path: project,
      revision: 0,
      undo: [],
      redo: [],
    });
    const assets: string[] = [];
    for (const name of [
      'video-medium.mp4',
      'video-long.mp4',
      'audio-tone.wav',
      'still.png',
    ]) {
      const result = json<{ imported: boolean; asset: { id: string } }>(
        'media',
        'import',
        project,
        join(generated, name),
      );
      assert.equal(result.imported, true);
      assets.push(result.asset.id);
    }
    const [medium, long, music, image] = assets as [
      string,
      string,
      string,
      string,
    ];
    const duplicate = json<{ imported: boolean; asset: { id: string } }>(
      'media',
      'import',
      project,
      join(generated, 'video-medium.mp4'),
    );
    assert.equal(duplicate.imported, false);
    assert.equal(duplicate.asset.id, medium);
    assert.equal(
      json<{ assets: unknown[] }>('media', 'list', project).assets.length,
      4,
    );
    const track = (type: string, name: string) =>
      json<{ track: { id: string } }>(
        'track',
        'add',
        project,
        '--type',
        type,
        '--name',
        name,
      ).track.id;
    const videoTrack = track('video', 'Main video');
    const overlayTrack = track('video', 'Image overlay');
    const musicTrack = track('audio', 'Background music');
    edit('canvas', 'set', project, '--background-color', '#123048');
    const add = (
      asset: string,
      trackId: string,
      at: number,
      sourceIn: number,
      sourceOut: number,
      ...flags: string[]
    ) =>
      json<{ clip: Clip }>(
        'clip',
        'add',
        project,
        asset,
        '--track',
        trackId,
        '--at',
        String(at),
        '--in',
        String(sourceIn),
        '--out',
        String(sourceOut),
        ...flags,
      ).clip;
    const opening = add(medium, videoTrack, 0, 0, 90, '--volume', '0.6');
    edit('clip', 'trim', project, opening.id, '--in', '15', '--out', '75');
    const split = json<{ left: Clip; right: Clip }>(
      'clip',
      'split',
      project,
      opening.id,
      '--at',
      '30',
    );
    assert.equal(split.left.id, opening.id);
    assert.equal(seconds(split.left.sourceOut), 1.5);
    assert.equal(seconds(split.right.sourceIn), 1.5);
    edit('clip', 'move', project, split.right.id, '--at', '60');
    const transformed = add(long, videoTrack, 90, 0, 150, '--volume', '0.6');
    edit(
      'clip',
      'visual',
      project,
      transformed.id,
      '--fit',
      'stretch',
      '--scale',
      '0.5',
      '--x=-40',
    );
    add(long, videoTrack, 240, 0, 150, '--volume', '0.6');
    add(long, videoTrack, 390, 0, 150, '--volume', '0.6');
    const overlay = add(
      image,
      overlayTrack,
      120,
      0,
      60,
      '--fit',
      'stretch',
      '--scale',
      '0.5',
      '--x',
      '40',
      '--opacity',
      '0.5',
    );
    for (const [at, end] of [
      [0, 120],
      [120, 120],
      [240, 120],
      [360, 120],
      [480, 60],
    ])
      add(music, musicTrack, at!, 0, end!, '--volume', '0.25');

    // Persisted output, rejected edits, dry-run, undo/no-op/redo are all reloaded in separate processes.
    const arranged = timeline();
    assert.equal(seconds(arranged.duration), 18);
    assert.deepEqual(
      arranged.tracks.map((t) => [t.type, t.clips.length]),
      [
        ['video', 5],
        ['video', 1],
        ['audio', 5],
      ],
    );
    assert.deepEqual(
      arranged.tracks[0]!.clips.map((c) => [
        seconds(c.timelineStart),
        seconds(c.timelineEnd),
        seconds(c.sourceIn),
        seconds(c.sourceOut),
      ]),
      [
        [0, 1, 0.5, 1.5],
        [2, 3, 1.5, 2.5],
        [3, 8, 0, 5],
        [8, 13, 0, 5],
        [13, 18, 0, 5],
      ],
    );
    const saved = await readFile(project, 'utf8');
    const previousHistory = history();
    const overlap = invoke(
      'clip',
      'move',
      project,
      split.right.id,
      '--at',
      '0',
    );
    assert.equal(overlap.status, 1);
    assert.equal(overlap.stdout, '');
    assert.equal(await readFile(project, 'utf8'), saved);
    edit(
      'clip',
      'visual',
      project,
      overlay.id,
      '--opacity',
      '0.8',
      '--dry-run',
      '--expected-revision',
      String(previousHistory.revision),
    );
    assert.equal(await readFile(project, 'utf8'), saved);
    assert.deepEqual(history(), previousHistory);
    const changed = edit(
      'clip',
      'visual',
      project,
      overlay.id,
      '--opacity',
      '0.8',
      '--expected-revision',
      String(previousHistory.revision),
    );
    const undone = edit(
      'edit',
      'undo',
      project,
      '--expected-revision',
      String(changed.revision),
    );
    assert.deepEqual(timeline(), arranged);
    const undoneBytes = await readFile(project, 'utf8');
    edit('clip', 'move', project, opening.id, '--at', '0');
    assert.equal(await readFile(project, 'utf8'), undoneBytes);
    assert.equal(history().redo.length, 1);
    const redone = edit(
      'edit',
      'redo',
      project,
      '--expected-revision',
      String(undone.revision),
    );
    assert.equal(
      (timeline().tracks[1]!.clips[0]!.visual as { opacity: number }).opacity,
      0.8,
    );
    edit(
      'edit',
      'undo',
      project,
      '--expected-revision',
      String(redone.revision),
    );
    assert.deepEqual(timeline(), arranged);
    assert.equal(history().revision, previousHistory.revision + 4);
    const valid = json<{ valid: boolean; structureValid: boolean }>(
      'project',
      'validate',
      project,
    );
    assert.equal(valid.valid, true);
    assert.equal(valid.structureValid, true);
    json('project', 'info', project);
    const beforeRender = await readFile(project, 'utf8');
    const render = invoke(
      'project',
      'render',
      project,
      '--output',
      output,
      '--quality',
      'balanced',
    );
    assert.equal(render.status, 0, render.stderr);
    assert.equal(render.stderr, '');
    const events = render.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            frameCount?: number;
            durationSeconds?: number;
          },
      );
    assert.ok(events.some((event) => event.event === 'progress'));
    assert.equal(events.at(-1)!.event, 'completed');
    assert.equal(events.at(-1)!.frameCount, 540);
    assert.equal(events.at(-1)!.durationSeconds, 18);
    assert.equal(await readFile(project, 'utf8'), beforeRender);

    const probe = JSON.parse(
      tool('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        output,
      ]).toString(),
    ) as Probe;
    const video = probe.streams!.find(
      (stream) => stream.codec_type === 'video',
    )!;
    const audio = probe.streams!.find(
      (stream) => stream.codec_type === 'audio',
    )!;
    assert.equal(probe.streams!.length, 2);
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.equal(video.avg_frame_rate, '30/1');
    assert.equal(Number(video.nb_read_frames), 540);
    assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.sample_rate, '48000');
    assert.equal(audio.channels, 2);
    for (const duration of [
      probe.format!.duration,
      video.duration,
      audio.duration,
    ])
      assert.ok(Math.abs(Number(duration) - 18) < 0.002);
    for (const stream of probe.streams!)
      assert.ok(Math.abs(Number(stream.start_time)) < 0.001);
    tool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-i',
      output,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ]);

    const raw = (file: string, frame: number, width: number, height: number) =>
      tool('ffmpeg', [
        '-v',
        'error',
        '-nostdin',
        '-xerror',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${frame}),scale=${width}:${height}`,
        '-frames:v',
        '1',
        '-an',
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
    const frames = new Map<number, Buffer>();
    const extracted: string[] = [];
    for (const frame of [15, 45, 75, 105, 135, 195, 525]) {
      const png = join(
        directory,
        `frame-${String(frame).padStart(3, '0')}.png`,
      );
      json(
        'extract-frame',
        output,
        '--timestamp',
        String(frame / 30),
        '--output',
        png,
      );
      const rgb = raw(png, 0, 320, 180);
      assert.equal(rgb.length, 320 * 180 * 3);
      frames.set(frame, rgb);
      extracted.push(png);
    }
    const background = [18, 48, 72];
    const comparisons: Record<string, number> = {};
    const region = (
      name: string,
      frame: number,
      x: number,
      y: number,
      w: number,
      h: number,
      expected: (x: number, y: number, c: number) => number,
      tolerance = 12,
    ) => {
      let error = 0;
      const rgb = frames.get(frame)!;
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++)
          for (let c = 0; c < 3; c++)
            error += Math.abs(
              rgb[((y + yy) * 320 + x + xx) * 3 + c]! - expected(xx, yy, c),
            );
      const mae = error / (w * h * 3);
      comparisons[name] = mae;
      assert.ok(
        mae < tolerance,
        `${name}: mean pixel error ${mae} >= ${tolerance}`,
      );
    };
    for (const [frame, sourceFrame] of [
      [15, 30],
      [75, 60],
    ]) {
      const source = raw(
        join(generated, 'video-medium.mp4'),
        sourceFrame!,
        320,
        180,
      );
      region(
        `trim/split source mapping at frame ${frame}`,
        frame!,
        0,
        0,
        320,
        180,
        (x, y, c) => source[(y * 320 + x) * 3 + c]!,
      );
    }
    region(
      'one-second canvas gap',
      45,
      0,
      0,
      320,
      180,
      (_x, _y, c) => background[c]!,
      3,
    );
    region(
      'transformed clip position and scale',
      105,
      205,
      45,
      100,
      90,
      (_x, _y, c) => background[c]!,
      3,
    );
    const base = raw(join(generated, 'video-long.mp4'), 12, 160, 90);
    region(
      'scaled source content',
      105,
      40,
      45,
      160,
      90,
      (x, y, c) => base[(y * 160 + x) * 3 + c]!,
      16,
    );
    const still = raw(join(generated, 'still.png'), 0, 160, 90);
    const under = raw(join(generated, 'video-long.mp4'), 37, 160, 90);
    region(
      'overlay above canvas at half opacity',
      135,
      202,
      47,
      76,
      86,
      (x, y, c) =>
        (still[((y + 2) * 160 + x + 82) * 3 + c]! + background[c]!) / 2,
    );
    region(
      'overlay blends above video',
      135,
      122,
      47,
      76,
      86,
      (x, y, c) =>
        (still[((y + 2) * 160 + x + 2) * 3 + c]! +
          under[((y + 2) * 160 + x + 82) * 3 + c]!) /
        2,
      16,
    );
    const afterOverlay = raw(join(generated, 'video-long.mp4'), 87, 160, 90);
    region(
      'overlay ends at six seconds',
      195,
      40,
      45,
      160,
      90,
      (x, y, c) => afterOverlay[(y * 160 + x) * 3 + c]!,
      16,
    );
    region(
      'overlay no longer covers canvas',
      195,
      202,
      47,
      76,
      86,
      (_x, _y, c) => background[c]!,
      3,
    );
    const ending = raw(join(generated, 'video-long.mp4'), 112, 240, 180);
    region(
      'final arranged source',
      525,
      40,
      0,
      240,
      180,
      (x, y, c) => ending[(y * 240 + x) * 3 + c]!,
      16,
    );

    const pcm = tool('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-xerror',
      '-i',
      output,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    assert.ok(
      Math.abs(pcm.length / 4 - 18 * 48000) < 1024,
      'AAC duration/padding',
    );
    const tones: Record<string, number> = {};
    const tone = (
      hz: number,
      start: number,
      minimum: number,
      maximum: number,
    ) => {
      let real = 0,
        imaginary = 0;
      const count = 2400;
      for (let i = 0; i < count; i++) {
        const value = pcm.readFloatLE((Math.round(start * 48000) + i) * 4);
        real += value * Math.cos((2 * Math.PI * hz * i) / 48000);
        imaginary += value * Math.sin((2 * Math.PI * hz * i) / 48000);
      }
      const amplitude = (2 * Math.hypot(real, imaginary)) / count;
      tones[`${hz}Hz at ${start}s`] = amplitude;
      assert.ok(
        amplitude > minimum && amplitude < maximum,
        `${hz}Hz at ${start}s: ${amplitude} outside (${minimum}, ${maximum})`,
      );
    };
    // Fixture sine amplitude is 0.125: gains 0.6 / 0.25 imply 0.075 / 0.03125.
    // Bounds allow AAC loss while detecting missing, doubled or ignored gains.
    tone(1000, 0.52, 0.065, 0.085);
    tone(880, 0.52, 0.025, 0.038);
    tone(1000, 1.5, -1, 0.003);
    tone(880, 1.5, 0.025, 0.038);
    tone(1000, 2.52, 0.065, 0.085);
    tone(440, 3.02, 0.065, 0.085);
    tone(880, 3.02, 0.025, 0.038);
    tone(440, 3.5, -1, 0.003);
    for (const start of [4.02, 8.02, 12.02, 16.02, 17.5])
      tone(880, start, 0.025, 0.038);
    assert.equal(await readFile(project, 'utf8'), beforeRender);
    assert.deepEqual(await fixtureHashes(), before, 'Source fixtures changed');
    assert.ok(
      !(await readdir(directory)).some(
        (name) => name.endsWith('.lock') || name.startsWith('.opencut-'),
      ),
      'Leaked lock or render temporary directory',
    );
    const report = {
      output,
      outputHash: await hash(output),
      project,
      directory,
      retained: keep,
      durationSeconds: 18,
      frameCount: 540,
      cliProcesses: transcript.length,
      probe,
      comparisons,
      tones,
      extracted,
      sourceHashes: Object.fromEntries(
        fixtures.map((fixture, i) => [fixture.file, before[i]]),
      ),
    };
    const reportJson = JSON.stringify(report, null, 2) + '\n';
    await writeFile(join(directory, 'verification.json'), reportJson);
    await writeFile(
      join(directory, 'cli-transcript.json'),
      JSON.stringify(transcript, null, 2) + '\n',
    );
    succeeded = true;
    process.stdout.write(reportJson);
  } finally {
    // Failed runs are cleaned even with --keep; only successful retained runs survive.
    if (!keep || !succeeded)
      await rm(directory, { recursive: true, force: true });
    assert.deepEqual(await fixtureHashes(), before, 'Source fixtures changed');
  }
}
await main();
