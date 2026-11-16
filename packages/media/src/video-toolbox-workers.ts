import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };

async function inspectWorker(name: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return { status: 'unsupported', version: null };
  try {
    const path = fileURLToPath(new URL(name, import.meta.url));
    const { stdout } = await promisify(execFile)(path, ['--version'], {
      timeout: 3000,
    });
    const version = stdout.trim();
    return {
      status: version === manifest.version ? 'available' : 'version-mismatch',
      version,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: code === 'ENOENT' ? 'missing' : 'unavailable',
      version: null,
    };
  }
}

export async function inspectVideoToolboxWorkers() {
  const [interpolation, enhancement] = await Promise.all([
    inspectWorker('video-interpolate'),
    inspectWorker('video-enhance'),
  ]);
  return { interpolation, enhancement };
}
