import { inspectNativeExecutable } from './native-executable.js';

async function inspectWorker(name: string) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    return { status: 'unsupported', version: null };
  return inspectNativeExecutable(new URL(name, import.meta.url));
}

export async function inspectVideoToolboxWorkers() {
  const [interpolation, enhancement] = await Promise.all([
    inspectWorker('video-interpolate'),
    inspectWorker('video-enhance'),
  ]);
  return { interpolation, enhancement };
}
