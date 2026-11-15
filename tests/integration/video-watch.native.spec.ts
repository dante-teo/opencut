import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  compileVideo,
  previewVideo,
  renderCompiledVideo,
  watchVideo,
  type VideoWatchRevision,
  type VideoWatchStatus,
} from '@opencut/sdk';
import {
  compareRgb,
  decodeFrames,
  verifyVideoTimestamps,
} from './media-comparison.js';
import { decodeAudio, sampleOnsets } from './audio-comparison.js';
import { fixtureDirectory, videoExample } from '../fixture-paths.js';

const cli = resolve('apps/cli/dist/index.js');
const example = videoExample('review.video.ts');

test('TypeScript watch preserves playback through truncation and follows atomic saves', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'blank.video.ts');
  const body = {
    name: 'First revision',
    canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 4 },
    tracks: [],
  };
  await writeFile(file, `export default ${JSON.stringify(body)};\n`);
  let latest: VideoWatchStatus | undefined;
  const watcher = await watchVideo(file, {
    onStatus: (event) => {
      latest = event;
    },
  });
  t.after(() => watcher.close());
  async function waitFor(status: VideoWatchStatus['status']) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (latest?.status === status) return latest;
      await delay(50);
    }
    assert.fail(`Expected ${status}, got ${latest?.status}`);
  }
  const before = (await waitFor('ready')).current!;
  await writeFile(file, '');
  const failed = await waitFor('error');
  assert.equal(failed.current, before);
  const temporary = join(directory, 'editor-save');
  await writeFile(
    temporary,
    `export default ${JSON.stringify({ ...body, name: 'Recovered revision' })};\n`,
  );
  await rename(temporary, file);
  const after = (await waitFor('ready')).current!;
  assert.equal(after.video.project.metadata.name, 'Recovered revision');
  assert.ok(after.generation > failed.generation);
  assert.equal(after.playback.path, before.playback.path);
});

