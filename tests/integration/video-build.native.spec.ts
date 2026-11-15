import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  inspectVideoBuild,
  packageVideo,
  renderVideo,
  verifyVideoPackage,
} from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';
import { assertSimilarExports } from './conformance-support.js';

const exec = promisify(execFile);
const cliEntry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const cli = (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  exec(process.execPath, [cliEntry, ...args], { timeout: 60_000, ...options });
const fontPath = fileURLToPath(
  new URL('../../packages/media/fonts/NotoEmoji.ttf', import.meta.url),
);

async function scratch(t: TestContext) {
  await mkdir(fixtureDirectory, { recursive: true });
  const root = await mkdtemp(join(fixtureDirectory, 't53-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const renderArgs = (file: string, output: string, cache: string) => [
  'render',
  file,
  '--output',
  output,
  '--recipe-cache',
  cache,
];
const absent = async (file: string) => {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
};

async function killWhileWriting(
  args: string[],
  tools: string,
  marker: string,
  match: string,
) {
  const originalPath = process.env.PATH ?? '';
  const child = spawn(process.execPath, [cliEntry, ...args], {
    env: {
      ...process.env,
      PATH: tools + ':' + originalPath,
      T53_MATCH: match,
      T53_PATH: originalPath,
      T53_MARKER: marker,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let worker: number | undefined;
  try {
    const signal = AbortSignal.timeout(15_000);
    for (;;) {
      const ready = await readFile(marker, 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      if (ready.endsWith('\n')) {
        const [pid, file] = ready.trimEnd().split('\n');
        worker = Number(pid);
        assert.equal(await readFile(file!, 'utf8'), 'partial');
        assert.ok(child.kill('SIGKILL'));
        assert.equal((await closed)[1], 'SIGKILL');
        return file!;
      }
      if (child.exitCode !== null) assert.fail(stderr);
      await delay(20, undefined, { signal });
    }
  } finally {
    child.kill('SIGKILL');
    if (worker !== undefined) stopWorker(worker);
    await closed;
  }
}

function stopWorker(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}

test('T53 reuses verified stages, rejects corruption, and rerenders an interrupted MP4', async (t) => {
  const root = await scratch(t);
  const cache = join(root, 'cache');
  const processing = { cacheDirectory: cache };
  const file = join(root, 'edit.video.json');
  const output = join(root, 'out.mp4');
  const tools = join(root, 'tools');
  await mkdir(tools);
  await copyFile(
    join(fixtureDirectory, 'video-medium.mp4'),
    join(root, 'picture.mp4'),
  );
  await writeFile(
    file,
    JSON.stringify({
      canvas: { width: 128, height: 72, frameRate: 24, durationFrames: 12 },
      assets: {
        picture: {
          kind: 'video',
          path: 'picture.mp4',
          recipe: [
            { type: 'trim', start: 0, end: 1 },
            { type: 'resize', width: 128, height: 72 },
          ],
        },
      },
      tracks: [
        {
          type: 'video',
          clips: [{ asset: 'picture', at: 0, sourceOut: 12, muted: true }],
        },
      ],
    } satisfies VideoDefinition),
  );
  await writeFile(
    join(tools, 'ffmpeg'),
    `#!/bin/sh
for output do :; done
case "$output" in
  */"$T53_MATCH")
    printf partial > "$output"
    printf '%s\\n%s\\n' "$$" "$output" > "$T53_MARKER"
    exec /bin/sleep 60
    ;;
esac
PATH="$T53_PATH" exec ffmpeg "$@"
`,
    { mode: 0o700 },
  );
  // Interrupt the first recipe before its output can be validated.
  const args = renderArgs(file, output, cache);
  assert.equal(
    (await inspectVideoBuild(file, { processing })).state,
    'unbuilt',
  );
  await absent(cache);
  const partialStep = await killWhileWriting(
    args,
    tools,
    join(root, 'recipe-marker'),
    'media.mov',
  );
  assert.match(partialStep, /\.stage\/attempt-/);
  const interrupted = await inspectVideoBuild(file, { processing });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.steps[0]!.reusable, false);
  await absent(output);

  const first = await cli(['validate', file, '--recipe-cache', cache]);
  assert.match(first.stderr, /step 1: completed/);
  const compiled = await inspectVideoBuild(file, { processing });
  assert.equal(compiled.state, 'compiled');
  assert.deepEqual(
    compiled.steps.map((step) => step.reusable),
    [true, true],
  );
  await absent(partialStep);

  const stage = compiled.steps[0]!;
  const entry = join(cache, stage.key);
  const staged = join(cache, '.' + stage.key + '.stage');
  await mkdir(staged);
  const attempt = join(staged, 'attempt-ABC123');
  await rename(entry, attempt);
  const inspectedStage = (await inspectVideoBuild(file, { processing }))
    .steps[0];
  assert.deepEqual(inspectedStage, stage);
  await absent(entry);
  assert.ok((await lstat(attempt)).isDirectory());

  const saved = await cli(['validate', file, '--recipe-cache', cache]);
  assert.match(saved.stderr, /step 1: cache-hit/);
  await absent(staged);

  const damagedStage = compiled.steps[1]!;
  const media = join(cache, damagedStage.key, 'media.' + damagedStage.format);
  const info = await lstat(media);
  const content = await readFile(media);
  content[Math.floor(content.length / 2)]! ^= 255;
  await writeFile(media, content);
  await utimes(media, info.atime, info.mtime);
  assert.equal(
    (await inspectVideoBuild(file, { processing })).steps[1]!.reusable,
    false,
  );
  const fixed = await cli(['validate', file, '--recipe-cache', cache]);
  assert.match(fixed.stderr, /step 1: cache-hit/);
  assert.match(fixed.stderr, /step 2: completed/);

  const partialRender = await killWhileWriting(
    args,
    tools,
    join(root, 'render-marker'),
    'render.mp4',
  );
  await absent(output);
  assert.equal(
    (await inspectVideoBuild(file, { processing })).renders[0]!.state,
    'interrupted',
  );
  const retried = await cli(args);
  assert.match(retried.stderr, /step 1: cache-hit/);
  assert.match(retried.stderr, /step 2: cache-hit/);
  await absent(partialRender);
  const { stdout } = await cli([
    'build',
    'inspect',
    file,
    '--recipe-cache',
    cache,
    '--json',
  ]);
  const observed = JSON.parse(stdout) as Awaited<
    ReturnType<typeof inspectVideoBuild>
  >;
  assert.equal(observed.renders[0]!.state, 'rendered');
  assert.equal(observed.frameCount, 12);
  await writeFile(output, 'damaged published file');
  assert.equal(
    (await inspectVideoBuild(file, { processing })).renders[0]!.state,
    'missing-or-corrupt',
  );
});

test('T53 keeps the last published render receipt through failed retries', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'edit.video.json');
  const output = join(root, 'out.mp4');
  const processing = { cacheDirectory: join(root, 'cache') };
  await writeFile(
    file,
    JSON.stringify({
      canvas: { width: 64, height: 64, frameRate: 24, durationFrames: 4 },
      tracks: [],
    } satisfies VideoDefinition),
  );

  const inspect = async () =>
    (await inspectVideoBuild(file, { processing })).renders[0]!;
  await renderVideo(file, output, { processing, quality: 'draft' });
  const published = await inspect();
  assert.equal(published.state, 'rendered');
  assert.ok(published.verified);
  assert.deepEqual(published.settings, {
    quality: 'draft',
    burnSubtitles: true,
  });

  await assert.rejects(
    renderVideo(file, output, { processing, quality: 'high' }),
    /Refusing to overwrite existing output/,
  );
  const { lastAttempt, ...afterRetry } = await inspect();
  assert.deepEqual(afterRetry, published);
  assert.equal(lastAttempt?.state, 'failed');
  assert.deepEqual(lastAttempt.settings, {
    quality: 'high',
    burnSubtitles: true,
  });
  assert.match(
    lastAttempt.error ?? '',
    /Refusing to overwrite existing output/,
  );

  await assert.rejects(
    renderVideo(file, output, {
      processing,
      overwrite: true,
      outputSize: { width: 65, height: 64 },
    }),
    /even|dimension/i,
  );
  const afterFailedOverwrite = await inspect();
  assert.equal(afterFailedOverwrite.state, 'rendered');
  assert.deepEqual(afterFailedOverwrite.settings, published.settings);
  assert.deepEqual(afterFailedOverwrite.verified, published.verified);
  assert.equal(afterFailedOverwrite.lastAttempt?.state, 'failed');

  await renderVideo(file, output, {
    processing,
    overwrite: true,
    outputSize: { width: 80, height: 64 },
  });
  const replacement = await inspect();
  assert.equal(replacement.state, 'rendered');
  assert.notDeepEqual(replacement.verified, published.verified);
  assert.equal(replacement.lastAttempt, undefined);
});

test('T53 aborts packaging during asynchronous TypeScript composition', async (t) => {
  const root = await scratch(t);
  const file = join(root, 'edit.video.ts');
  const output = join(root, 'bundle');
  const started = join(root, 'started');
  const release = join(root, 'release');
  await writeFile(
    file,
    `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { defineVideo, videoParams } from '@opencut/sdk';

export default defineVideo({ frames: videoParams.number() }, async ({ frames }) => {
  writeFileSync(new URL('./started', import.meta.url), '');
  while (!existsSync(new URL('./release', import.meta.url))) await setTimeout(10);
  return {
    canvas: { width: 64, height: 64, frameRate: 24, durationFrames: frames },
    tracks: [],
  };
});
`,
  );

  const controller = new AbortController();
  const reason = new Error('Cancel T53 packaging');
  const packaging = packageVideo(file, output, {
    params: { frames: 4 },
    signal: controller.signal,
  });
  const rejected = assert.rejects(packaging, (error) => error === reason);
  void rejected.catch(() => {});
  try {
    const deadline = AbortSignal.timeout(5_000);
    while (
      !(await lstat(started).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }))
    )
      await delay(10, undefined, { signal: deadline });
    controller.abort(reason);
    assert.equal(
      await Promise.race([
        rejected.then(() => 'aborted'),
        delay(3_000, 'pending', { ref: false }),
      ]),
      'aborted',
    );
    await absent(output);
  } finally {
    await writeFile(release, '');
    await packaging.catch(() => {});
  }
});

async function sample(t: TestContext, ai = false) {
  const root = await scratch(t);
  const project = join(root, 'project');
  const source = join(project, 'src');
  const assets = join(project, 'media');
  await mkdir(source, { recursive: true });
  await mkdir(assets);
  if (ai) {
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=24:d=0.5',
      '-vf',
      'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '16',
      join(assets, 'picture.mp4'),
    ]);
  } else {
    await copyFile(
      join(fixtureDirectory, 'video-medium.mp4'),
      join(assets, 'picture.mp4'),
    );
  }
  await copyFile(
    join(fixtureDirectory, 'audio-tone.wav'),
    join(assets, 'music.wav'),
  );
  await copyFile(fontPath, join(assets, 'font.ttf'));
  await writeFile(join(source, 'subtitle.txt'), 'Portable captions');
  await writeFile(join(source, 'types.ts'), 'export type Caption = string;\n');
  await writeFile(join(source, 'words.ts'), 'export const prefix = "T53";\n');
  await writeFile(
    join(source, 'caption.ts'),
    `
import { readFileSync } from 'node:fs';
import { prefix } from './words.ts';
import type { Caption } from './types.ts';
export const caption: Caption = prefix + ': ' + readFileSync(new URL('./subtitle.txt', import.meta.url), 'utf8');
`,
  );
  const definition = join(source, 'edit.video.ts');
  const recipe = ai
    ? [
        { type: 'interpolateFrames', numerator: 48, quality: 'fast' },
        { type: 'resize', width: 160, height: 90 },
      ]
    : [{ type: 'resize', width: 160, height: 90 }];
  await writeFile(
    definition,
    `
import { defineVideo, videoParams } from '@opencut/sdk';
export default defineVideo({ title: videoParams.string().default('Default') }, async ({ title }) => {
  const { caption } = await import('./' + 'caption.ts');
  return {
    name: title,
    canvas: { width: 160, height: 90, frameRate: 24, durationFrames: 10 },
    assets: {
      picture: { kind: 'video', path: '../media/picture.mp4', recipe: ${JSON.stringify(recipe)} },
      music: { kind: 'audio', path: '../media/music.wav' },
    },
    fonts: { captions: { path: '../media/font.ttf' } },
    tracks: [
      { type: 'video', clips: [{ asset: 'picture', at: 0, sourceOut: 10, muted: true }] },
      { type: 'audio', clips: [{ asset: 'music', at: 0, sourceOut: 10, volume: 0.15 }] },
    ],
    subtitles: { style: { font: 'captions', fontSize: 16 }, cues: [
      { id: 'caption', start: { numerator: 0, denominator: 1 }, end: { numerator: 5, denominator: 12 }, text: caption },
    ] },
  };
});
`,
  );
  return { root, project, definition };
}

