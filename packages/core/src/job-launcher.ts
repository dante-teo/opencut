import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLease } from './job-store.js';

const entry = fileURLToPath(new URL('./job-worker.js', import.meta.url));
const flags = ['--disable-warning=ExperimentalWarning'];

export function workerLeasePath(directory: string) {
  return join(directory, 'worker.sqlite');
}

export async function wakeWorker(directory: string) {
  const release = tryLease(workerLeasePath(directory));
  if (!release) return;
  release();
  await launchWorker(directory);
}

/** Start a successor after releasing the worker lease. It will acquire its own lease. */
export function launchWorker(directory: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...flags, entry, 'worker', directory],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function spawnJobProcess(
  directory: string,
  role: 'guardian' | 'runner',
  job: { id: string; attempt: number },
) {
  return spawn(
    process.execPath,
    [...flags, entry, role, directory, job.id, String(job.attempt)],
    {
      detached: role === 'guardian',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
}
