import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectNativeExecutable } from './native-executable.js';
import { MediaError } from './process.js';

type ProcessSelection = { pids: readonly number[] } | { group: number };

const mac = process.platform === 'darwin';
const nativeSampler = new URL('./process-memory', import.meta.url);
const sampler = mac ? fileURLToPath(nativeSampler) : '/bin/ps';
const reinstallHint = 'Reinstall OpenCut or rebuild @opencut/media.';

export async function inspectRenderMemory() {
  if (!mac) return { status: 'not-applicable', version: null } as const;
  const helper = await inspectNativeExecutable(nativeSampler);
  if (helper.status !== 'available')
    return {
      ...helper,
      hint: `OpenCut RSS helper: ${helper.status}. ${reinstallHint}`,
    };
  const sampled = await new Promise<boolean>((resolve) => {
    sampleProcessMemory({ pids: [process.pid] }, (error, bytes) =>
      resolve(!error && bytes > 0),
    );
  });
  return sampled
    ? helper
    : {
        ...helper,
        status: 'unavailable' as const,
        hint: `OpenCut RSS helper cannot sample memory. ${reinstallHint}`,
      };
}

export function sampleProcessMemory(
  selection: ProcessSelection,
  result: (failure: MediaError | null, bytes: number) => void,
) {
  const group = 'group' in selection;
  const fail = (
    cause: unknown,
    message = cause instanceof Error ? cause.message : String(cause),
  ) =>
    result(
      new MediaError(`Cannot sample native memory: ${message}`, { cause }),
      0,
    );
  try {
    execFile(
      sampler,
      sampleArguments(selection),
      { timeout: 1000, maxBuffer: mac ? 1024 : 1024 * 1024 },
      (error, stdout, stderr) => {
        const diagnostic = stderr.trim();
        if (error || diagnostic) {
          // ps exits with status 1 and no output if the requested PIDs are gone.
          if (
            !mac &&
            !group &&
            error?.code === 1 &&
            !stdout.trim() &&
            !diagnostic
          )
            result(null, 0);
          else if (mac && error?.code === 'ENOENT')
            fail(error, `OpenCut RSS helper is missing. ${reinstallHint}`);
          else fail(error ?? diagnostic, diagnostic || undefined);
          return;
        }
        let bytes: number;
        try {
          bytes = mac ? integer(stdout.trim()) : linuxRss(selection, stdout);
          if (!Number.isSafeInteger(bytes))
            throw new Error('Invalid RSS total.');
        } catch (cause) {
          fail(cause);
          return;
        }
        result(null, bytes);
      },
    );
  } catch (cause) {
    fail(cause);
  }
}

function sampleArguments(selection: ProcessSelection) {
  if ('group' in selection)
    return mac ? ['group', String(selection.group)] : ['-axo', 'pgid=,rss='];
  return mac
    ? ['pids', ...selection.pids.map(String)]
    : ['-o', 'rss=', '-p', selection.pids.join(',')];
}

function integer(value: string) {
  if (!/^\d+$/.test(value)) throw new Error('Invalid RSS sample.');
  return Number(value);
}

function linuxRss(selection: ProcessSelection, output: string) {
  const lines = output.trim().split('\n');
  let kib = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if ('group' in selection) {
      const [group = '', rss = ''] = line.trim().split(/\s+/);
      if (integer(group) === selection.group) kib += integer(rss);
    } else kib += integer(line.trim());
  }
  return kib * 1024;
}