test('T53 packages TypeScript imports, media, fonts and resources, and renders from a new directory', async (t) => {
  const { root, project, definition } = await sample(t);
  const initial = join(root, 'original.mp4');
  const chosen = { title: 'Portable edit' };
  await renderVideo(definition, initial, {
    params: chosen,
    processing: { cacheDirectory: join(root, 'cache-a') },
  });
  const bundle = join(root, 'bundle');
  const paramsFile = join(root, 'params.json');
  await writeFile(paramsFile, JSON.stringify(chosen));
  await cli([
    'package',
    definition,
    '--root',
    project,
    '--resource',
    'src/subtitle.txt',
    '--params',
    paramsFile,
    '--output',
    bundle,
    '--json',
  ]);
  const verified = await verifyVideoPackage(bundle);
  assert.deepEqual(verified.manifest.params, chosen);
  assert.deepEqual(verified.manifest.requirements.authoringPackages, [
    '@opencut/sdk',
  ]);
  assert.deepEqual(verified.manifest.imports.map(({ to }) => to).sort(), [
    'project/src/caption.ts',
    'project/src/types.ts',
    'project/src/words.ts',
  ]);
  assert.equal(verified.manifest.files.length, 9);
  assert.ok(!JSON.stringify(verified.manifest).includes(root));
  assert.ok(verified.manifest.bytes > 250_000);
  t.diagnostic(
    `Relocated bundle payload: ${verified.manifest.bytes} bytes across ${verified.manifest.files.length} files`,
  );
  const relocated = join(root, 'relocated');
  await mkdir(relocated);
  await rename(bundle, join(relocated, 'portable'));
  await rm(project, { recursive: true });
  const moved = join(relocated, 'portable');
  await cli(['package', 'verify', 'portable', '--json'], { cwd: relocated });
  const delivered = join(relocated, 'render.mp4');
  await cli(
    renderArgs(
      'portable/' + basename(verified.entry),
      'render.mp4',
      'fresh-cache',
    ),
    { cwd: relocated },
  );
  await assertSimilarExports(initial, delivered, {
    width: 160,
    height: 90,
    frameCount: 10,
    fps: 24,
  });
  const resource = join(moved, 'project/src/subtitle.txt');
  await writeFile(resource, 'modified');
  await assert.rejects(
    verifyVideoPackage(moved),
    /integrity check failed.*subtitle\.txt/,
  );
  await rm(resource);
  await assert.rejects(verifyVideoPackage(moved), /Missing.*subtitle\.txt/);
});