test('watch observes imports, missing files and in-place media changes without mixing revisions', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-watch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'live.video.ts');
  const helper = join(directory, 'helper.ts');
  const still = join(directory, 'still.png');
  await copyFile(join(fixtureDirectory, 'still.png'), still);
  const mediaAlias = join(directory, 'media.png');
  await symlink(still, mediaAlias);
  const definition = {
    name: 'Original',
    canvas: { width: 320, height: 180, frameRate: 24, durationFrames: 12 },
    assets: { still: { kind: 'image', path: 'media.png' } },
    tracks: [
      { type: 'image', clips: [{ asset: 'still', at: 0, duration: 12 }] },
    ],
  };
  const body = `export default ${JSON.stringify(definition)};`;
  await writeFile(file, body);
  const events: VideoWatchStatus[] = [];
  const watcher = await watchVideo(file, {
    onStatus: (event) => events.push(event),
  });
  t.after(() => watcher.close());
  async function waitFor(predicate: (status: VideoWatchStatus) => boolean) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.fail(
      JSON.stringify(
        events.map(({ generation, status }) => ({ generation, status })),
      ),
    );
  }
  const first = (await waitFor(({ status }) => status === 'ready')).current!;
  const initialBytes = await readFile(first.playback.path);
  const initialFrame = decodeFrames(first.playback.path, [0], 320, 180).get(0);
  const renderPlan = await first.video.resolveRender();
  const snapshotPath = renderPlan.visualClips[0]!.path!;
  const started = performance.now();
  await writeFile(file, `import './helper.ts';\n${body}`);
  const failed = await waitFor(({ status }) => status === 'error');
  assert.match('error' in failed ? failed.error : '', /helper\.ts/);
  assert.equal(failed.current?.generation, first.generation);
  assert.deepEqual(await readFile(first.playback.path), initialBytes);

  await writeFile(helper, 'export const name = "Recovered";');
  const recovered = (
    await waitFor(
      ({ status, generation }) =>
        status === 'ready' && generation > failed.generation,
    )
  ).current!;
  assert.equal(
    (await recovered.video.resolveRender()).visualClips[0]!.path,
    snapshotPath,
  );
  assert.equal(recovered.playback.path, first.playback.path);
  assert.notEqual(recovered.sourceRevision, first.sourceRevision);
  const replacement = join(directory, 'replacement.png');
  await promisify(execFile)('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=320x180',
    '-frames:v',
    '1',
    '-threads',
    '1',
    replacement,
  ]);
  const beforeMedia = performance.now();
  const compiled = await compileVideo(file, { preview: true });
  const ordinary = previewVideo(compiled);
  let updated: VideoWatchRevision;
  let releaseExport!: () => void;
  const holdExport = new Promise<void>((release) => {
    releaseExport = release;
  });
  const exportPath = join(directory, 'pinned.mp4');
  const exporting = watcher.withCurrent(recovered.generation, async (video) => {
    await holdExport;
    return renderCompiledVideo(video, exportPath, { quality: 'draft' });
  });
  try {
    await writeFile(still, await readFile(replacement));
    const staleOutput = join(directory, 'stale.png');
    await assert.rejects(
      ordinary.frame(0, staleOutput),
      /changed after it was read/,
    );
    await assert.rejects(access(staleOutput), { code: 'ENOENT' });
    const staleExport = join(directory, 'stale.mp4');
    await assert.rejects(
      renderCompiledVideo(compiled, staleExport),
      /changed after it was read/,
    );
    await assert.rejects(access(staleExport), { code: 'ENOENT' });
    updated = (
      await waitFor(
        ({ status, generation }) =>
          status === 'ready' && generation > recovered.generation,
      )
    ).current!;
    assert.notEqual(updated.sourceRevision, recovered.sourceRevision);
    assert.notEqual(
      (await updated.video.resolveRender()).visualClips[0]!.path,
      snapshotPath,
    );
    const pixel = decodeFrames(updated.playback.path, [0], 320, 180).get(0)!;
    assert.ok(pixel[0]! > 240 && pixel[1]! < 15 && pixel[2]! < 15);
    await access(snapshotPath);
    await assert.rejects(
      watcher.withCurrent(recovered.generation, async () => {}),
      /preview changed/,
    );
  } finally {
    releaseExport();
    await exporting;
  }
  await assert.rejects(access(snapshotPath), { code: 'ENOENT' });
  assert.deepEqual(
    decodeFrames(exportPath, [0], 320, 180).get(0),
    initialFrame,
  );
  t.diagnostic(
    `Missing-import failure to media recovery ${(performance.now() - started).toFixed(0)} ms; media rewrite to playable revision ${(performance.now() - beforeMedia).toFixed(0)} ms including decode.`,
  );
  // Retarget the authored path without changing either of the target files.
  const nextAlias = join(directory, 'editor-media.png');
  await symlink(join(fixtureDirectory, 'still.png'), nextAlias);
  await rename(nextAlias, mediaAlias);
  const retargeted = (
    await waitFor(
      ({ status, generation }) =>
        status === 'ready' && generation > updated.generation,
    )
  ).current!;
  assert.notEqual(retargeted.sourceRevision, updated.sourceRevision);
  assert.deepEqual(
    decodeFrames(retargeted.playback.path, [0], 320, 180).get(0),
    initialFrame,
  );
  await watcher.close();
  await assert.rejects(access(retargeted.playback.path), { code: 'ENOENT' });
  await assert.rejects(access(snapshotPath), { code: 'ENOENT' });
});

