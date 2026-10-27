import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { servePreviewFile } from '../../apps/desktop/src/main/preview-file.js';

const path = fileURLToPath(import.meta.url);
it('serves exact byte, suffix and open ranges and rejects invalid ranges', async () => {
  const content = await readFile(path);
  for (const [range, start, end] of [
    ['bytes=0-31', 0, 31],
    ['bytes=-8', content.length - 8, content.length - 1],
    [`bytes=${content.length - 8}-`, content.length - 8, content.length - 1],
  ] as const) {
    const response = await servePreviewFile(
      path,
      new Request('https://example.invalid', { headers: { Range: range } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(
      `bytes ${start}-${end}/${content.length}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      content.subarray(start, end + 1),
    );
  }
  for (const range of [
    'bytes=999999999-',
    'bytes=7-2',
    'invalid',
    'items=0-1',
    'bytes=0-1,5-6',
  ]) {
    const response = await servePreviewFile(
      path,
      new Request('https://example.invalid', { headers: { Range: range } }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(
      `bytes */${content.length}`,
    );
  }
  const response = await servePreviewFile(
    path,
    new Request('https://example.invalid'),
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
});

it('serves audio and still sources with their media content type', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencut-preview-types-'));
  try {
    for (const [extension, type] of [
      ['wav', 'audio/wav'],
      ['mp3', 'audio/mpeg'],
      ['m4a', 'audio/mp4'],
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
    ]) {
      const source = join(directory, `source.${extension}`);
      await writeFile(source, 'Synthetic source sentinel');
      const response = await servePreviewFile(
        source,
        new Request('https://example.invalid'),
      );
      expect(response.headers.get('Content-Type')).toBe(type);
      expect(await response.text()).toBe('Synthetic source sentinel');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