test('T53 rejects escaped or unresolved dependencies, collisions, and malicious inventory paths', async (t) => {
  const { root, project, definition } = await sample(t);
  const bundle = join(root, 'bundle');
  await assert.rejects(
    packageVideo(definition, bundle),
    /outside the project root/,
  );
  await absent(bundle);
  await symlink(
    join(project, 'media/picture.mp4'),
    join(project, 'media/link.mp4'),
  );
  await assert.rejects(
    packageVideo(definition, bundle, {
      root: project,
      resources: ['media/link.mp4'],
    }),
    /symlink/,
  );
  await assert.rejects(
    packageVideo(definition, bundle, {
      root: project,
      resources: ['../outside'],
    }),
    /outside the project root/,
  );
  const source = await readFile(definition, 'utf8');
  await writeFile(definition, source.replace("'caption.ts'", "'missing.ts'"));
  await assert.rejects(
    packageVideo(definition, bundle, { root: project }),
    /missing\.ts/,
  );
  await writeFile(
    definition,
    source.replace(
      "const { caption } = await import('./' + 'caption.ts');",
      "const { caption } = await import('./' + 'missing.ts').catch(() => ({ caption: 'fallback' }));",
    ),
  );
  await assert.rejects(
    packageVideo(definition, bundle, { root: project }),
    /Unresolved package dependency.*missing\.ts/,
  );
  await writeFile(definition, source);
  await mkdir(bundle);
  await assert.rejects(
    packageVideo(definition, bundle, { root: project }),
    /already exists/,
  );
  assert.deepEqual(await readdir(bundle), []);
  await rm(bundle, { recursive: true });

  const { manifest } = await packageVideo(definition, bundle, {
    root: project,
    resources: ['src/subtitle.txt'],
  });
  const manifestFile = join(bundle, 'opencut-package.json');
  const [item] = manifest.files;
  assert.ok(item);
  const altered = {
    ...manifest,
    files: [{ ...item, path: '../escape' }, ...manifest.files.slice(1)],
  };
  await writeFile(manifestFile, JSON.stringify(altered));
  await assert.rejects(verifyVideoPackage(bundle), /Invalid.*manifest/);
  await writeFile(
    manifestFile,
    JSON.stringify({
      ...manifest,
      files: [...manifest.files, { ...item, path: item.path.toUpperCase() }],
    }),
  );
  await assert.rejects(verifyVideoPackage(bundle), /collision/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  await rm(join(bundle, item.path));
  await symlink(
    join(project, item.path.slice('project/'.length)),
    join(bundle, item.path),
  );
  await assert.rejects(verifyVideoPackage(bundle), /symlink/);
});

test('T53 records AI requirements and rejects a backend version mismatch before processing', async (t) => {
  const { root, project, definition } = await sample(t, true);
  const bundle = join(root, 'bundle');
  const { entry, manifest } = await packageVideo(definition, bundle, {
    root: project,
    resources: ['src/subtitle.txt'],
  });
  const native = manifest.requirements.native[0]!;
  assert.equal(native.kind, 'interpolation');
  assert.match(native.version, /^videotoolbox-/);
  assert.match(native.model, /system model/);
  await verifyVideoPackage(bundle);
  await writeFile(
    join(bundle, 'opencut-package.json'),
    JSON.stringify({
      ...manifest,
      requirements: {
        ...manifest.requirements,
        native: [{ ...native, version: 'missing-model-version' }],
      },
    }),
  );
  await assert.rejects(
    renderVideo(entry, join(root, 'missing.mp4')),
    /missing-model-version.*Install a matching OpenCut/,
  );
  await absent(join(root, 'missing.mp4'));
});

test('T53 keeps a completed VideoToolbox stage across a killed render of a relocated package', async (t) => {
  const { stdout } = await cli(['system', 'inspect', '--json']);
  const system = JSON.parse(stdout) as {
    videoToolbox?: {
      frameProcessors?: Record<string, { status: string }>;
    };
  };
  if (
    system.videoToolbox?.frameProcessors?.['low-latency-interpolation']
      ?.status !== 'reported-supported'
  ) {
    t.skip('VideoToolbox interpolation is unavailable on this host');
    return;
  }

  const { root, project, definition } = await sample(t, true);
  const bundle = join(root, 'bundle');
  await packageVideo(definition, bundle, {
    root: project,
    resources: ['src/subtitle.txt'],
  });
  const moved = join(root, 'relocated-video');
  await rename(bundle, moved);
  await rm(project, { recursive: true });
  const { entry } = await verifyVideoPackage(moved);
  const cacheDirectory = join(root, 'clean-cache');
  const output = join(root, 'delivered.mp4');
  const config = { processing: { cacheDirectory } };
  const child = spawn(
    process.execPath,
    [cliEntry, ...renderArgs(entry, output, cacheDirectory)],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  const closed = once(child, 'close');
  let log = '';
  let killed = false;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    child.stderr.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      if (!killed && /recipe picture step 1: completed/.test(log)) {
        killed = child.kill('SIGKILL');
      }
    });
    assert.equal((await closed)[1], 'SIGKILL', log);
    assert.ok(killed, log);
    await absent(output);
    const interrupted = await inspectVideoBuild(entry, config);
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.steps[0]!.reusable, true);

    const recovered = await cli(renderArgs(entry, output, cacheDirectory));
    assert.match(recovered.stderr, /recipe picture step 1: cache-hit/);
    assert.match(recovered.stderr, /recipe picture step 2: completed/);
    const status = await inspectVideoBuild(entry, config);
    assert.equal(status.frameCount, 10);
    assert.equal(status.renders[0]!.state, 'rendered');
    assert.equal(status.steps[0]!.sha256, interrupted.steps[0]!.sha256);
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
  }
});
