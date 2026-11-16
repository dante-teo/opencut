import { parseArgs } from 'node:util';
import {
  processingOptionHelp,
  processingOptionTypes,
} from './recipe-options.js';
import {
  qualityOption,
  renderOptionHelp,
  renderOptionTypes,
} from './render-options.js';
import { UsageError } from './usage.js';

const optionTypes = {
  ...processingOptionTypes,
  ...renderOptionTypes,
  output: { type: 'string', short: 'o' },
  root: { type: 'string' },
  resource: { type: 'string', multiple: true },
  params: { type: 'string' },
  variants: { type: 'string' },
  'output-dir': { type: 'string' },
  only: { type: 'string' },
  concurrency: { type: 'string' },
  'fail-fast': { type: 'boolean' },
  'temp-bytes': { type: 'string' },
  'memory-bytes': { type: 'string' },
  timestamp: { type: 'string' },
  frame: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  size: { type: 'string' },
  count: { type: 'string' },
  columns: { type: 'string' },
  watch: { type: 'boolean' },
  directory: { type: 'string' },
  result: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const definition = '<definition.video.ts>';
const params = '[--params <params.json>]';
const position = '(--frame <n> | --timestamp <time>)';
const previewOptions = ['quality', ...Object.keys(processingOptionTypes)];

const commands = {
  package: {
    args: `${definition} --output <new-directory> [--root <directory>] [--resource <path> ...] ${params}`,
    options: ['output', 'root', 'resource', 'params'],
  },
  'package verify': { args: '<directory>', options: [] },
  'build inspect': {
    args: `${definition} [--recipe-cache <directory>] [--no-subtitles] ${qualityOption} ${params}`,
    options: ['recipe-cache', 'no-subtitles', 'quality', 'params'],
  },
  validate: {
    args: `${definition} ${params}`,
    options: ['params', ...Object.keys(processingOptionTypes)],
  },
  inspect: {
    args: `${definition} ${params}`,
    options: ['params', ...Object.keys(processingOptionTypes)],
  },
  'recipes inspect': {
    args: `${definition} ${qualityOption} ${params}`,
    options: ['quality', 'params'],
  },
  'recipes validate': {
    args: `${definition} ${qualityOption} ${params}`,
    options: ['quality', 'params'],
  },
  'timeline inspect': {
    args: `${definition} ${position} ${qualityOption} ${params}`,
    options: ['frame', 'timestamp', 'quality', 'params'],
  },
  render: {
    args: `${definition} --output <new.mp4> ${qualityOption} ${params}`,
    options: [
      'output',
      'params',
      ...Object.keys(renderOptionTypes),
      ...Object.keys(processingOptionTypes),
    ],
  },
  batch: {
    args: `${definition} --variants <variants.json> --output-dir <directory> [--only <id,id>] [--concurrency <1..8>] [--fail-fast] [--temp-bytes <bytes>] [--memory-bytes <bytes>]`,
    options: [
      'variants',
      'output-dir',
      'only',
      'concurrency',
      'fail-fast',
      'temp-bytes',
      'memory-bytes',
      ...Object.keys(renderOptionTypes).filter((key) => key !== 'overwrite'),
      ...Object.keys(processingOptionTypes).filter(
        (key) => key !== 'recipe-workers',
      ),
    ],
  },
  preview: {
    args: `${definition} --watch [--size <64..1920>] ${qualityOption}`,
    options: ['watch', 'size', ...previewOptions],
  },
  'preview frame': {
    args: `${definition} ${position} --output <new.png> [--size <64..1920>] ${qualityOption} ${params}`,
    options: [
      'frame',
      'timestamp',
      'output',
      'size',
      'params',
      ...previewOptions,
    ],
  },
  'preview clip': {
    args: `${definition} --from <n> --to <n> --output <new.mp4> [--size <64..1920>] ${qualityOption} ${params}`,
    options: ['from', 'to', 'output', 'size', 'params', ...previewOptions],
  },
  'preview contact-sheet': {
    args: `${definition} --output <new.png> [--from <n>] [--to <n>] [--count <1..16>] [--columns <1..16>] [--size <64..640>] ${qualityOption} ${params}`,
    options: [
      'from',
      'to',
      'output',
      'size',
      'count',
      'columns',
      'params',
      ...previewOptions,
    ],
  },
  'subtitles export': {
    args: `${definition} --output <new.srt|new.vtt> ${params}`,
    options: ['output', 'params'],
  },
  probe: { args: '<media>', options: [] },
  'extract-frame': {
    args: '<media> --timestamp <seconds> --output <new.png>',
    options: ['timestamp', 'output'],
  },
  'separate-dialogue': {
    args: '<media> --output <new-directory>',
    options: ['output'],
  },
  'online search': { args: '<request.json>', options: [] },
  'online download': {
    args: '<request.json> --result <id|index> --directory <media-directory>',
    options: ['result', 'directory'],
  },
  'system inspect': { args: '', options: [] },
} satisfies Record<string, { args: string; options: string[] }>;

type Command = keyof typeof commands;
const commandNames = Object.keys(commands) as Command[];

export function parseCommandLine(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: optionTypes });
}

