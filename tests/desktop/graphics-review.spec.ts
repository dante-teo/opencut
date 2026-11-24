import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
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
      assets: {
        card: { kind: 'graphic', renderer: 'svg', path: './Card.svg' },
        tone: { kind: 'audio', path: '../audio-tone.wav' },
      },
      tracks: [
        { type: 'video', clips: [{ asset: 'card', at: 0, duration: 12 }] },
        { type: 'audio', audioRole: 'music', clips: [{ asset: 'tone', at: 0, sourceOut: 12 }] },
      ],
      professionalMix: { preset: 'natural-cinematic' },
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

test('imports and edits an Anime.js clip, then reopens the saved split', async () => {
  test.setTimeout(65_000);
  const directory = await mkdtemp(join(fixtureDirectory, 'anime-desktop-'));
  const project = join(directory, 'empty.video.ts');
  const component = join(directory, 'Card.tsx');
  const imported = join(directory, 'imported.video.ts');
  const revised = join(directory, 'revised.video.ts');
  const split = join(directory, 'split.video.ts');
  await Promise.all([
    writeFile(
      project,
      `export default {
      canvas: { width: 160, height: 90, frameRate: 12, durationFrames: 20 },
      tracks: [],
    };`,
    ),
    writeFile(
      component,
      `import { useRef } from 'react';
      import { useGraphicTimeline } from '@opencut/graphics/anime';
      export default function Card({ title }) {
        const root = useRef(null);
        useGraphicTimeline(root, (timeline) => {
          timeline.add('.title', { translateX: [0, 50], duration: 900 }, 0);
        });
        return <div ref={root}><span className="title" style={{display:'inline-block', color:'white'}}>{title}</span></div>;
      }`,
    ),
  ]);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(
      ({ dialog }, files) => {
        const opens = [files.project, files.component, files.split];
        const saves = [files.imported, files.revised, files.split];
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [opens.shift()!],
        });
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: saves.shift()!,
        });
      },
      { project, component, imported, revised, split },
    );
    const workspace = page.getByLabel('Definition review');
    const status = workspace.getByRole('status', {
      name: 'Compilation status',
    });
    const ready = () =>
      expect(status).toContainText('Preview ready', { timeout: 25_000 });
    await page.getByRole('button', { name: 'Open definition' }).click();
    await ready();
    await workspace.getByText('Motion graphics', { exact: true }).click();
    await workspace
      .getByText('Import React composition', { exact: true })
      .click();
    await workspace.getByLabel('Source duration (frames)').fill('12');
    await workspace
      .getByLabel('Composition settings (JSON)')
      .fill(
        '{"options":{"parameters":{"title":"string"}},"props":{"title":"Original"}}',
      );
    await workspace
      .getByRole('button', { name: 'Choose TSX and save as…' })
      .click();
    await expect(workspace.getByText('imported.video.ts')).toBeVisible();
    await ready();
    await workspace.getByText('Motion graphics', { exact: true }).click();
    await workspace
      .getByRole('button', { name: /Inspect clip motion-/ })
      .click();
    const clip = workspace.getByRole('form', { name: 'Selected motion clip' });
    await expect(clip.getByLabel('title', { exact: true })).toHaveValue(
      'Original',
    );
    await clip.getByLabel('title', { exact: true }).fill('Revised');
    await clip.getByLabel('Timeline start').fill('1');
    await clip.getByLabel('Source in').fill('2');
    await clip.getByLabel('Source out (exclusive)').fill('10');
    await clip.getByRole('button', { name: 'Save edit as…' }).click();
    await expect(workspace.getByText('revised.video.ts')).toBeVisible();
    await ready();
    await workspace.getByText('Motion graphics', { exact: true }).click();
    await workspace
      .getByRole('button', { name: /Inspect clip motion-/ })
      .click();
    await expect(clip.getByLabel('title', { exact: true })).toHaveValue(
      'Revised',
    );
    await expect(clip.getByLabel('Source in')).toHaveValue('2');
    await workspace.getByRole('button', { name: 'Next frame' }).click();
    await expect(workspace.getByLabel('Current frame')).toHaveText(
      'Frame 2 / 19',
    );
    await clip.getByRole('button', { name: 'Split at frame 2…' }).click();
    await expect(workspace.getByText('split.video.ts')).toBeVisible();
    await ready();
    await workspace.getByRole('button', { name: 'Close definition' }).click();
    await page.getByRole('button', { name: 'Open definition' }).click();
    await ready();
    await expect(
      workspace.getByRole('button', { name: /Inspect clip motion-/ }),
    ).toHaveCount(2);
    const movie = workspace.getByLabel('Compiled timeline preview');
    const paused = () =>
      movie.evaluate((element: HTMLVideoElement) => element.currentTime);
    await workspace.getByRole('button', { name: 'Next frame' }).click();
    const time = await paused();
    await setTimeout(450);
    expect(await paused()).toBe(time);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('blocks splits inside a transition and discards a pending motion save on close', async () => {
  const directory = await mkdtemp(join(fixtureDirectory, 'anime-save-close-'));
  const project = join(directory, 'review.video.ts');
  const output = join(directory, 'revised.video.ts');
  await Promise.all([
    writeFile(
      project,
      `export default {
      canvas: { width: 160, height: 90, frameRate: 12, durationFrames: 14 },
      assets: { card: {
        kind: 'graphic', renderer: 'react', path: 'Card.tsx', durationFrames: 14,
        animation: { version: 1 },
      } },
      tracks: [{ type: 'video', clips: [{ id: 'headline', asset: 'card', at: 0, sourceOut: 14 }] }],
      transitions: [{ id: 'entrance', kind: 'fade-in', clipId: 'headline', frames: 8 }],
    };`,
    ),
    writeFile(
      join(directory, 'Card.tsx'),
      'export default function Card() { return <span>Sample</span>; }',
    ),
  ]);
  const { application, page } = await launchDesktop();
  try {
    await application.evaluate(
      ({ dialog }, { project, output }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [project],
        });
        dialog.showSaveDialog = () =>
          new Promise((resolve) => {
            Reflect.set(dialog, 'finishMotionSave', () =>
              resolve({ canceled: false, filePath: output }),
            );
          });
      },
      { project, output },
    );
    await page.getByRole('button', { name: 'Open definition' }).click();
    const workspace = page.getByLabel('Definition review');
    await expect(
      workspace.getByRole('status', { name: 'Compilation status' }),
    ).toContainText('Preview ready');
    await workspace.getByText('Motion graphics', { exact: true }).click();
    await workspace
      .getByRole('button', { name: 'Inspect clip headline' })
      .click();
    await workspace.getByRole('button', { name: 'Next frame' }).click();
    await expect(
      workspace.getByRole('button', { name: 'Split at frame 1…' }),
    ).toBeDisabled();
    await expect(
      page.evaluate(() =>
        window.opencut.editMotion(1, {
          operation: 'split',
          clip: 'headline',
          at: 1,
        }),
      ),
    ).rejects.toThrow(/edge of the clip’s transition/);

    const save = page.evaluate(() =>
      window.opencut.editMotion(1, {
        operation: 'split',
        clip: 'headline',
        at: 8,
      }),
    );
    await expect
      .poll(() =>
        application.evaluate(({ dialog }) =>
          Reflect.has(dialog, 'finishMotionSave'),
        ),
      )
      .toBe(true);
    const closed = page.evaluate(() => window.opencut.closeDefinition());
    await expect(workspace).toHaveCount(0);
    await application.evaluate(({ dialog }) =>
      Reflect.get(dialog, 'finishMotionSave')(),
    );
    expect(await save).toBe(false);
    await closed;
    await expect(workspace).toHaveCount(0);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
