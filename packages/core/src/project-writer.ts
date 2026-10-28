import { lstat, open } from 'node:fs/promises';
import { SessionError } from './session-transport.js';

/**
 * SQLite supplies an OS-backed exclusive lock, released even on SIGKILL. The
 * sidecar is permanent: unlinking a locked inode would allow a second writer.
 * No project content is stored in this database; JSON remains authoritative.
 */
export async function lockProject(path: string): Promise<() => void> {
  try {
    await lstat(`${path}.lock`);
    throw new SessionError(
      'PROJECT_LOCKED',
      'Project is locked by a legacy .lock. Confirm its writer has stopped before removing it.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const lockPath = `${path}.opencut-lock`;
  try {
    const file = await open(lockPath, 'wx', 0o600);
    await file.close();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const info = await lstat(lockPath);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  )
    throw new SessionError(
      'SESSION_SECURITY',
      'Writer sidecar must be a private regular file owned by the current user.',
    );
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(lockPath);
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    const current = await lstat(lockPath);
    if (current.ino !== info.ino || current.dev !== info.dev)
      throw new SessionError(
        'SESSION_SECURITY',
        'Writer sidecar changed during acquisition.',
      );
    return () => database.close();
  } catch (cause) {
    database.close();
    if (cause instanceof SessionError) throw cause;
    throw new SessionError(
      'PROJECT_LOCKED',
      'Project is locked by another writer. Retry when it finishes or its session is ready.',
    );
  }
}
