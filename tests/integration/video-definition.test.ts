import { spawn, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateTimelineFrame, serializeProject } from '@opencut/core';
import { compileVideo, defineVideo } from '@opencut/sdk';
import type { VideoDefinition } from '@opencut/sdk';

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
  return spawnSync(process.execPath, [entry, ...args, '--json'], {
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

async function writeDefinition(value: unknown, file = 'title.video.json') {
  const path = join(directory, file);
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe('whole-video definitions', () => {
  it('compiles deterministically with exact fractional timing and stable IDs across unrelated track reordering', async () => {
    const input = definition();
    const path = await writeDefinition(input);
    const first = await compileVideo(path);
    const second = await compileVideo(path);
    expect(serializeProject(first.project)).toBe(
      serializeProject(second.project),
    );
    expect(first.project.editing).toBeUndefined();
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
    expect(await readdir(directory)).toEqual(['title.video.json']);
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

  it('validates and inspects from another directory without Electron or media tools', async () => {
    const folder = join(directory, 'definitions');
    await mkdir(folder);
    const path = await writeDefinition(
      definition(),
      'definitions/title.video.json',
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
      revision: 0,
      settings: { durationFrames: 600 },
      duration: { numerator: 1001, denominator: 50 },
    });
    expect(await readdir(folder)).toEqual(['title.video.json']);
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
      expect(JSON.parse(result.stderr).error.message).toMatch(diagnostic);
      expect(await readdir(directory)).toEqual(['title.video.json']);
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
    expect(result.stderr.trim()).toBe('definition executed');
    expect(JSON.parse(result.stdout).settings.durationFrames).toBe(600);
  });
});
