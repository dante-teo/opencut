#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { getApplicationInfo } from '@opencut/core';

const help = `Usage: opencut [options]

OpenCut desktop video editor — CLI skeleton (T01).
Editing commands are not implemented yet.

Options:
  -h, --help     Show this help
  -v, --version  Show the application version

Exit codes: 0 success, 1 unexpected failure, 2 invalid arguments.
`;

try {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
    allowPositionals: false,
    allowNegative: false,
  });
  if (values.help || !values.version) {
    process.stdout.write(help);
  } else {
    process.stdout.write(`${getApplicationInfo().version}\n`);
  }
} catch (error) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const usageError = code.startsWith('ERR_PARSE_ARGS_');
  process.stderr.write(
    `opencut: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (usageError) process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode = usageError ? 2 : 1;
}
