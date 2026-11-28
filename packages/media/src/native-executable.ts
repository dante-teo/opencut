import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };

const exec = promisify(execFile);

export async function inspectNativeExecutable(
  executable: URL,
  protocol?: number,
) {
  try {
    const { stdout } = await exec(
      fileURLToPath(executable),
      [protocol === undefined ? '--version' : '--protocol'],
      { timeout: 3000, maxBuffer: 1024 },
    );
    const [version = '', reported] = stdout.trim().split(' ');
    const matches =
      protocol === undefined
        ? stdout.trim() === manifest.version
        : stdout.trim() === `${manifest.version} ${protocol}`;
    return {
      status: matches ? 'available' : 'version-mismatch',
      version: protocol === undefined ? stdout.trim() : version,
      ...(protocol !== undefined && { protocol: Number(reported) || null }),
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
