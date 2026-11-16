import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };

const exec = promisify(execFile);

export async function inspectNativeExecutable(executable: URL) {
  try {
    const { stdout } = await exec(fileURLToPath(executable), ['--version'], {
      timeout: 3000,
      maxBuffer: 1024,
    });
    const version = stdout.trim();
    return {
      status: version === manifest.version ? 'available' : 'version-mismatch',
      version,
    } as const;
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unavailable',
      version: null,
    } as const;
  }
}
