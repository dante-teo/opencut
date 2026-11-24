import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateTimelineFrame } from '@opencut/core';
import {
  batchRenderVideo,
  buildNarration,
  compileVideo,
  defineVideo,
  packageVideo,
  verifyVideoPackage,
  videoDefinitionFormats,
  watchVideo,
} from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';
import { fixtureDirectory } from '../fixture-paths.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'opencut-video-definition-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function run(...args: string[]) {
  return runCli(...args, '--json');
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    cwd: directory,
    env: { ...process.env, PATH: '' },
  });
}

const definition = () =>
  defineVideo({
    name: 'Title card',
    canvas: {
      width: 320,
      height: 180,
      frameRate: { numerator: 30000, denominator: 1001 },
      durationFrames: 600,
    },
    tracks: [
      {
        type: 'text',
        name: 'Main',
        clips: [{ at: 15, duration: 30, text: { content: 'Main' } }],
      },
      {
        type: 'text',
        name: 'Credit',
        clips: [
          { id: 'credit', at: 45, duration: 15, text: { content: 'Credit' } },
        ],
      },
    ],
  });

async function writeDefinition(value: unknown, file = 'title.video.ts') {
  const path = join(directory, file);
  await writeFile(path, `export default ${JSON.stringify(value)};\n`);
  return path;
}

