import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { MediaAsset, Project } from '@opencut/core';
import type { AssetImportResult, AssetInfo } from '@opencut/core/node';
import { fixtures, requireTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const generated = fileURLToPath(
  new URL('../fixtures/generated/', import.meta.url),
);
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('native T07 media import and asset management', async (t) => {
  requireTool('ffprobe');
  const originals = await Promise.all(
    fixtures.map(async (fixture) => ({
      path: join(generated, fixture.file),
      hash: await hash(join(generated, fixture.file)),
    })),
  );
  const directory = await mkdtemp(join(generated, 't07-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15_000,
    });
  const json = (...args: string[]): unknown => {
    const result = run(...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as unknown;
  };
  try {
    await mkdir(join(directory, 'project'));
    const path = join(directory, 'project', 'demo.json');
    json('project', 'create', path, '--name', 'Native assets');
    const imported: MediaAsset[] = [];
    for (const fixture of fixtures) {
      await t.test(`imports and reloads ${fixture.file}`, async () => {
        const source = join(generated, fixture.file);
        const result = json(
          'media',
          'import',
          relative(directory, path),
          relative(directory, source),
        ) as AssetImportResult;
        assert.equal(result.imported, true);
        assert.equal(result.source.status, 'available');
        assert.equal(result.asset.file.type, 'relative');
        assert.equal(result.asset.file.path, `../../${fixture.file}`);
        assert.equal(
          result.asset.metadata?.kind,
          fixture.file === 'still.png'
            ? 'image'
            : fixture.video
              ? 'video'
              : 'audio',
        );
        assert.equal(result.asset.metadata?.hasAudio, Boolean(fixture.audio));
        assert.equal(
          result.asset.metadata?.videoCodec,
          fixture.video?.codec ?? null,
        );
        assert.equal(
          result.asset.metadata?.audioCodec,
          fixture.audio?.codec ?? null,
        );
        assert.equal(
          result.asset.metadata?.width,
          fixture.video?.width ?? null,
        );
        assert.equal(
          result.asset.metadata?.height,
          fixture.video?.height ?? null,
        );
        assert.equal(
          result.asset.metadata?.frameRate,
          fixture.video?.frameRate ?? null,
        );
        if (fixture.durationSeconds !== undefined) {
          assert(
            Math.abs(
              result.asset.metadata!.durationSeconds! - fixture.durationSeconds,
            ) < 0.1,
          );
          assert(result.asset.duration);
        } else {
          assert.equal(result.asset.metadata?.durationSeconds, null);
          assert.equal(result.asset.duration, undefined);
        }
        const reopened = JSON.parse(await readFile(path, 'utf8')) as Project;
        assert.deepEqual(reopened.assets.at(-1), result.asset);
        assert.deepEqual(
          (json('media', 'info', path, result.asset.id) as AssetInfo).asset,
          result.asset,
        );
        imported.push(result.asset);
      });
    }
    await t.test(
      'reimports aliases without duplicates, metadata loss or a project write',
      async () => {
        const before = await readFile(path, 'utf8');
        const source = join(generated, 'video-short.mp4');
        const alias = join(directory, '-日本語 #1%.mp4');
        const hard = join(directory, 'hard.mp4');
        await symlink(source, alias);
        await link(source, hard);
        for (const input of [source, alias, hard]) {
          const duplicate = json(
            'media',
            'import',
            path,
            input,
          ) as AssetImportResult;
          assert.equal(duplicate.imported, false);
          assert.equal(duplicate.asset.id, imported[0]!.id);
        }
        assert.equal(await readFile(path, 'utf8'), before);
        assert.equal(
          new Set(imported.map((asset) => asset.id)).size,
          fixtures.length,
        );
        assert.equal(
          (json('media', 'list', path) as { assets: unknown[] }).assets.length,
          fixtures.length,
        );
      },
    );
    await t.test(
      'fails invalid or missing sources without changing the project',
      async () => {
        const invalid = join(directory, 'invalid.mp4');
        await writeFile(invalid, 'this is not a media container');
        const before = await readFile(path, 'utf8');
        for (const source of [invalid, join(directory, 'missing.mp4')]) {
          const result = run('media', 'import', path, source, '--json');
          assert.equal(result.status, 1);
          assert.equal(result.stdout, '');
          assert(result.stderr.length > 0);
          assert.equal(await readFile(path, 'utf8'), before);
        }
      },
    );
    await t.test(
      'reports a source that disappears after import and preserves project bytes',
      async () => {
        const copied = join(directory, 'local.png');
        await copyFile(join(generated, 'still.png'), copied);
        const imported = json(
          'media',
          'import',
          path,
          copied,
        ) as AssetImportResult;
        await rename(copied, join(directory, 'renamed.png'));
        const before = await readFile(path, 'utf8');
        const info = json(
          'media',
          'info',
          path,
          imported.asset.id,
        ) as AssetInfo;
        assert.equal(info.source.status, 'missing');
        assert.equal(info.asset.metadata?.kind, 'image');
        const listed = json('media', 'list', path) as { assets: AssetInfo[] };
        assert.equal(
          listed.assets.find((info) => info.asset.id === imported.asset.id)
            ?.source.status,
          'missing',
        );
        assert.equal(await readFile(path, 'utf8'), before);
        json('media', 'remove', path, imported.asset.id);
      },
    );
    await t.test(
      'removes an asset and preserves the original media',
      async () => {
        const asset = imported.at(-1)!;
        assert.deepEqual(json('media', 'remove', path, asset.id), {
          path,
          removedAssetId: asset.id,
        });
        const result = run('media', 'info', path, asset.id, '--json');
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(
          (JSON.parse(await readFile(path, 'utf8')) as Project).assets.length,
          fixtures.length - 1,
        );
      },
    );
    await t.test(
      'retains references when moved to a sibling project folder',
      async () => {
        const moved = join(directory, 'moved');
        await mkdir(moved);
        const movedPath = join(moved, 'project.json');
        await rename(path, movedPath);
        const listed = json('media', 'list', movedPath) as {
          assets: AssetInfo[];
        };
        assert(
          listed.assets.every((info) => info.source.status === 'available'),
        );
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    for (const original of originals)
      assert.equal(
        await hash(original.path),
        original.hash,
        `Source changed: ${original.path}`,
      );
  }
});
