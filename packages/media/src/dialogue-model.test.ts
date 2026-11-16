import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  inspectDialogueModel,
  installDialogueModel,
  removeDialogueModel,
} from './dialogue-model.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opencut-model-test-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('OPENCUT_DIALOGUE_PYTHON', join(home, 'missing'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

it('rejects a corrupted download and cleans up the incomplete install', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('wrong checkpoint')),
  );
  await expect(installDialogueModel()).rejects.toThrow('SHA-256');
  expect(await readdir(join(home, '.eluate/models'))).toEqual([]);
  expect(await inspectDialogueModel()).toMatchObject({
    ready: false,
    backend: { status: 'missing' },
    model: { status: 'missing' },
  });
});

it('reports an invalid checkpoint and removes only the multilingual file', async () => {
  const folder = join(home, '.eluate/models');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'checkpoint-multi.ckpt'), 'bad bytes');
  await writeFile(join(folder, 'checkpoint-eng.ckpt'), 'leave this alone');
  expect((await inspectDialogueModel()).model.status).toBe('invalid');
  await expect(installDialogueModel()).rejects.toThrow('existing');
  await removeDialogueModel();
  await removeDialogueModel();
  expect(await readdir(folder)).toEqual(['checkpoint-eng.ckpt']);
});

it('aborts an in-flight checkpoint stream without reporting an unreadable model', async () => {
  const folder = join(home, '.eluate/models');
  const checkpoint = join(folder, 'checkpoint-multi.ckpt');
  await mkdir(folder, { recursive: true });
  await writeFile(checkpoint, '');
  // A sparse file reaches the hash step without downloading the checkpoint.
  await truncate(checkpoint, 446_680_129);

  const controller = new AbortController();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  let stream: ReadStream | undefined;
  vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
    const reader = fs.createReadStream(path, options);
    reader.once('open', () => controller.abort());
    stream = reader;
    return reader;
  });

  await expect(inspectDialogueModel(controller.signal)).rejects.toThrow(
    'Render cancelled.',
  );
  expect(stream?.errored).toMatchObject({ name: 'AbortError' });
});
