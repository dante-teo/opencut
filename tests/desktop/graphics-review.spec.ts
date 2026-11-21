import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './helpers.js';
import { fixtureDirectory } from '../fixture-paths.js';

test('updates a React graphic from a watched CSS dependency', async () => {
  test.setTimeout(45_000);
  const directory = await mkdtemp(join(fixtureDirectory, 'graphics-desktop-'));
  const path = join(directory, 'review.video.ts');
  const styles = join(directory, 'graphic.css');
  await Promise.all([
    writeFile(
      path,
      `export default {
      canvas: { width: 160, height: 90, frameRate: 12, durationFrames: 12 },
      assets: { card: { kind: 'graphic', renderer: 'react', path: './Card.tsx', durationFrames: 12 } },
      tracks: [{ type: 'video', clips: [{ id: 'headline', asset: 'card', at: 0, sourceOut: 12 }] }],
    };`,
    ),
    writeFile(
      join(directory, 'Card.tsx'),
      `import './graphic.css';
      import { useGraphicFrame } from '@opencut/graphics/react';
      export default function Card() { return <div className="card">设计 {useGraphicFrame()}</div>; }`,
    ),
    writeFile(styles, '.card { background: #195a73; color: white; }'),
  ]);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, path);
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    const movie = workspace.getByLabel('Compiled timeline preview');
    await expect(status).toContainText('Preview ready', { timeout: 25_000 });
    const initial = await movie.getAttribute('src');
    expect(initial).toBeTruthy();

    await writeFile(styles, '.card { background: #ad3f2e; color: white; }');
    await expect(movie).not.toHaveAttribute('src', initial!, {
      timeout: 25_000,
    });
    await expect(status).toContainText('Preview ready');
    await workspace
      .getByRole('button', { name: 'Inspect clip headline' })
      .click();
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 0 / 11',
    );
    const updated = await movie.getAttribute('src');
    await writeFile(styles, '@import "./later.css";');
    await expect(status).toContainText('Showing last valid revision', {
      timeout: 25_000,
    });
    await expect(movie).toHaveAttribute('src', updated!);
    await writeFile(
      join(directory, 'later.css'),
      '.card { background: #546c3c; }',
    );
    await expect(movie).not.toHaveAttribute('src', updated!, {
      timeout: 25_000,
    });
    await expect(status).toContainText('Preview ready');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('offers TypeScript definitions and rejects a selected JSON project', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'json-desktop-'));
  const path = join(directory, 'review.video.json');
  const { application, page } = await launchDesktop();
  try {
    await writeFile(
      path,
      JSON.stringify({
        canvas: {
          width: 160,
          height: 90,
          frameRate: 12,
          durationFrames: 12,
          backgroundColor: '#195a73',
        },
        tracks: [],
      }),
    );
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as {
          filters?: { extensions: string[] }[];
        };
        if (
          options.filters?.flatMap(({ extensions }) => extensions).join() !==
          'ts'
        )
          throw new Error('Expected a TypeScript-only picker.');
        return { canceled: false, filePaths: [file] };
      };
    }, path);
    await page.getByRole('button', { name: 'Open definition' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Choose a .video.ts file.',
    );
    await expect(page.getByLabel('Definition review')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('desktop graphic export sends monotonic encoding progress', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'graphics-progress-'));
  const path = join(directory, 'review.video.ts');
  const output = join(directory, 'review.mp4');
  await Promise.all([
    writeFile(
      join(directory, 'Card.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>',
    ),
    writeFile(
      path,
      `export default {
      canvas: { width: 160, height: 90, frameRate: 12, durationFrames: 12 },
      assets: { card: { kind: 'graphic', renderer: 'svg', path: './Card.svg' } },
      tracks: [{ type: 'video', clips: [{ asset: 'card', at: 0, duration: 12 }] }],
    };`,
    ),
  ]);
  const { application, page } = await launchDesktop({
    XDG_CACHE_HOME: join(directory, 'cache'),
  });
  try {
    await application.evaluate(
      ({ dialog }, { path, output }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: output,
        });
      },
      { path, output },
    );
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    await expect(
      workspace.getByRole('status', { name: 'Compilation status' }),
    ).toContainText('Preview ready');
    const updates: number[] = [];
    await page.exposeFunction('recordExportProgress', (percent: number) => {
      updates.push(percent);
    });
    await page.evaluate(() => {
      const { recordExportProgress } = window as typeof window & {
        recordExportProgress: (percent: number) => Promise<void>;
      };
      window.opencut.onDefinitionExportProgress((percent) => {
        void recordExportProgress(percent);
      });
    });
    await workspace.getByRole('button', { name: 'Export MP4' }).click();
    await expect(workspace.getByLabel('Export result')).toContainText(
      'review.mp4',
    );
    expect(updates[0]).toBe(0);
    expect(updates.at(-1)).toBe(100);
    expect(updates).toEqual([...updates].sort((a, b) => a - b));
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