describe('whole-video definitions', () => {
  it.each(['metadata', 'content'] as const)(
    'reports a %s change and only retries a stable metadata-only update',
    async (kind) => {
      const source = join(directory, 'changing.video.ts');
      const flag = join(directory, 'touched');
      await writeFile(
        source,
        `import { appendFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(flag)})) {
  writeFileSync(${JSON.stringify(flag)}, '');
  const source = new URL(import.meta.url);
  if (${kind === 'content'}) appendFileSync(source, '\\n// New revision\\n');
  else utimesSync(source, 1, 1);
}
export default ${JSON.stringify(definition())};`,
      );
      const first = run('validate', source, '--retry-source-change');
      const events = first.stderr
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      const [event] = events;
      const content = kind === 'metadata' ? 'unchanged' : 'changed';
      if (kind === 'metadata') {
        expect(first.status, first.stderr).toBe(0);
        expect(JSON.parse(first.stdout)).toMatchObject({ ok: true });
        expect(events).toEqual([
          expect.objectContaining({
            event: 'source-change-retry',
            attempt: 2,
            sourceChange: expect.objectContaining({ content }),
          }),
        ]);
      } else {
        expect(first.status).toBe(1);
        expect(first.stdout).toBe('');
        expect(event).toMatchObject({
          error: {
            code: 'SOURCE_CHANGED',
            sourceChange: {
              path: await realpath(source),
              stage: 'definition loading',
              content,
            },
          },
        });
      }
      const change = event.sourceChange ?? event.error.sourceChange;
      expect(change.after).not.toBe(change.before);
      expect(change.beforeSha256 === change.afterSha256).toBe(
        kind === 'metadata',
      );
    },
  );

  it('replaces one narration recording and its caption while preserving other segments', () => {
    const time = (n: number) => ({ numerator: n, denominator: 2 });
    const first = {
      id: 'first',
      audio: 'a.wav',
      at: time(1),
      duration: time(2),
      transcript: 'Today',
    };
    const second = {
      id: 'second',
      audio: 'b.wav',
      at: time(6),
      duration: time(2),
      transcript: 'Later',
    };
    const original = buildNarration([first, second]);
    const rerecorded = {
      ...first,
      audio: 'new.wav',
      transcript: 'Hello!',
      duration: time(3),
      timings: [{ from: 0, to: 5, start: time(0), end: time(2) }],
    };
    const revised = buildNarration([rerecorded, second]);
    expect(revised.clips[0]).toMatchObject({
      id: original.clips[0]!.id,
      at: first.at,
      sourceOut: time(3),
    });
    expect(revised.cues[0]).toMatchObject({
      id: original.cues[0]!.id,
      start: first.at,
      end: { numerator: 2, denominator: 1 },
      text: rerecorded.transcript,
      words: rerecorded.timings,
    });
    expect(revised.assets[revised.clips[0]!.asset]?.path).toBe('new.wav');
    expect(revised.clips[1]).toEqual(original.clips[1]);
    expect(revised.cues[1]).toEqual(original.cues[1]);
    expect(() =>
      buildNarration([
        {
          ...rerecorded,
          timings: [{ from: 0, to: 5, start: time(0), end: time(4) }],
        },
      ]),
    ).toThrow(/Narration segment 'first'.*timings.*segment duration/);
  });

  it('compiles deterministically with exact fractional timing and stable IDs across unrelated track reordering', async () => {
    const input = definition();
    const path = await writeDefinition(input);
    const first = await compileVideo(path);
    const second = await compileVideo(path);
    expect(first.project).toEqual(second.project);
    expect(first.project.clips[0]?.timelineStart).toEqual({
      numerator: 1001,
      denominator: 2000,
    });
    expect(evaluateTimelineFrame(first.project, 599)).toMatchObject({
      boundary: 'inside',
      duration: { numerator: 1001, denominator: 50 },
      gap: true,
    });
    expect(evaluateTimelineFrame(first.project, 600).boundary).toBe('end');
    const render = await first.resolveRender();
    expect(render.frameCount).toBe(600);
    expect(
      render.visualClips.map(({ timelineStartFrame, frameCount }) => [
        timelineStartFrame,
        frameCount,
      ]),
    ).toEqual([
      [15, 30],
      [45, 15],
    ]);

    const reordered = await compileVideo(
      await writeDefinition({ ...input, tracks: [...input.tracks].reverse() }),
    );
    expect(reordered.project.tracks.map(({ id }) => id)).toEqual(
      first.project.tracks.map(({ id }) => id).reverse(),
    );
    expect(reordered.project.clips.map(({ id }) => id)).toEqual(
      first.project.clips.map(({ id }) => id).reverse(),
    );
    expect(await readdir(directory)).toEqual(['title.video.ts']);
  });

  it('loads trusted TypeScript once per compilation and retains an immutable snapshot across edits', async () => {
    const path = join(directory, 'title.video.ts');
    const input = definition();
    const script = (value: VideoDefinition) =>
      `globalThis.videoDefinitionLoads = (globalThis.videoDefinitionLoads ?? 0) + 1;
       export default ${JSON.stringify(value)};\n`;
    const state = globalThis as typeof globalThis & {
      videoDefinitionLoads?: number;
    };
    try {
      await writeFile(path, script(input));
      const first = await compileVideo(path);
      expect(Object.isFrozen(first.project.clips[0]?.text)).toBe(true);
      expect(Object.isFrozen(first.project.tracks)).toBe(true);
      input.canvas.durationFrames = 720;
      await writeFile(path, script(input));
      const plan = await first.resolveRender();
      expect(plan.frameCount).toBe(600);
      plan.visualClips[0]!.x = 500;
      expect((await first.resolveRender()).visualClips[0]?.x).toBe(0);
      expect(state.videoDefinitionLoads).toBe(1);
      const second = await compileVideo(path);
      expect((await second.resolveRender()).frameCount).toBe(720);
      expect(state.videoDefinitionLoads).toBe(2);
      expect(await readFile(path, 'utf8')).toBe(script(input));
    } finally {
      delete state.videoDefinitionLoads;
    }
  });

  it('refreshes transitive local ESM imports for each SDK build', async () => {
    const path = join(directory, 'title.video.ts');
    const parts = join(directory, 'parts.ts');
    await writeFile(
      path,
      `
      import { durationFrames } from './scene.ts';
      const definition = ${JSON.stringify(definition())};
      export default { ...definition, canvas: { ...definition.canvas, durationFrames } };
    `,
    );
    await writeFile(
      join(directory, 'scene.ts'),
      `
      export const { durationFrames } = await import('./parts.ts');
    `,
    );
    // Run the public SDK under native Node rather than Vitest's module loader.
    const sdk = new URL('../../packages/sdk/dist/index.js', import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      import { compileVideo } from ${JSON.stringify(sdk.href)};
      const [path, parts] = process.argv.slice(1);
      await writeFile(parts, 'export const durationFrames: number = 600;');
      const first = await compileVideo(path);
      await writeFile(parts, 'export const durationFrames: number = 720;');
      const [second, concurrent] = await Promise.all([compileVideo(path), compileVideo(path)]);
      assert.equal((await first.resolveRender()).frameCount, 600);
      assert.equal((await second.resolveRender()).frameCount, 720);
      assert.deepEqual(second.project, concurrent.project);
    `,
        path,
        parts,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('uses the bundled SDK only when the definition has no local SDK', async () => {
    const path = join(directory, 'title.video.ts');
    await writeFile(
      path,
      `import { defineVideo } from '@opencut/sdk';\nexport default defineVideo(${JSON.stringify(definition())});\n`,
    );
    const bundled = run('validate', path);
    expect(bundled.status, bundled.stderr).toBe(0);
    expect(JSON.parse(bundled.stdout)).toMatchObject({ frameCount: 600 });

    const sdk = join(directory, 'node_modules', '@opencut', 'sdk');
    const manifest = join(sdk, 'package.json');
    await mkdir(sdk, { recursive: true });
    await writeFile(manifest, '{"exports":"./index.mjs"}');
    await writeFile(
      join(sdk, 'index.mjs'),
      'export const defineVideo = (input) => ({ ...input, canvas: { ...input.canvas, durationFrames: 720 } });',
    );
    const local = run('validate', path);
    expect(local.status, local.stderr).toBe(0);
    expect(JSON.parse(local.stdout)).toMatchObject({ frameCount: 720 });

    await writeFile(manifest, '{"exports":"./missing.mjs"}');
    const broken = run('validate', path);
    expect(broken.status, broken.stdout).toBe(1);
    expect(JSON.parse(broken.stderr)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('missing.mjs') },
    });
  });

  it('validates and inspects from another directory without Electron or media tools', async () => {
    const folder = join(directory, 'definitions');
    await mkdir(folder);
    const path = await writeDefinition(
      definition(),
      'definitions/title.video.ts',
    );
    const validate = run('validate', path);
    expect(validate.status, validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({
      ok: true,
      frameCount: 600,
    });
    const inspect = run('inspect', path);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      settings: { durationFrames: 600 },
      duration: { numerator: 1001, denominator: 50 },
    });
    expect(await readdir(folder)).toEqual(['title.video.ts']);
  });

  it.each([
    [{ durationFrames: 20 }, /ends after the declared canvas/],
    [{ width: 319 }, /even dimensions/],
    [{ frameRate: 121 }, /rational frame rate/],
  ])(
    'rejects an invalid canvas before publishing output (%j)',
    async (settings, diagnostic) => {
      const input = definition();
      const path = await writeDefinition({
        ...input,
        canvas: { ...input.canvas, ...settings },
      });
      const result = run('render', path, '--output', 'failed.mp4');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(
        JSON.parse(result.stderr.trimEnd().split('\n').at(-1)!).error.message,
      ).toMatch(diagnostic);
      expect(await readdir(directory)).toEqual(['title.video.ts']);
    },
  );

  it('rejects wrong track fields, unknown assets, overlaps, unreadable media and unsafe paths', async () => {
    const input = definition();
    const visual = input.tracks[0]!;
    const video = {
      type: 'video',
      clips: [{ asset: 'camera', at: 0, sourceOut: 30 }],
    };
    for (const [value, diagnostic] of [
      [{ ...input, tracks: [{ ...visual, volume: 1 }] }, /volume/],
      [{ ...input, tracks: [video] }, /named video asset/],
      [
        {
          ...input,
          tracks: [
            {
              ...visual,
              clips: [
                ...visual.clips,
                { at: 20, duration: 30, text: { content: 'Overlap' } },
              ],
            },
          ],
        },
        /overlaps clip/,
      ],
      [
        {
          ...input,
          tracks: [video],
          assets: { camera: { kind: 'video', path: 'missing.mp4' } },
        },
        /Cannot probe/,
      ],
      [
        {
          ...input,
          assets: { camera: { kind: 'video', path: '/absolute.mp4' } },
        },
        /Relative paths/,
      ],
    ] as const)
      await expect(compileVideo(await writeDefinition(value))).rejects.toThrow(
        diagnostic,
      );
  });

  it.skipIf(process.platform === 'win32')(
    'cancels a frame preview while its TypeScript definition loads',
    async () => {
      const path = join(directory, 'cancel.video.ts');
      await writeFile(
        path,
        `import { setImmediate } from 'node:timers/promises';
       process.kill(process.pid, 'SIGTERM');
       await setImmediate();
       export default ${JSON.stringify(definition())};\n`,
      );
      const result = run(
        'preview',
        'frame',
        path,
        '--frame',
        '15',
        '--output',
        'cancelled.png',
      );
      expect(result.status, result.stderr).toBe(143);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe('');
      expect(await readdir(directory)).toEqual(['cancel.video.ts']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'lets a second signal terminate a stalled TypeScript definition',
    async () => {
      const path = join(directory, 'stalled.video.ts');
      const waitForSignal = 'definition is ready';
      await writeFile(
        path,
        `
        setInterval(() => {}, 1000);
        process.prependOnceListener('SIGTERM', () => {
          setImmediate(() => console.log('first signal handled'));
        });
        console.log(${JSON.stringify(waitForSignal)});
        await new Promise(() => {});
      `,
      );
      const child = spawn(process.execPath, [entry, 'validate', path], {
        cwd: directory,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const closed = once(child, 'close');
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
      let stderr = '';
      let signals = 0;
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        if (
          (signals === 0 && stderr.includes(waitForSignal)) ||
          (signals === 1 && stderr.includes('first signal handled'))
        ) {
          signals++;
          child.kill('SIGTERM');
        }
      });
      try {
        const [code, signal] = await closed;
        expect(signal === 'SIGTERM' || code === 143, stderr).toBe(true);
        expect(signals).toBe(2);
      } finally {
        clearTimeout(watchdog);
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
    },
  );

  it('writes TypeScript console messages to stderr and reserves stdout for JSON', async () => {
    const path = join(directory, 'title.video.ts');
    await writeFile(
      path,
      `console.log('definition executed');\nexport default ${JSON.stringify(definition())};\n`,
    );
    const result = run('inspect', path);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.split('\n')[0]).toBe('definition executed');
    expect(JSON.parse(result.stdout).settings.durationFrames).toBe(600);
  });
});

describe('definition validation', () => {
  it('validates duplicate IDs and subtitle timing in TypeScript definitions', async () => {
    const input = definition();
    for (const [value, message] of [
      [
        {
          ...input,
          tracks: input.tracks.map((track) => ({ ...track, id: 'repeated' })),
        },
        /ID 'repeated' is already in use/,
      ],
      [
        {
          ...input,
          subtitles: {
            style: {},
            cues: [
              {
                id: 'caption',
                start: { numerator: 1, denominator: 1 },
                end: { numerator: 2, denominator: 1 },
                text: 'one',
                words: [
                  {
                    from: 0,
                    to: 4,
                    start: { numerator: 0, denominator: 1 },
                    end: { numerator: 1, denominator: 2 },
                  },
                ],
              },
            ],
          },
        },
        /non-overlapping text and time ranges/,
      ],
      [
        {
          ...input,
          tracks: [
            {
              type: 'text',
              clips: [
                {
                  at: 0,
                  duration: 1,
                  text: { content: 'Test', font: 'missing' },
                },
              ],
            },
          ],
        },
        /Unknown font 'missing'/,
      ],
    ] as const) {
      await expect(compileVideo(await writeDefinition(value))).rejects.toThrow(
        message,
      );
    }
  });

  it('reports the inferred frame count in plain text and JSON', async () => {
    const input = definition();
    delete input.canvas.durationFrames;
    const path = await writeDefinition(input);
    const plain = runCli('validate', path);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toContain('Valid video definition (60 frames)');
    const json = run('validate', path);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ frameCount: 60 });
  });

  it('samples off-grid titles without changing their animation clock', async () => {
    const at = { numerator: 1, denominator: 25 };
    const path = await writeDefinition(
      defineVideo({
        canvas: { width: 320, height: 180, frameRate: 24 },
        tracks: [
          {
            type: 'text',
            clips: [
              {
                at: 0,
                duration: { numerator: 1, denominator: 240 },
                text: { content: 'First' },
              },
              {
                at: { numerator: 1, denominator: 240 },
                duration: { numerator: 1, denominator: 240 },
                text: { content: 'Between ticks' },
              },
              {
                at,
                sourceIn: { numerator: 1, denominator: 75 },
                sourceOut: { numerator: 7, denominator: 75 },
                text: { content: 'Title' },
                keyframes: {
                  x: [
                    {
                      time: { numerator: 0, denominator: 1 },
                      value: 10,
                      easing: 'linear',
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const video = await compileVideo(path);
    const { visualClips } = await video.resolveRender();
    expect(video.frameCount).toBe(3);
    expect(visualClips).toHaveLength(2);
    expect(visualClips).toMatchObject([
      { timelineStartFrame: 0, frameCount: 1 },
      { timelineStartFrame: 1, frameCount: 2, animation: { start: at } },
    ]);
  });

  it('enforces the full-render subtitle cap during validation', async () => {
    const input = definition();
    const cues = Array.from({ length: 513 }, (_, i) => ({
      id: `cue-${i}`,
      text: 'Caption',
      start: { numerator: i, denominator: 30 },
      end: { numerator: i + 1, denominator: 30 },
    }));
    input.subtitles = { style: {}, cues: cues.slice(0, 512) };
    const path = await writeDefinition(input);
    const valid = run('validate', path);
    expect(valid.status, valid.stderr).toBe(0);
    input.subtitles.cues = cues;
    await writeDefinition(input);
    const invalid = run('validate', path);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toMatch(/up to 512 visible subtitle cues/);
  });

  it('accepts legacy JSON only through conversion', async () => {
    const input = definition();
    const path = join(await realpath(directory), 'title.video.json');
    const original = JSON.stringify(input);
    await writeFile(path, original);

    expect(videoDefinitionFormats).toEqual({
      typescript: { suffix: '.video.ts', authoringCode: true },
    });
    for (const args of [
      ['validate', path],
      ['preview', path, '--watch'],
      ['render', path, '-o', 'output.mp4'],
      ['package', path, '-o', 'bundle'],
    ]) {
      const result = run(...args);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr).error.message).toContain('.video.ts');
    }

    await expect(compileVideo(path)).rejects.toThrow(
      'Expected a .video.ts file',
    );
    await expect(
      watchVideo(path, { onStatus: () => undefined }),
    ).rejects.toThrow('Expected a .video.ts file');
    await expect(
      batchRenderVideo(path, [], { outputDirectory: directory }),
    ).rejects.toThrow('Expected a .video.ts file');
    await expect(packageVideo(path, join(directory, 'bundle'))).rejects.toThrow(
      'Choose an authored .video.ts definition',
    );
    const alias = join(directory, 'alias.video.ts');
    await symlink(path, alias);
    await expect(compileVideo(alias)).rejects.toThrow(
      'Expected a .video.ts file',
    );

    const conversion = run('convert', path);
    expect(conversion.status, conversion.stderr).toBe(0);
    const ts = join(await realpath(directory), 'title.video.ts');
    expect(JSON.parse(conversion.stdout)).toEqual({ path: ts });
    expect(await readFile(path, 'utf8')).toBe(original);
    const converted = await compileVideo(ts);
    const direct = await compileVideo(
      await writeDefinition(input, 'direct.video.ts'),
    );
    expect((await converted.resolveRender()).visualClips).toEqual(
      (await direct.resolveRender()).visualClips,
    );
    const output = await readFile(ts, 'utf8');
    expect(run('convert', path).status).toBe(1);
    expect(await readFile(ts, 'utf8')).toBe(output);
  });

  it('converts a JSON symlink beside its target and retains relative graphics', async ({
    onTestFinished,
  }) => {
    await mkdir(fixtureDirectory, { recursive: true });
    const targetDirectory = await mkdtemp(join(fixtureDirectory, 'convert-'));
    onTestFinished(() => rm(targetDirectory, { recursive: true, force: true }));
    const target = join(targetDirectory, 'title.video.json');
    const alias = join(directory, 'linked.video.json');
    await writeFile(
      join(targetDirectory, 'badge.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#336699"/></svg>',
    );
    await writeFile(
      target,
      JSON.stringify({
        ...definition(),
        assets: {
          badge: { kind: 'graphic', renderer: 'svg', path: 'badge.svg' },
        },
        tracks: [
          { type: 'video', clips: [{ asset: 'badge', at: 0, duration: 60 }] },
        ],
      }),
    );
    await symlink(target, alias);

    const converted = run('convert', alias);
    expect(converted.status, converted.stderr).toBe(0);
    const path = join(targetDirectory, 'title.video.ts');
    expect(JSON.parse(converted.stdout)).toEqual({ path });
    expect(await readdir(directory)).toEqual(['linked.video.json']);

    const validated = run('validate', path);
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ frameCount: 600 });
  });

  it('converts a legacy package basename into a standalone definition', async () => {
    const folder = await realpath(directory);
    const source = join(folder, 'opencut.bundle.video.json');
    const reserved = join(folder, 'opencut.bundle.video.ts');
    const existing = '// existing package entry\n';
    await writeFile(source, JSON.stringify(definition()));
    await writeFile(reserved, existing);

    const converted = run('convert', source);
    expect(converted.status, converted.stderr).toBe(0);
    const path = join(folder, 'opencut.bundle.converted.video.ts');
    expect(JSON.parse(converted.stdout)).toEqual({ path });
    expect(await readFile(reserved, 'utf8')).toBe(existing);

    const validated = run('validate', path);
    expect(validated.status, validated.stderr).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({ frameCount: 600 });
  });

  it('converts parameter defaults, constraints and bindings into TypeScript', async () => {
    const path = join(await realpath(directory), 'variant.video.json');
    const ts = join(await realpath(directory), 'variant.video.ts');
    const document = {
      format: 'opencut-video-json',
      version: 1,
      parameters: {
        seconds: { type: 'integer', minimum: 100, maximum: 600, default: 300 },
        caption: {
          type: 'string',
          choices: ['English', '中文'],
          default: '中文',
        },
      },
      composition: definition(),
      bindings: [
        { parameter: 'seconds', path: ['canvas', 'durationFrames'] },
        {
          parameter: 'caption',
          path: ['tracks', 0, 'clips', 0, 'text', 'content'],
        },
      ],
    };
    await writeFile(path, JSON.stringify(document));
    const convert = run('convert', path);
    expect(convert.status, convert.stderr).toBe(0);
    const defaults = run('validate', ts);
    expect(defaults.status, defaults.stderr).toBe(0);
    expect(JSON.parse(defaults.stdout)).toMatchObject({ frameCount: 300 });

    const params = join(directory, 'variant.params.json');
    await writeFile(
      params,
      JSON.stringify({ seconds: 250, caption: 'English' }),
    );
    const variant = run('inspect', ts, '--params', params);
    expect(variant.status, variant.stderr).toBe(0);
    expect(JSON.parse(variant.stdout)).toMatchObject({
      settings: { durationFrames: 250 },
      clips: [
        expect.objectContaining({
          text: expect.objectContaining({ content: 'English' }),
        }),
        expect.anything(),
      ],
    });
    for (const [overrides, diagnostic] of [
      [{ seconds: 100.5 }, 'params.seconds'],
      [{ misspelling: 1 }, 'misspelling'],
      [{ seconds: 99 }, 'params.seconds'],
      [{ caption: 'Missing' }, 'params.caption'],
    ] as const) {
      await writeFile(params, JSON.stringify(overrides));
      const result = run('validate', ts, '--params', params);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(diagnostic);
    }
    const packed = run('package', ts, '-o', 'portable');
    expect(packed.status, packed.stderr).toBe(0);
    const verified = JSON.parse(run('package', 'verify', 'portable').stdout);
    expect(verified.manifest).toMatchObject({
      version: 1,
      source: 'project/variant.video.ts',
      params: { seconds: 300, caption: '中文' },
      imports: [],
    });
    expect((await compileVideo(verified.entry)).frameCount).toBe(300);
    const legacySource = 'project/variant.video.json';
    await writeFile(
      join(directory, 'portable', 'opencut-package.json'),
      JSON.stringify({
        ...verified.manifest,
        source: legacySource,
        files: verified.manifest.files.map((item: { path: string }) =>
          item.path === verified.manifest.source
            ? { ...item, path: legacySource }
            : item,
        ),
      }),
    );
    await expect(
      verifyVideoPackage(join(directory, 'portable')),
    ).rejects.toThrow('Package source must be a .video.ts definition');

    document.bindings.push({ parameter: 'seconds', path: ['canvas'] });
    const invalid = join(directory, 'invalid.video.json');
    await writeFile(invalid, JSON.stringify(document));
    const failed = run('convert', invalid);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Binding targets overlap');
    expect(await readdir(directory)).not.toContain('invalid.video.ts');
  });

  it('rejects a saved snapshot even when named like a definition', async () => {
    const compiled = await compileVideo(await writeDefinition(definition()));
    const path = join(directory, 'snapshot.video.ts');
    await writeFile(
      path,
      `export default ${JSON.stringify(compiled.project)};\n`,
    );
    const result = run('validate', path);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe(
      'INVALID_VIDEO_DEFINITION',
    );
  });
});