test('CLI watch streams JSON revisions, cancels a superseded build and cleans up on SIGINT', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'blank.video.ts');
  const body = (name: string) =>
    `export default { name: '${name}', canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 4 }, tracks: [] };`;
  await writeFile(file, body('First'));
  const child = spawn(
    process.execPath,
    [cli, '--size', '320', 'preview', file, '--watch', '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGKILL');
    await closed;
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const events: {
    status: string;
    generation: number;
    current: { generation: number; path: string } | null;
  }[] = [];
  createInterface({ input: child.stdout! }).on('line', (line) =>
    events.push(JSON.parse(line)),
  );
  async function event(status: string, after = 0) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const found = events.find(
        (event) => event.status === status && event.generation > after,
      );
      if (found) return found;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.fail(
      `${status} after ${after}: ${stderr}\n${JSON.stringify(events)}`,
    );
  }
  const first = await event('ready');
  await writeFile(
    file,
    `${body('Obsolete')}\nconsole.error('slow-build'); await new Promise(() => setInterval(() => {}, 1000));`,
  );
  const slow = await event('compiling', first.generation);
  for (
    let attempt = 0;
    !stderr.includes('slow-build') && attempt < 100;
    attempt++
  )
    await new Promise((done) => setTimeout(done, 30));
  assert.match(stderr, /slow-build/);
  await writeFile(file, body('Latest'));
  const latest = await event('ready', slow.generation);
  assert.ok(
    !events.some(
      ({ generation, status }) =>
        generation === slow.generation && status === 'ready',
    ),
  );
  assert.equal(latest.current?.generation, latest.generation);
  assert.ok(latest.current?.path);
  child.kill('SIGINT');
  assert.deepEqual(await closed, [130, null]);
  await assert.rejects(access(latest.current.path), { code: 'ENOENT' });
});

test('watch tracks imports made while an async default export resolves', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-async-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'async.video.ts');
  const helper = join(directory, 'helper.ts');
  await writeFile(helper, "export const name = 'First';");
  await writeFile(
    file,
    `
    async function build() {
      await new Promise((done) => setTimeout(done, 20));
      const { name } = await import('./helper.ts');
      return { name, canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 4 }, tracks: [] };
    }
    export default build();
  `,
  );
  let latest: VideoWatchStatus | undefined;
  const watcher = await watchVideo(file, {
    onStatus: (event) => {
      latest = event;
    },
  });
  t.after(() => watcher.close());
  async function waitForName(name: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (
        latest?.status === 'ready' &&
        latest.current?.video.project.metadata.name === name
      )
        return latest.current;
      await delay(50);
    }
    assert.fail(
      `Expected ${name}, got ${latest?.current?.video.project.metadata.name}`,
    );
  }
  const first = await waitForName('First');
  await writeFile(helper, "export const name = 'Second';");
  const second = await waitForName('Second');
  assert.ok(second.generation > first.generation);
  assert.notEqual(second.sourceRevision, first.sourceRevision);
});

test('definition previews stage media only when decoding it', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-staging-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'staging.video.ts');
  const image = join(directory, 'insert.png');
  const audio = join(directory, 'tone.wav');
  await copyFile(join(fixtureDirectory, 'still.png'), image);
  await copyFile(join(fixtureDirectory, 'audio-tone.wav'), audio);
  await writeFile(
    file,
    `export default ${JSON.stringify({
      canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 12 },
      assets: {
        insert: { kind: 'image', path: 'insert.png' },
        tone: { kind: 'audio', path: 'tone.wav' },
      },
      tracks: [
        { type: 'image', clips: [{ asset: 'insert', at: 5, duration: 2 }] },
        { type: 'audio', clips: [{ asset: 'tone', at: 0, sourceOut: 12 }] },
      ],
    })};\n`,
  );
  const preview = previewVideo(await compileVideo(file, { preview: true }));
  await rm(image);
  const clip = await preview.clip(
    { startFrame: 0, endFrame: 4 },
    join(directory, 'before-insert.mp4'),
  );
  assert.equal(clip.frameCount, 4);
  await rm(audio);
  const frame = await preview.frame(0, join(directory, 'opening.png'));
  assert.equal(frame.frame, 0);
  const sheet = await preview.contactSheet(
    {},
    join(directory, 'endpoints.png'),
    { count: 2 },
  );
  assert.deepEqual(
    sheet.samples.map(({ frame }) => frame),
    [0, 11],
  );
  await assert.rejects(
    preview.frame(5, join(directory, 'insert-frame.png')),
    /insert\.png.*changed after it was read/,
  );
  await assert.rejects(
    preview.clip(
      { startFrame: 0, endFrame: 4 },
      join(directory, 'audio-changed.mp4'),
    ),
    /tone\.wav.*changed after it was read/,
  );
});

