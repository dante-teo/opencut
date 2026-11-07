import { Console } from 'node:console';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createProject, openProject } from '@opencut/sdk';
import type { OpenCutScript } from '@opencut/sdk';
import { discovery } from './discovery.js';
import { editOptions, UsageError } from './timeline.js';

export const scriptHelp = `Usage: opencut run <script.ts|script.mts> --project <project-file> [--create <name>] [--expected-revision <n>] [--dry-run] [--json] [-- <script-args>]

Execute trusted local TypeScript. Default-export an async or synchronous function
that receives { project, args, dryRun, signal } and returns optional JSON data.
The project is opened through the active desktop session when available.
With --create, stage a new project at a destination that does not exist.
Staged edits save as one undo step only after the function and result serialization succeed.
--dry-run validates the save without publishing; SDK previews and renders are disabled.
Console logs go to stderr. Stdout contains one JSON result.
`;

class ScriptError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runScriptCommand(args: string[]): Promise<void> {
  const separator = args.indexOf('--');
  const { values, positionals } = parseArgs({
    args: separator === -1 ? args : args.slice(0, separator),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      project: { type: 'string' },
      create: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'expected-revision': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      values.json
        ? JSON.stringify(discovery(['run'], scriptHelp), null, 2)
        : scriptHelp,
    );
    return;
  }
  const [file] = positionals;
  if (
    positionals.length !== 1 ||
    !file ||
    !['.ts', '.mts'].includes(extname(file))
  )
    throw new UsageError('run requires one local .ts or .mts script.');
  const { project, create } = values;
  if (!project?.trim())
    throw new UsageError('run requires --project <project-file>.');
  if (
    create !== undefined &&
    (!create.trim() || values['expected-revision'] !== undefined)
  )
    throw new UsageError(
      '--create requires a nonblank name and cannot be combined with --expected-revision.',
    );
  const options = editOptions(values);
  const scriptPath = resolve(file);
  const controller = new AbortController();
  const { signal } = controller;
  let cancellationCode = 130;
  const cancel = (name: NodeJS.Signals) => {
    cancellationCode = name === 'SIGTERM' ? 143 : 130;
    controller.abort(
      new ScriptError('SCRIPT_CANCELLED', `Script cancelled by ${name}.`),
    );
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  const originalConsole = globalThis.console;
  globalThis.console = new Console(process.stderr);
  try {
    const settings = { ...options, signal };
    const editor =
      create === undefined
        ? await openProject(project, settings)
        : await createProject(project, { name: create }, settings);
    let entry: unknown;
    try {
      entry = (await import(pathToFileURL(scriptPath).href)).default;
    } catch (cause) {
      throw new ScriptError(
        'SCRIPT_LOAD_FAILED',
        `Cannot load script '${scriptPath}': ${message(cause)}`,
        { cause },
      );
    }
    if (typeof entry !== 'function')
      throw new ScriptError(
        'INVALID_SCRIPT',
        'Default-export a function that accepts the OpenCut script context.',
      );
    signal.throwIfAborted();
    let result: unknown;
    try {
      result = await (entry as OpenCutScript)({
        project: editor.project,
        args: separator === -1 ? [] : args.slice(separator + 1),
        dryRun: options.dryRun ?? false,
        signal,
      });
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause) throw cause;
      throw new ScriptError('SCRIPT_FAILED', message(cause), { cause });
    }
    let data: unknown;
    try {
      const json = JSON.stringify(result ?? null);
      if (json === undefined) throw new TypeError('Expected a JSON value.');
      data = JSON.parse(json) as unknown;
    } catch (cause) {
      throw new ScriptError(
        'INVALID_SCRIPT_RESULT',
        `Return JSON data: ${message(cause)}`,
        { cause },
      );
    }
    if (process.exitCode)
      throw new ScriptError('SCRIPT_FAILED', 'Script set a failure exit code.');
    const saved = await editor.save({
      label: `script: ${basename(scriptPath)}`,
    });
    process.stdout.write(
      JSON.stringify(
        { scriptVersion: 1, ok: true, ...saved, result: data },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    if (signal.aborted) {
      process.exitCode = cancellationCode;
      signal.throwIfAborted();
    }
    process.exitCode = 1;
    throw error;
  } finally {
    globalThis.console = originalConsole;
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
