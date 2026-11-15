#!/usr/bin/env node
import { parseCommandLine, printHelp, resolveCommand } from './commands.js';
import { UsageError } from './usage.js';

async function run(args: string[]) {
  const { values, positionals } = parseCommandLine(args);
  const { help, version, json } = values;
  if (positionals[0] === 'help') return printHelp(positionals.slice(1), json);
  if (help || !args.length) return printHelp(positionals, json);
  if (version) {
    if (
      positionals.length ||
      Object.keys(values).some((key) => key !== 'version' && key !== 'json')
    )
      throw new UsageError('--version takes no operands.');
    const { getApplicationInfo } = await import('@opencut/core');
    const info = getApplicationInfo();
    return console.log(json ? JSON.stringify(info) : info.version);
  }

  const { command, file } = resolveCommand(positionals, values);
  switch (command) {
    case 'recipes inspect':
    case 'recipes validate':
    case 'validate':
    case 'inspect':
    case 'render': {
      const { runVideoCommand } = await import('./video.js');
      return runVideoCommand(command, file, values);
    }
    case 'preview':
    case 'timeline inspect':
    case 'preview frame':
    case 'preview clip':
    case 'preview contact-sheet': {
      const { runInspectionCommand } = await import('./inspection.js');
      return runInspectionCommand(command, file, values);
    }
    case 'probe':
    case 'extract-frame':
    case 'separate-dialogue':
    case 'subtitles export':
    case 'online search':
    case 'online download': {
      const { runDefinitionTool } = await import('./definition-tools.js');
      return runDefinitionTool(command, file, values);
    }
    case 'system inspect': {
      const { inspectSystem, formatSystem } = await import('./system.js');
      const result = await inspectSystem();
      return console.log(json ? JSON.stringify(result) : formatSystem(result));
    }
  }
}

const args = process.argv.slice(2);
try {
  await run(args);
} catch (error) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  const usage =
    error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS_');
  const errorCode = usage
    ? 'INVALID_ARGUMENTS'
    : code ||
      (/Required executable|Install ELUATE/.test(message)
        ? 'MISSING_DEPENDENCY'
        : error instanceof Error && error.name === 'MediaError'
          ? 'PROCESSING_FAILED'
          : 'COMMAND_FAILED');
  const separator = args.indexOf('--');
  const json = (separator === -1 ? args : args.slice(0, separator)).includes(
    '--json',
  );
  process.stderr.write(
    json
      ? JSON.stringify({
          ok: false,
          error: {
            code: errorCode,
            message,
            ...(usage && { hint: 'Run opencut --help for usage.' }),
          },
        }) + '\n'
      : `opencut: ${message}\n`,
  );
  if (usage && !json) process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode ??= usage ? 2 : 1;
}
