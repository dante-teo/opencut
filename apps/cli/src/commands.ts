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
  'picture-cache': { type: 'string' },
  'picture-version': { type: 'string' },
  'revision-evidence': { type: 'boolean' },
  'picture-from': { type: 'string' },
  preflight: { type: 'boolean' },
  'metadata-only': { type: 'boolean' },
  'source-comparison': { type: 'boolean' },
  'source-clip': { type: 'string' },
  'source-mapping': { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  language: { type: 'string' },
  transcript: { type: 'string' },
  marks: { type: 'string' },
  notes: { type: 'string' },
  candidate: { type: 'string', multiple: true },
  'candidate-report': { type: 'string' },
  'music-option': { type: 'string', multiple: true },
  'against-params': { type: 'string' },
  'against-music': { type: 'string' },
  'dry-run': { type: 'boolean' },
  'retry-source-change': { type: 'boolean' },
  'expect-fps': { type: 'string' },
  'mix-settings': { type: 'string' },
  'mix-comparison': { type: 'string' },
  'mix-cache': { type: 'string' },
  'music-candidate': { type: 'string' },
  'music-loudness': { type: 'string' },
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
  frames: { type: 'string' },
  timestamps: { type: 'string' },
  around: { type: 'string' },
  definition: { type: 'string' },
  edit: { type: 'string' },
  'context-source': { type: 'string' },
  'context-start': { type: 'string' },
  component: { type: 'string' },
  'render-report': { type: 'string' },
  'require-visual': { type: 'boolean' },
  against: { type: 'string' },
  boundaries: { type: 'string' },
  'luma-tolerance': { type: 'string' },
  'boundary-tolerance': { type: 'string' },
  'audio-master': { type: 'string' },
  'artifact-root': { type: 'string', multiple: true },
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

export const mixOptions = [
  'mix-settings',
  'mix-comparison',
  'mix-cache',
  'music-candidate',
  'music-loudness',
] as const;
const mixUsage =
  '[--mix-settings <mix.json>] [--mix-comparison <before|after>] [--mix-cache <directory>] [--music-candidate <id>] [--music-loudness <matched|authored>]';

const renderOptions = [
  'output',
  'params',
  'picture-cache',
  'picture-version',
  ...mixOptions,
  ...Object.keys(renderOptionTypes),
  ...Object.keys(processingOptionTypes),
];

const commands = {
  review: {
    args: `<definition.video.ts|export.mp4> (--source-comparison --definition <definition.video.ts> (--timestamp <time> | --from <frame> --to <frame>) [--source-clip <id>] [--source-mapping <mapping.json>] | --against <definition.video.ts|export.mp4>) --output <new-directory> [--marks <marks.json>] [--notes <notes.json>] [--candidate <definition.video.ts|export.mp4> ...] [--music-option <track-id> ...] [--against-music <track-id>] [--render-report <report.json>] [--candidate-report <report.json>] [--size <64..1920>] ${mixUsage} ${params}`,
    options: [
      'against',
      'source-comparison',
      'definition',
      'timestamp',
      'from',
      'to',
      'source-clip',
      'source-mapping',
      'output',
      'marks',
      'notes',
      'candidate',
      'candidate-report',
      'music-option',
      'against-music',
      'against-params',
      'render-report',
      'size',
      'quality',
      'params',
      ...mixOptions,
      ...Object.keys(processingOptionTypes),
    ],
  },
  remix: {
    args: `${definition} --picture-from <export.mp4> --render-report <report.json> --output <new.mp4> [--preflight] [--audio-bitrate <kbps>] [--audio-rate <44100|48000>] [--audio-channels <1|2>] ${mixUsage} ${params}`,
    options: [
      'picture-from',
      'render-report',
      'output',
      'preflight',
      'params',
      'audio-bitrate',
      'audio-rate',
      'audio-channels',
      ...mixOptions,
      ...Object.keys(processingOptionTypes),
    ],
  },
  'timeline patch': {
    args: `${definition} --edit <changes.json> (--dry-run | --output <new.video.ts>) ${params}`,
    options: ['edit', 'dry-run', 'output', 'params'],
  },
  'mix analyze': {
    args: `${definition} ${mixUsage} ${params}`,
    options: [
      'params',
      'audio-rate',
      'audio-channels',
      'audio-bitrate',
      ...mixOptions,
      ...Object.keys(processingOptionTypes),
    ],
  },
  convert: { args: '<definition.video.json>', options: [] },
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
    args: `${definition} [--retry-source-change] ${params}`,
    options: [
      'params',
      'retry-source-change',
      ...Object.keys(processingOptionTypes),
    ],
  },
  inspect: {
    args: `${definition} ${params}`,
    options: ['params', ...Object.keys(processingOptionTypes)],
  },
  'inspect dependencies': {
    args: `${definition} [--artifact-root <directory> ...] [--render-report <report.json>] [--recipe-cache <directory>] ${params}`,
    options: ['artifact-root', 'render-report', 'recipe-cache', 'params'],
  },
  'recipes inspect': {
    args: `${definition} ${qualityOption} ${params}`,
    options: ['quality', 'params'],
  },
  'recipes validate': {
    args: `${definition} ${qualityOption} ${params}`,
    options: ['quality', 'params'],
  },
  'timeline edit-graphic': {
    args: `${definition} --edit <edit.json> --output <new.video.ts> [--component <component.tsx>] ${params}`,
    options: ['edit', 'output', 'component', 'params'],
  },
  'timeline inspect': {
    args: `${definition} ${position} [--metadata-only] [--recipe-cache <directory>] ${qualityOption} ${params}`,
    options: [
      'frame',
      'timestamp',
      'quality',
      'params',
      'metadata-only',
      'recipe-cache',
    ],
  },
  render: {
    args: `${definition} --output <new.mp4> [--picture-cache <directory> [--picture-version <save|id>]] [--retry-source-change] [--revision-evidence] [--picture-from <baseline.mp4> --render-report <report.json> [--preflight]] ${qualityOption} ${mixUsage} ${params}`,
    options: [
      ...renderOptions,
      'retry-source-change',
      'revision-evidence',
      'picture-from',
      'render-report',
      'preflight',
    ],
  },
  'render plan': {
    args: `${definition} --output <delivery.mp4> [--picture-cache <directory> [--picture-version <save|id>]] ${qualityOption} ${mixUsage} ${params}`,
    options: renderOptions,
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
    args: `${definition} --watch [--size <64..1920>] ${qualityOption} ${mixUsage} ${params}`,
    options: ['watch', 'size', 'params', ...previewOptions, ...mixOptions],
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
    args: `${definition} --from <n> --to <n> --output <new.mp4> [--size <64..1920>] ${qualityOption} ${mixUsage} ${params}`,
    options: [
      'from',
      'to',
      'output',
      'size',
      'params',
      ...previewOptions,
      ...mixOptions,
    ],
  },
  'preview contact-sheet': {
    args: `<definition.video.ts|export.mp4> --output <new.png> [--frames <n,n>] [--timestamps <time,time>] [--around <cuts,captions,picture>] [--definition <definition.video.ts>] [--render-report <report.json>] [--from <n>] [--to <n>] [--count <1..16>] [--columns <1..16>] [--size <64..640>] [--retry-source-change] ${qualityOption} ${params}`,
    options: [
      'frames',
      'timestamps',
      'around',
      'definition',
      'render-report',
      'from',
      'to',
      'output',
      'size',
      'count',
      'columns',
      'params',
      'retry-source-change',
      ...previewOptions,
    ],
  },
  'verify export': {
    args: '<export.mp4> --against <approved-preview.mp4> --output <new-directory> [--frames <n,n>] [--boundaries <n,n>] [--render-report <report.json>] [--audio-master <master.mp4>] [--luma-tolerance <n>] [--boundary-tolerance <n>] [--size <64..640>]',
    options: [
      'against',
      'output',
      'frames',
      'boundaries',
      'render-report',
      'audio-master',
      'luma-tolerance',
      'boundary-tolerance',
      'size',
    ],
  },
  'subtitles export': {
    args: `${definition} --output <new.srt|new.vtt> ${params}`,
    options: ['output', 'params'],
  },
  probe: { args: '<media> [--expect-fps <n|n/d>]', options: ['expect-fps'] },
  'extract-frame': {
    args: '<media> --timestamp <seconds> --output <new.png>',
    options: ['timestamp', 'output'],
  },
  'separate-dialogue': {
    args: '<media> --output <new-directory>',
    options: ['output'],
  },
  'beauty capabilities': { args: '', options: [] },
  'beauty preflight': { args: '', options: [] },
  'beauty analyze': {
    args: '<media> [--recipe-cache <directory>] [--edit <corrections.json>] [--context-source <original-media> --context-start <seconds>]',
    options: [
      'recipe-cache',
      'recipe-temp-bytes',
      'recipe-memory-bytes',
      'recipe-timeout-ms',
      'edit',
      'context-source',
      'context-start',
    ],
  },
  'beauty inspect': {
    args: '<analysis-id> [--recipe-cache <directory>] [--output <new-directory>]',
    options: ['recipe-cache', 'output'],
  },
  'beauty validate': {
    args: definition + ' [--recipe-cache <directory>] ' + params,
    options: ['recipe-cache', 'params'],
  },
  'beauty evaluate': {
    args: '<media> --result <recipe-key> --from <source-frame> --to <source-frame> --output <new-directory> [--recipe-cache <directory>] [--notes <review.json>] [--require-visual]',
    options: [
      'result',
      'from',
      'to',
      'output',
      'recipe-cache',
      'notes',
      'require-visual',
    ],
  },
  'beauty remove': {
    args: '<analysis-id> [--recipe-cache <directory>]',
    options: ['recipe-cache'],
  },
  'online search': { args: '<request.json>', options: [] },
  'online download': {
    args: '<request.json> --result <id|index> --directory <media-directory>',
    options: ['result', 'directory'],
  },
  transcribe: {
    args: '<media> --output <new.json> [--start <time>] [--end <time>] [--language <name|auto>]',
    options: ['output', 'start', 'end', 'language'],
  },
  'transcript align': {
    args: '<media> --transcript <edited.json> --output <new.json> [--language <name>]',
    options: ['transcript', 'output', 'language'],
  },
  'transcript export': {
    args: '<transcript.json> --output <new.srt|new.vtt>',
    options: ['output'],
  },
  doctor: { args: '', options: [] },
  'models inspect': { args: '', options: [] },
  'models install': { args: '<bandit-v2>', options: [] },
  'models remove': { args: '<bandit-v2>', options: [] },
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
    (positionals.length > 1 &&
      !isCommand(group) &&
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
    ...(!scope ||
    ['validate', 'render', 'preview', 'package', 'doctor'].includes(scope)
      ? [
          '  Use opencut doctor --json to discover graphic scenes, adapters and prerequisites.',
        ]
      : []),
    ...(['render', 'render plan', 'batch'].includes(scope)
      ? [
          scope === 'batch'
            ? renderOptionHelp.replace(' --overwrite', '')
            : renderOptionHelp,
        ]
      : []),
    ...(['render', 'render plan', 'batch', 'validate', 'inspect'].includes(
      scope,
    ) || scope.startsWith('preview')
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
