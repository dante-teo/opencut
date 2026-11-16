import assert from 'node:assert/strict';
import { log } from 'node:console';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { _electron as electron, expect } from '@playwright/test';

const archive = resolve(process.argv[2]);
const work = mkdtempSync(join(tmpdir(), 'opencut-review-smoke-'));
let application;
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, work]);
  const executablePath = join(
    work,
    'OpenCut Review.app/Contents/MacOS/OpenCut Review',
  );
  const project = join(work, 'project');
  mkdirSync(project);
  const fixtures = new URL('../../tests/distribution/', import.meta.url);
  for (const name of ['smoke.video.ts', 'title.ts'])
    copyFileSync(new URL(name, fixtures), join(project, name));
  writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
  const path = join(project, 'smoke.video.ts');
  const output = join(work, 'export.mp4');
  const env = {
    ...process.env,
    PATH: '/usr/bin:/bin',
    XDG_CACHE_HOME: join(work, 'cache'),
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  application = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + join(work, 'profile')],
    cwd: project,
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
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
  await page
    .getByRole('button', { name: 'Open definition', exact: true })
    .click();
  const exportButton = page.getByRole('button', { name: 'Export MP4' });
  await expect(exportButton).toBeEnabled({ timeout: 30000 });
  await exportButton.click();
  await expect(page.getByLabel('Export result')).toContainText('export.mp4');
  const frames = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_frames',
      '-of',
      'csv=p=0',
      output,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(frames.trim(), '12');
  log(
    'Packaged review app opened and exported an external TypeScript definition.',
  );
} finally {
  try {
    await application?.close();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
