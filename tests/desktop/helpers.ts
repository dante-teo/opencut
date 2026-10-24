import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const requireDesktop = createRequire(
  new URL('../../apps/desktop/package.json', import.meta.url),
);
export async function launchDesktop(extraEnv: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const application = await electron.launch({
    executablePath: requireDesktop('electron') as string,
    args: [resolve('apps/desktop')],
    env: { ...env, ...extraEnv },
  });
  try {
    const page = await application.firstWindow();
    await page.bringToFront();
    return { application, page };
  } catch (error) {
    await application.close();
    throw error;
  }
}

export async function chooseVideo(
  application: ElectronApplication,
  page: Page,
  path: string | null,
) {
  // Exercise the production picker IPC and protocol; only the native dialog is stubbed.
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: path === null,
      filePaths: path ? [path] : [],
    });
  }, path);
  await page.getByRole('button', { name: 'Open video', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open video', exact: true }),
  ).toBeEnabled({ timeout: 65000 });
  if (path !== null)
    await expect(
      page.getByRole('button', { name: 'Play', exact: true }),
    ).toBeEnabled({ timeout: 10000 });
}