export type CommandOptions = ReturnType<typeof parseCommandLine>['values'];

function isCommand(name: string): name is Command {
  return Object.hasOwn(commands, name);
}

function isSubcommand(name: Command, group: string) {
  return name.startsWith(group + ' ');
}

export function commandUsage(command: Command) {
  const { args } = commands[command];
  return `opencut ${command}${args ? ' ' + args : ''} [--json]`;
}

export function resolveCommand(positionals: string[], options: CommandOptions) {
  const [group] = positionals;
  if (!group) throw new UsageError('Choose an OpenCut command.');
  const qualified = positionals.slice(0, 2).join(' ');
  const command = isCommand(qualified) ? qualified : group;
  if (!isCommand(command))
    throw new UsageError(
      `Unknown command '${
        commandNames.some((name) => isSubcommand(name, group))
          ? qualified
          : group
      }'.`,
    );

  const allowed: readonly string[] = commands[command].options;
  for (const key of Object.keys(options))
    if (key !== 'json' && !allowed.includes(key))
      throw new UsageError(`--${key} does not apply to ${command}.`);

  const operands = positionals.slice(command.includes(' ') ? 2 : 1);
  if (
    operands.length !== (commands[command].args ? 1 : 0) ||
    operands.some((operand) => !operand.trim())
  )
    throw new UsageError(`Usage: ${commandUsage(command)}`);
  return { command, file: operands[0] ?? '' };
}

export function printHelp(positionals: string[], json: boolean | undefined) {
  const [group = ''] = positionals;
  const qualified = positionals.slice(0, 2).join(' ');
  // Help for an invocation ignores operands, including the preview filename.
  const scope =
    isCommand(qualified) ||
    (!isCommand(group) &&
      commandNames.some((name) => isSubcommand(name, group)))
      ? qualified
      : group;
  const selected = commandNames
    .filter((name) => !scope || name === scope || isSubcommand(name, scope))
    .map((name) => ({
      name,
      usage: commandUsage(name),
      ...(!commands[name].args && { arguments: [] }),
    }));
  if (!selected.length) throw new UsageError(`Unknown command '${scope}'.`);
  const help = [
    'Usage: opencut <command> [options]',
    ...selected.map(({ usage }) => '  ' + usage),
    ...(['render', 'batch'].includes(scope)
      ? [
          scope === 'batch'
            ? renderOptionHelp.replace(' --overwrite', '')
            : renderOptionHelp,
        ]
      : []),
    ...(['render', 'batch', 'validate', 'inspect'].includes(scope) ||
    scope.startsWith('preview')
      ? [
          scope === 'batch'
            ? processingOptionHelp.replace(' --recipe-workers <count>', '')
            : processingOptionHelp,
        ]
      : []),
  ].join('\n');
  console.log(
    json ? JSON.stringify({ commands: selected, help }, null, 2) : help,
  );
}
