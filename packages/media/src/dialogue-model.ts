import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import manifest from '../package.json' with { type: 'json' };
import { checkRenderSignal, MediaError } from './process.js';

const requiredVersion = '0.0.3';
const model = {
  name: 'bandit-v2',
  variant: 'multi',
  version: 'zenodo:12701995/v1',
  license: 'CC-BY-SA-4.0',
  source:
    'https://zenodo.org/records/12701995/files/checkpoint-multi.ckpt?download=1',
  sizeBytes: 446_680_129,
  sha256: 'abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc',
};
const exec = promisify(execFile);
const reportRuntime = [
  'import importlib.metadata, inspect, sys',
  'import eluate, torch, torchaudio',
  'assert sys.version_info >= (3, 10)',
  'assert "checkpoint" in inspect.signature(eluate.elute).parameters',
  'print("compatible")',
].join('\n');

export function dialoguePython() {
  return process.env.OPENCUT_DIALOGUE_PYTHON || 'python3';
}

function modelPath() {
  return join(homedir(), '.eluate', 'models', 'checkpoint-multi.ckpt');
}

async function inspectBackend(signal?: AbortSignal) {
  const python = dialoguePython();
  const options = {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
    ...(signal && { signal }),
  } as const;
  let version: string | null = null;
  try {
    const { stdout } = await exec(
      python,
      [
        '-I',
        '-c',
        'from importlib.metadata import version; print(version("eluate"))',
      ],
      options,
    );
    version = stdout.trim();
    if (version !== requiredVersion)
      return { status: 'version-mismatch', python, version, requiredVersion };
    const runtime = await exec(python, ['-I', '-c', reportRuntime], options);
    if (runtime.stdout.trim() === 'compatible')
      return { status: 'available', python, version, requiredVersion };
  } catch {
    checkRenderSignal(signal);
    return {
      status: version === null ? 'missing' : 'unavailable',
      python,
      version,
      requiredVersion,
    };
  }
  return { status: 'unavailable', python, version, requiredVersion };
}

async function inspectModel(path: string, signal?: AbortSignal) {
  try {
    const info = await lstat(path);
    checkRenderSignal(signal);
    if (!info.isFile() || info.size !== model.sizeBytes)
      return 'invalid' as const;
    const hash = createHash('sha256');
    const stream = createReadStream(path, signal && { signal });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex') === model.sha256
      ? ('verified' as const)
      : ('invalid' as const);
  } catch (error) {
    checkRenderSignal(signal);
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? ('missing' as const)
      : ('unreadable' as const);
  }
}

export async function inspectDialogueModel(signal?: AbortSignal) {
  checkRenderSignal(signal);
  const path = modelPath();
  const [backend, status] = await Promise.all([
    inspectBackend(signal),
    inspectModel(path, signal),
  ]);
  checkRenderSignal(signal);
  return {
    ready: status === 'verified' && backend.status === 'available',
    backend,
    model: { ...model, path, status },
  };
}

export async function installDialogueModel(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const path = modelPath();
  const status = await inspectModel(path);
  if (status === 'verified') return;
  if (status !== 'missing')
    throw new MediaError(
      'The existing Bandit v2 checkpoint could not be verified. Inspect or remove it before installing.',
    );
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(directory, '.opencut-'));
  try {
    const deadline = AbortSignal.timeout(15 * 60_000);
    const download = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(model.source, {
      redirect: 'error',
      headers: { 'User-Agent': 'OpenCut/' + manifest.version },
      signal: download,
    });
    if (!response.ok || !response.body)
      throw new MediaError(
        'Bandit v2 download failed (HTTP ' + response.status + ').',
      );
    const candidate = join(work, 'checkpoint');
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      response.body,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > model.sizeBytes)
            return callback(
              new MediaError('Bandit v2 download exceeded its expected size.'),
            );
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(candidate, { flags: 'wx', mode: 0o600 }),
      { signal: download },
    );
    if (size !== model.sizeBytes || hash.digest('hex') !== model.sha256)
      throw new MediaError('Bandit v2 checkpoint SHA-256 verification failed.');
    signal?.throwIfAborted();
    try {
      await link(candidate, path);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await inspectModel(path)) !== 'verified'
      )
        throw error;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function removeDialogueModel() {
  try {
    await unlink(modelPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
