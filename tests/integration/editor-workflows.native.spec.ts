import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createProject,
  executeTransaction,
  frameTime,
  projectRevision,
} from '@opencut/core';
import type { Project } from '@opencut/core';
import {
  acquireProjectWriter,
  copyProjectFile,
  freezeProjectFrame,
  readProjectFile,
  renderPreviewCache,
  renderProjectFile,
  writeProjectFile,
} from '@opencut/core/node';
import { ProjectSession } from '../../apps/desktop/src/main/project-session.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);

function videoProject(source: string, frames = 60, fps = 30) {
  const frameRate = { numerator: fps, denominator: 1 };
  const project = createProject({
    name: 'Review fixture',
    settings: { width: 64, height: 48, frameRate },
  });
  project.assets.push({
    id: 'source',
    name: 'Source',
    mediaTypes: ['video', 'audio'],
    file: { type: 'absolute', path: source },
  });
  project.tracks.push({ id: 'video', name: 'Video', type: 'video' });
  project.clips.push({
    id: 'clip',
    assetId: 'source',
    trackId: 'video',
    timelineStart: frameTime(0, frameRate),
    sourceIn: frameTime(0, frameRate),
    sourceOut: frameTime(frames, frameRate),
  });
  return project;
}

function decodeAudio(path: string) {
  return execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-f',
    'f32le',
    'pipe:1',
  ]);
}

