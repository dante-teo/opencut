import { execFile } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GiB = 1024 ** 3;

export function hostRenderResources() {
  const installedBytes = totalmem();
  const parallelism = availableParallelism();
  const appleSilicon =
    process.platform === 'darwin' && process.arch === 'arm64';
  // Reserve most unified memory for model/driver allocations, the OS and
  // the editor. Process RSS is only the part we can enforce directly.
  const nativeBudgetBytes = Math.min(
    appleSilicon ? 8 * GiB : 4 * GiB,
    Math.max(256 * 1024 ** 2, Math.floor(installedBytes / 4)),
  );
  const recipeWorkers = Math.max(
    1,
    Math.min(
      Math.floor(parallelism / 2),
      Math.floor(nativeBudgetBytes / GiB),
      4,
    ),
  );
  return { installedBytes, parallelism, nativeBudgetBytes, recipeWorkers };
}

export async function sampleMemoryPressure(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (process.platform !== 'darwin') return 'unavailable';
  try {
    const { stdout } = await exec(
      '/usr/sbin/sysctl',
      ['-n', 'kern.memorystatus_vm_pressure_level'],
      { timeout: 1000, signal },
    );
    switch (stdout.trim()) {
      case '1':
        return 'normal';
      case '2':
        return 'warning';
      case '4':
        return 'critical';
      default:
        return 'unavailable';
    }
  } catch {
    signal?.throwIfAborted();
    return 'unavailable';
  }
}
