/** Private local transport for desktop review commands. */
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT = 30_000;

export class SessionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export async function reviewEndpoint(path: string): Promise<string> {
  if (process.platform === 'win32')
    throw new SessionError(
      'SESSION_UNSUPPORTED',
      'Desktop review controls require macOS or Linux.',
    );
  // Stable across shell and app TMPDIR settings, and short enough for sockaddr_un.
  const directory = join('/tmp', `oc-session-${process.getuid!()}`);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  )
    throw new SessionError(
      'SESSION_SECURITY',
      'Session directory must be owned by the current user with mode 0700.',
    );
  return join(
    directory,
    createHash('sha256')
      .update('review:' + path)
      .digest('hex')
      .slice(0, 32) + '.sock',
  );
}

function frame(
  socket: Socket,
  receive: (value: unknown) => void,
  fail: (error: Error) => void,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  socket.setTimeout(TIMEOUT, () =>
    socket.destroy(
      new SessionError(
        'SESSION_TIMEOUT',
        'The review control request timed out.',
      ),
    ),
  );
  socket.on('data', (chunk: Buffer) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BYTES) {
      done = true;
      socket.destroy(
        new SessionError(
          'SESSION_TOO_LARGE',
          'Session message exceeds 64 MiB.',
        ),
      );
      return;
    }
    chunks.push(chunk);
    if (!chunk.includes(10)) return;
    done = true;
    try {
      receive(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function encode(value: unknown): string {
  const json = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(json) > MAX_BYTES)
    throw new SessionError(
      'SESSION_TOO_LARGE',
      'Session message exceeds 64 MiB.',
    );
  return json;
}

/** Only failure to connect means there is no session. Never replay a sent request. */
export async function requestSession(
  address: string,
  request: unknown,
): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    let connected = false;
    let finished = false;
    const socket = createConnection(address);
    const finish = (value: unknown, ...failure: [] | [unknown]) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (failure.length) reject(failure[0]);
      else resolve(value);
    };
    socket.on('connect', () => {
      connected = true;
      try {
        const payload = encode(request);
        socket.write(payload);
      } catch (error) {
        finish(undefined, error);
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (
        !connected &&
        (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
      )
        finish(undefined);
      else
        finish(
          undefined,
          new SessionError(
            'SESSION_DISCONNECTED',
            'The desktop review connection was lost.',
          ),
        );
    });
    socket.on('close', () => {
      if (!finished)
        finish(
          undefined,
          new SessionError(
            'SESSION_DISCONNECTED',
            'The desktop review connection closed without a reply.',
          ),
        );
    });
    frame(
      socket,
      (response) => {
        if (!response || typeof response !== 'object' || !('ok' in response)) {
          throw new SessionError('SESSION_PROTOCOL', 'Invalid session reply.');
        } else if (response.ok === false && 'error' in response) {
          const error = response.error as { code: string; message: string };
          finish(undefined, new SessionError(error.code, error.message));
        } else if ('value' in response) finish(response.value);
        else
          throw new SessionError('SESSION_PROTOCOL', 'Invalid session reply.');
      },
      (error) => finish(undefined, error),
    );
  });
}

/** Caller must hold the endpoint lock before removing a stale socket. */
export async function serveSession(
  address: string,
  handle: (request: unknown) => Promise<unknown>,
): Promise<() => Promise<void>> {
  await unlink(address).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const fail = (error: Error) => {
      const code = 'code' in error ? String(error.code) : 'SESSION_FAILED';
      if (!socket.destroyed)
        socket.end(
          encode({ ok: false, error: { code, message: error.message } }),
        );
    };
    frame(
      socket,
      (request) => {
        void handle(request)
          .then((value) => {
            if (!socket.destroyed) socket.end(encode({ ok: true, value }));
          })
          .catch(fail);
      },
      fail,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    // net.Server removes its own Unix socket on close, while ownership is held.
  };
  try {
    await chmod(address, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  server.unref();
  return close;
}