test('renders short detached audio, the full gain-key limit, and reverb across a contiguous split', async () => {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'review-audio-'));
  try {
    const source = join(directory, 'short-audio.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=s=64x48:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'aevalsrc=if(between(n\\,47600\\,47900)\\,0.65*sin(2*PI*900*t)\\,0):s=48000:d=1.2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      source,
    ]);
    const project = videoProject(source, 240, 120);
    project.clips[0]!.effects = [{ type: 'reverb', mix: 0.5 }];
    const edit = (
      project: Project,
      ...operations: Parameters<typeof executeTransaction>[1]['operations']
    ) =>
      executeTransaction(project, {
        expectedRevision: projectRevision(project),
        operations,
      }).project;
    const render = async (name: string, project: Project) => {
      const path = join(directory, name + '.json');
      await writeProjectFile(project, path);
      return renderProjectFile(path, join(directory, name + '.mp4'));
    };
    const original = await render('original', project);
    const detached = edit(project, { type: 'clip.detach-audio', id: 'clip' });
    const detachedOutput = await render('detached', detached);
    assert.deepEqual(
      decodeAudio(detachedOutput.path),
      decodeAudio(original.path),
    );
    const split = edit(project, { type: 'clip.split', id: 'clip', at: 120 });
    const splitOutput = await render('split', split);
    const decoded = decodeAudio(original.path);
    assert.ok(
      decoded.subarray(48000 * 4, 52000 * 4).some((byte) => byte !== 0),
    );
    assert.deepEqual(decodeAudio(splitOutput.path), decoded);
    const automated = edit(project, {
      type: 'clip.gain-keys',
      id: 'clip',
      keys: Array.from({ length: 128 }, (_, index) => ({
        time: frameTime(index, project.settings.frameRate),
        value: index % 2 ? 0.2 : 0.5,
      })),
    });
    const rendered = await render('automated', automated);
    assert.equal(rendered.frameCount, 240);
    assert.notDeepEqual(decodeAudio(rendered.path), decoded);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves packages through the physical project directory and preserves unrelated cache files', async () => {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'review-paths-'));
  try {
    const source = join(directory, 'real', 'media.mp4');
    await mkdir(join(directory, 'real', 'edit'), { recursive: true });
    await mkdir(join(directory, 'alias'));
    await symlink(
      join(directory, 'real', 'edit'),
      join(directory, 'alias', 'edit'),
    );
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x48:r=30:d=2',
      '-c:v',
      'libx264',
      source,
    ]);
    await writeFile(join(directory, 'alias', 'media.mp4'), 'wrong source');
    const project = videoProject(source);
    project.assets[0]!.file = { type: 'relative', path: '../media.mp4' };
    const projectPath = join(directory, 'alias', 'edit', 'project.json');
    await writeProjectFile(project, projectPath);
    const bundle = await copyProjectFile(
      project,
      projectPath,
      join(directory, 'bundle'),
      true,
    );
    assert.equal(bundle.mediaFiles, 1);
    assert.deepEqual(
      await readFile(join(directory, 'bundle', 'media', '1.mp4')),
      await readFile(source),
    );
    const cache = join(directory, 'cache');
    await mkdir(cache);
    const originals = Array.from({ length: 65 }, (_, index) =>
      join(cache, index.toString(16).padStart(64, '0') + '.mp4'),
    );
    await Promise.all(originals.map((path) => writeFile(path, 'original')));
    const preview = await renderPreviewCache(
      project,
      projectPath,
      64,
      {},
      cache,
    );
    await truncate(preview.path, 2 * 1024 ** 3 + 1);
    const second = await renderPreviewCache(
      project,
      projectPath,
      66,
      {},
      cache,
    );
    await assert.rejects(readFile(preview.path), { code: 'ENOENT' });
    for (const path of originals)
      assert.equal(await readFile(path, 'utf8'), 'original');
    project.assets.push({
      id: 'inside-cache',
      name: 'Unplaced media',
      mediaTypes: ['video'],
      file: { type: 'absolute', path: originals[0]! },
    });
    await assert.rejects(
      renderPreviewCache(project, projectPath, 64, {}, cache),
      /Original media must be outside/,
    );
    project.assets.pop();
    await rm(second.path);
    await writeFile(second.path, 'unrelated replacement');
    await assert.rejects(
      renderPreviewCache(project, projectPath, 66, {}, cache),
      /unowned file/,
    );
    assert.equal(await readFile(second.path, 'utf8'), 'unrelated replacement');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removes freeze output after confirmed session and desktop save rejection', async () => {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'review-freeze-'));
  const source = join(directory, 'source.mp4');
  const path = join(directory, 'project.json');
  const output = join(directory, 'freeze.png');
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=s=64x48:r=30:d=2',
      '-c:v',
      'libx264',
      source,
    ]);
    const original = videoProject(source);
    await writeProjectFile(original, path);
    const writer = await acquireProjectWriter(path);
    try {
      const changed = structuredClone(original);
      changed.metadata.name = 'Concurrent edit';
      await writer.serve(async ({ update }) =>
        update ? update(changed) : original,
      );
      await assert.rejects(freezeProjectFrame(path, 'clip', 12, 3, output), {
        code: 'REVISION_CONFLICT',
      });
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } finally {
      await writer.close();
    }
    const session = new ProjectSession({
      open: async () => path,
      save: async () => null,
      unsaved: async () => 'discard',
      saveFreezeFrame: async () => {
        const changed = structuredClone(original);
        changed.metadata.name = 'External change during the picker';
        await writeProjectFile(changed, join(directory, 'changed.json'));
        await rename(join(directory, 'changed.json'), path);
        return output;
      },
    });
    try {
      assert.equal((await session.run('open')).ok, true);
      const result = await session.run('freezeFrame', {
        projectId: original.metadata.id,
        expectedRevision: 0,
        clipId: 'clip',
        at: 12,
        frames: 3,
      });
      assert.equal(result.ok, false);
      await assert.rejects(readFile(output), { code: 'ENOENT' });
    } finally {
      await session.dispose();
    }
    const retry = await freezeProjectFrame(path, 'clip', 12, 3, output);
    assert.equal(retry.path, output);
    assert.equal((await readProjectFile(path)).clips.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edits a project with relinking, freezes, a grade, audio effects, and portable export', async () => {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'editor-workflows-'));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [entry, ...args, '--json'], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const json = (...args: string[]) => JSON.parse(run(...args));
  const source = join(directory, 'source.mp4');
  const relinked = join(directory, 'renamed.mp4');
  const project = join(directory, 'project.opencut.json');
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=128x96:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      source,
    ]);
    const before = await readFile(source);
    json(
      'project',
      'create',
      project,
      '--name',
      'Editor workflow',
      '--width',
      '96',
      '--height',
      '128',
    );
    const { asset } = json('media', 'import', project, source);
    const { track } = json(
      'track',
      'add',
      project,
      '--type',
      'video',
      '--name',
      'Video',
    );
    const { clip } = json(
      'clip',
      'add',
      project,
      asset.id,
      '--track',
      track.id,
      '--at',
      '0',
      '--in',
      '0',
      '--out',
      '30',
    );
    await rename(source, relinked);
    assert.equal(
      json('media', 'info', project, asset.id).source.status,
      'missing',
    );
    assert.equal(
      json('media', 'relink', project, asset.id, relinked).source.status,
      'available',
    );
    const batch = join(directory, 'batch.json');
    const revision = json('project', 'inspect', project).revision;
    await writeFile(
      batch,
      JSON.stringify({
        expectedRevision: revision,
        operations: [
          {
            type: 'clip.visual',
            id: clip.id,
            fit: 'cover',
            crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
          },
          {
            type: 'clip.grade',
            ids: [clip.id],
            grade: {
              exposure: -1,
              temperature: 0,
              tint: 0,
              contrast: 1,
              saturation: 0,
              curve: [],
            },
          },
          {
            type: 'clip.gain-keys',
            id: clip.id,
            keys: [
              { time: { numerator: 0, denominator: 1 }, value: 0.2 },
              { time: { numerator: 1, denominator: 1 }, value: 0.8 },
            ],
          },
          {
            type: 'clip.effects',
            id: clip.id,
            effects: [
              { type: 'eq', frequency: 440, db: -3 },
              { type: 'de-esser', amount: 0.3 },
              { type: 'reverb', mix: 0.1 },
            ],
          },
          {
            type: 'subtitle.add',
            id: 'subtitle',
            start: { numerator: 0, denominator: 1 },
            end: { numerator: 1, denominator: 1 },
            text: 'Hello world',
          },
          {
            type: 'subtitle.effects',
            id: 'subtitle',
            pop: true,
            emphasis: ['world'],
          },
        ],
      }),
    );
    json('edit', 'apply', project, batch);
    const cueRevision = json('project', 'inspect', project).revision;
    await writeFile(
      batch,
      JSON.stringify({
        expectedRevision: cueRevision,
        operations: [
          {
            type: 'subtitle.words',
            id: 'subtitle',
            words: [
              {
                from: 0,
                to: 5,
                start: { numerator: 0, denominator: 1 },
                end: { numerator: 1, denominator: 2 },
              },
              {
                from: 6,
                to: 11,
                start: { numerator: 1, denominator: 2 },
                end: { numerator: 1, denominator: 1 },
              },
            ],
          },
        ],
      }),
    );
    json('edit', 'apply', project, batch);
    for (const [frame, from] of [
      [4, 0],
      [17, 6],
    ]) {
      const inspected = json(
        'timeline',
        'inspect',
        project,
        '--frame',
        String(frame),
      );
      const subtitle = inspected.visualClips.find(
        (clip: { subtitle?: boolean }) => clip.subtitle,
      );
      assert.equal(subtitle.subtitleCueId, 'subtitle');
      assert.equal(subtitle.text.activeWord.from, from);
      assert.deepEqual(subtitle.animationStart, {
        numerator: 0,
        denominator: 1,
      });
    }
    const font = fileURLToPath(
      new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
    );
    json('media', 'import-font', project, 'subtitle', font);
    assert.ok(json('subtitle', 'list', project).cues[0].style.embeddedFont);
    const held = join(directory, 'held.png');
    json(
      'project',
      'freeze',
      project,
      clip.id,
      '--at',
      '15',
      '--frames',
      '6',
      '--output',
      held,
    );
    const view = json('project', 'inspect', project);
    assert.equal(view.clips.length, 3);
    assert.equal(
      view.clips.filter((entry: { grade?: unknown }) => entry.grade).length,
      3,
    );
    json('edit', 'undo', project);
    assert.equal(json('project', 'inspect', project).clips.length, 1);
    json('edit', 'redo', project);
    json(
      'preview',
      'frame',
      project,
      '--frame',
      '4',
      '--output',
      join(directory, 'preview.png'),
    );
    const output = join(directory, 'out.mp4');
    const result = run(
      'project',
      'render',
      project,
      '--output',
      output,
      '--width',
      '120',
      '--height',
      '160',
      '--fps',
      '25',
      '--video-bitrate',
      '300',
      '--audio-bitrate',
      '96',
      '--audio-rate',
      '44100',
      '--audio-channels',
      '1',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(result.event, 'completed');
    assert.equal(result.frameCount, 30);
    const probe = json('probe', output);
    assert.equal(probe.video.width, 120);
    assert.equal(probe.video.height, 160);
    assert.equal(probe.audio.channels, 1);
    assert.equal(probe.audio.sampleRate, 44100);
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-xerror',
      '-i',
      output,
      '-f',
      'null',
      '-',
    ]);
    const bundle = json(
      'project',
      'package',
      project,
      '--output',
      join(directory, 'portable'),
    );
    assert.equal(bundle.mediaFiles, 2);
    assert.equal(json('project', 'validate', bundle.path).valid, true);
    assert.equal(
      json('project', 'inspect', bundle.path).revision,
      view.revision + 2,
    );
    assert.deepEqual(await readFile(relinked), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the full timeline cache samples VFR by presentation time and reuses the same render', async () => {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'vfr-preview-'));
  const source = join(directory, 'source.mkv');
  const project = join(directory, 'project.opencut.json');
  const run = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [entry, ...args, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, OPENCUT_MEDIA_CACHE: join(directory, 'cache') },
      }),
    );
  try {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=64x48:r=30:d=1',
      '-vf',
      "drawbox=c=blue:t=fill:enable='eq(n,4)',drawbox=c=green:t=fill:enable='eq(n,13)',select='eq(n,0)+eq(n,4)+eq(n,13)+eq(n,29)'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      source,
    ]);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v',
          '-show_entries',
          'frame=best_effort_timestamp_time',
          '-of',
          'json',
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(
      probe.frames.map((frame: { best_effort_timestamp_time: string }) =>
        Math.round(Number(frame.best_effort_timestamp_time) * 30),
      ),
      [0, 4, 13, 29],
    );
    run(
      'project',
      'create',
      project,
      '--name',
      'VFR cache',
      '--width',
      '64',
      '--height',
      '48',
    );
    const { asset } = run('media', 'import', project, source);
    const { track } = run(
      'track',
      'add',
      project,
      '--type',
      'video',
      '--name',
      'Video',
    );
    run(
      'clip',
      'add',
      project,
      asset.id,
      '--track',
      track.id,
      '--at',
      '0',
      '--in',
      '0',
      '--out',
      '28',
    );
    const first = run('project', 'cache-preview', project, '--size', '64');
    assert.equal(first.hit, false);
    const second = run('project', 'cache-preview', project, '--size', '64');
    assert.equal(second.hit, true);
    assert.equal(second.path, first.path);
    const pixels = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      second.path,
      '-vf',
      'scale=1:1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.equal(pixels.length, 28 * 3);
    for (let frame = 0; frame < 28; frame++) {
      const [r, g, b] = pixels.subarray(frame * 3, frame * 3 + 3);
      const expected = frame < 4 ? r : frame < 13 ? b : g;
      assert.equal(
        expected,
        Math.max(r!, g!, b!),
        `source frame at project frame ${frame}`,
      );
    }
    const isolatedCache = join(directory, 'interrupted-cache');
    const snapshot = await readProjectFile(project);
    await assert.rejects(
      renderPreviewCache(
        snapshot,
        project,
        64,
        {
          onProgress: ({ phase }) => {
            if (phase === 'verifying') utimesSync(source, 0, 0);
          },
        },
        isolatedCache,
      ),
      /A source changed during preview rendering/,
    );
    assert.deepEqual(await readdir(isolatedCache), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
