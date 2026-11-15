import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchRenderVideo, compileVideo, videoId } from '@opencut/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generatedFixtures } from '../fixture-paths.js';

const cli = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
let directory: string;
let file: string;

beforeEach(async () => {
  await mkdir(generatedFixtures, { recursive: true });
  directory = await mkdtemp(join(generatedFixtures, 't52-headless-'));
  file = join(directory, 'sample.video.ts');
  await writeFile(
    join(directory, 'counter.ts'),
    'export let count = 0; export function next() { return ++count; }',
  );
  await writeFile(
    file,
    `
    import { defineVideo, videoParams as z, videoId } from '@opencut/sdk';
    import { next } from './counter.ts';
    const card = (scope: string, at: number, content: string) =>
      ({ id: videoId(scope, 'card'), at, duration: 12, text: { content } });
    export default defineVideo({
      title: z.string().trim().min(1),
      size: z.strictObject({ width: z.number().int().min(32) }).default({ width: 160 }),
      hang: z.boolean().default(false),
    }, async ({title, size, hang}) => {
      while (hang) { /* Test cancellation during synchronous authoring. */ }
      return {
        name: title,
        canvas: { width: size.width, height: 90, frameRate: 24 },
        tracks: [{ type: 'text', id: 'titles', clips: [
          card('intro', 0, title + ' ' + next()), card('outro', 12, 'End')
        ] }],
      };
    });
  `,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('T52 parameterized video definitions', () => {
  it('resolves typed defaults and transforms once, isolates modules and freezes each composition', async () => {
    const [intro, other, repeat] = await Promise.all([
      compileVideo(file, { params: { title: ' One ' } }),
      compileVideo(file, { params: { title: 'Two', size: { width: 140 } } }),
      compileVideo(file, { params: { title: 'One' } }),
    ]);
    expect(intro.build?.params).toEqual({
      title: 'One',
      size: { width: 160 },
      hang: false,
    });
    expect(Object.isFrozen(intro.build?.params?.size)).toBe(true);
    expect(Object.isFrozen(intro.project.clips[0]?.text)).toBe(true);
    expect(intro.project.clips.map(({ text }) => text?.content)).toEqual([
      'One 1',
      'End',
    ]);
    expect(other.project.clips.map(({ text }) => text?.content)).toEqual([
      'Two 1',
      'End',
    ]);
    expect(other.project.settings.width).toBe(140);
    expect(intro.project.clips.map(({ id }) => id)).toEqual([
      videoId('intro', 'card'),
      videoId('outro', 'card'),
    ]);
    expect(videoId('a-b', 'c')).not.toBe(videoId('a', 'b-c'));
    expect(intro.project).toEqual(repeat.project);
    expect(intro.build?.definition).toEqual(repeat.build?.definition);
    expect(other.build?.definition.sha256).toBe(intro.build?.definition.sha256);
    expect(other.build?.definition.compositionSha256).not.toBe(
      intro.build?.definition.compositionSha256,
    );
    await writeFile(
      join(directory, 'counter.ts'),
      'export const next = () => 1;',
    );
    const changed = await compileVideo(file, { params: { title: 'One' } });
    expect(changed.build?.definition.sha256).not.toBe(
      intro.build?.definition.sha256,
    );
    expect(changed.build?.definition.compositionSha256).toBe(
      intro.build?.definition.compositionSha256,
    );
  });

  it('rejects missing, invalid, extra and unsupported parameters with paths', async () => {
    await expect(compileVideo(file)).rejects.toThrow(/params\.title/);
    await expect(compileVideo(file, { params: { title: 3 } })).rejects.toThrow(
      /params\.title/,
    );
    await expect(
      compileVideo(file, {
        params: { title: 'OK', size: { width: 32, extra: 3 } },
      }),
    ).rejects.toThrow(/params\.size.*extra/);
    await expect(
      compileVideo(file, { params: { title: 'OK', extra: true } }),
    ).rejects.toThrow(/params.*extra/);
    await expect(
      compileVideo(file, {
        params: JSON.parse('{"title":"OK","__proto__":1}'),
      }),
    ).rejects.toThrow(/params.*__proto__/);
    await expect(compileVideo(file, { params: null })).rejects.toThrow(
      /params.*object|params.*record/i,
    );
    const plain = join(directory, 'static.video.ts');
    await writeFile(plain, 'export default {};');
    await expect(compileVideo(plain, { params: {} })).rejects.toThrow(
      /does not declare external parameters/,
    );
  });

  it('supports --params with a JSON file and preserves CLI usage errors', async () => {
    const params = join(directory, 'params.json');
    await writeFile(params, '{"title":"With parameters"}');
    const result = spawnSync(
      process.execPath,
      [cli, 'validate', file, '--params', params, '--json'],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      frameCount: 24,
    });
    await writeFile(params, '{');
    const invalid = spawnSync(
      process.execPath,
      [cli, 'validate', file, '--params', params, '--json'],
      { encoding: 'utf8' },
    );
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'T52 batch validation and cancellation',
  () => {
    it('rejects collisions and paths that leave the output directory before compiling', async () => {
      const outputDirectory = join(directory, 'output');
      await expect(
        batchRenderVideo(
          file,
          [
            { id: 'a', output: 'same.mp4' },
            { id: 'b', output: 'SAME.MP4' },
          ],
          { outputDirectory },
        ),
      ).rejects.toThrow(/both target/);
      await expect(
        batchRenderVideo(file, [{ id: 'a', output: '../a.mp4' }], {
          outputDirectory,
        }),
      ).rejects.toThrow(/variants\.0\.output/);
      await expect(
        batchRenderVideo(file, [{ id: 'a' }, { id: 'a' }], { outputDirectory }),
      ).rejects.toThrow(/Duplicate batch variant/);
      await expect(
        batchRenderVideo(file, [{ id: 'a' }], {
          outputDirectory,
          only: ['missing'],
        }),
      ).rejects.toThrow(/Unknown batch variant/);
      expect(await readdir(directory)).not.toContain('output');
    });

    it('fails fast when requested and reports queued jobs in manifest order', async () => {
      const result = await batchRenderVideo(
        file,
        [{ id: 'bad' }, { id: 'next', params: { title: 'Next' } }],
        { outputDirectory: directory, failFast: true },
      );
      expect(result).toMatchObject({
        ok: false,
        variants: [
          {
            id: 'bad',
            status: 'failed',
            phase: 'compiling',
            error: {
              code: 'INVALID_VIDEO_DEFINITION',
              message: expect.stringContaining('params.title'),
            },
          },
          { id: 'next', status: 'cancelled', reason: 'fail-fast' },
        ],
      });
    });

    it('terminates synchronous authoring when the caller aborts', async () => {
      const abort = new AbortController();
      const outputDirectory = join(directory, 'output');
      const result = await batchRenderVideo(
        file,
        [
          { id: 'hung', params: { title: 'Spin', hang: true } },
          { id: 'queued', params: { title: 'Later' } },
        ],
        {
          outputDirectory,
          signal: abort.signal,
          onProgress(event) {
            if (event.status === 'compiling')
              setTimeout(() => abort.abort(), 300);
          },
        },
      );
      expect(result).toMatchObject({
        ok: false,
        variants: [
          { id: 'hung', status: 'cancelled', reason: 'aborted' },
          { id: 'queued', status: 'cancelled', reason: 'aborted' },
        ],
      });
      expect(await readdir(outputDirectory)).toEqual([]);
    });
  },
);