test('definition previews agree with final composited frames and audio timing', async (t) => {
  const directory = await mkdtemp(join(fixtureDirectory, 't46-accuracy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function run(...args: string[]) {
    return JSON.parse(
      (await promisify(execFile)(process.execPath, [cli, ...args, '--json']))
        .stdout,
    );
  }
  const video = await compileVideo(example, { preview: true });
  const preview = previewVideo(video);
  const rendered = await run(
    'render',
    example,
    '--output',
    join(directory, 'final.mp4'),
  );
  const positions = [10, 20, 24, 31, 40];
  const finalFrames = decodeFrames(rendered.path, positions, 320, 180);
  const means = [];
  for (const frame of positions) {
    const result = await preview.frame(
      frame,
      join(directory, `frame-${frame}.png`),
    );
    const rgb = decodeFrames(result.path, [0], 320, 180).get(0)!;
    // This compares a lossless RGB PNG to a 4:2:0 H.264 decode. Chroma can
    // introduce large errors on single-pixel colored edges in this fixture.
    const comparison = compareRgb(rgb, finalFrames.get(frame)!, {
      mean: 5,
      p95: 25,
      largePixelFraction: 0.025,
    });
    assert.ok(
      comparison.passed,
      `frame ${frame}: ${JSON.stringify(comparison)}`,
    );
    means.push(comparison.metrics.mean);
  }
  const timestamp = await run(
    'preview',
    'frame',
    example,
    '--timestamp',
    '1',
    '--output',
    join(directory, 'at-one.png'),
  );
  assert.deepEqual(
    await readFile(timestamp.path),
    await readFile(join(directory, 'frame-24.png')),
  );
  assert.equal(
    preview.inspectFrame({ numerator: 1, denominator: 1 }).frame,
    24,
  );
  const sheet = await preview.contactSheet(
    { startFrame: 20, endFrame: 32 },
    join(directory, 'sheet.png'),
    { count: 4 },
  );
  assert.deepEqual(
    sheet.samples.map(({ frame }) => frame),
    [20, 23, 27, 31],
  );
  const clip = await run(
    'preview',
    'clip',
    example,
    '--from',
    '6',
    '--to',
    '42',
    '--quality',
    'high',
    '--output',
    join(directory, 'clip.mp4'),
  );
  verifyVideoTimestamps(clip.path, { numerator: 24, denominator: 1 }, 36);
  const clipFrames = decodeFrames(
    clip.path,
    positions.map((frame) => frame - 6),
    320,
    180,
  );
  for (const frame of positions) {
    const comparison = compareRgb(
      clipFrames.get(frame - 6)!,
      finalFrames.get(frame)!,
      { mean: 5, p95: 25, largePixelFraction: 0.025 },
    );
    assert.ok(
      comparison.passed,
      `clip frame ${frame}: ${JSON.stringify(comparison)}`,
    );
  }
  const fullOnsets = sampleOnsets(decodeAudio(rendered.path).samples);
  const clipOnsets = sampleOnsets(decodeAudio(clip.path).samples);
  assert.ok(fullOnsets.length && clipOnsets.length);
  const skew = Math.abs(fullOnsets[0]! - 6 / 24 - clipOnsets[0]!);
  assert.ok(skew <= 0.01, `Audio onset error ${skew}s`);

  const showcase = videoExample('showcase.video.ts');
  const showcaseBefore = await readFile(showcase);
  const showcaseSheet = await run(
    'preview',
    'contact-sheet',
    showcase,
    '--from',
    '24',
    '--to',
    '31',
    '--count',
    '2',
    '--output',
    join(directory, 'showcase-sheet.png'),
  );
  assert.deepEqual(
    showcaseSheet.samples.map(({ frame }: { frame: number }) => frame),
    [24, 30],
  );
  const showcaseClip = await run(
    'preview',
    'clip',
    showcase,
    '--from',
    '24',
    '--to',
    '36',
    '--output',
    join(directory, 'showcase-clip.mp4'),
  );
  assert.equal(showcaseClip.frameCount, 12);
  assert.deepEqual(await readFile(showcase), showcaseBefore);
  t.diagnostic(
    `Maximum mean RGB error ${Math.max(...means).toFixed(2)}/255 across five frames; shifted audio onset error ${(skew * 1000).toFixed(1)} ms.`,
  );
});
