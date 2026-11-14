import { parseArgs } from 'node:util';
import { LocalJobs, type JobState, type LocalJobRequest } from '@opencut/sdk';
import { UsageError } from './timeline.js';

export const jobsHelp = `Usage: opencut jobs submit <project-file> [--idempotency-key <key>] [--expected-revision <n>] [--quality <preset>] [--resolution <preset>] [--codec <codec>] [--no-subtitles] [--json]
       opencut jobs status|cancel <job-id> [--json]
       opencut jobs retry <job-id> --attempt <n> [--json]
       opencut jobs list [--state <state>] [--json]
       opencut jobs start [--json]
       opencut jobs limits [--json]
       opencut jobs configure --concurrency <n> --cpu-seconds <n> --job-memory-mib <n> --scratch-mib <n> [--json]
Add --directory <path> to select a private local queue.
Output is published in that queue. Status includes the captured revision, progress, logs, and completed output path.
`;

export async function runJobsCommand(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'idempotency-key': { type: 'string' },
      'expected-revision': { type: 'string' },
      quality: { type: 'string' },
      resolution: { type: 'string' },
      codec: { type: 'string' },
      'no-subtitles': { type: 'boolean' },
      state: { type: 'string' },
      attempt: { type: 'string' },
      concurrency: { type: 'string' },
      'cpu-seconds': { type: 'string' },
      'job-memory-mib': { type: 'string' },
      'scratch-mib': { type: 'string' },
    },
  });
  const [action, argument] = positionals;
  if (values.help || !action) {
    process.stdout.write(
      values.json ? JSON.stringify({ help: jobsHelp }) + '\n' : jobsHelp,
    );
    return;
  }
  const options = {
    submit: [
      'idempotency-key',
      'expected-revision',
      'quality',
      'resolution',
      'codec',
      'no-subtitles',
    ],
    list: ['state'],
    status: [],
    cancel: [],
    retry: ['attempt'],
    start: [],
    limits: [],
    configure: ['concurrency', 'cpu-seconds', 'job-memory-mib', 'scratch-mib'],
  };
  if (!Object.hasOwn(options, action))
    throw new UsageError('Choose a jobs action. Run jobs --help for usage.');
  const allowed = [
    ...options[action as keyof typeof options],
    'directory',
    'json',
  ];
  for (const key of Object.keys(values))
    if (!allowed.includes(key))
      throw new UsageError(`--${key} does not apply to jobs ${action}.`);
  const takesArgument = ['submit', 'status', 'cancel', 'retry'].includes(
    action,
  );
  if (positionals.length !== (takesArgument ? 2 : 1))
    throw new UsageError(`Unexpected arguments. Run jobs --help for usage.`);
  function number(
    key:
      | 'attempt'
      | 'expected-revision'
      | 'concurrency'
      | 'cpu-seconds'
      | 'job-memory-mib'
      | 'scratch-mib',
  ) {
    const value = values[key];
    if (
      !value ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      (key !== 'expected-revision' && Number(value) < 1)
    )
      throw new UsageError(
        `--${key} requires a ${key === 'expected-revision' ? 'nonnegative' : 'positive'} integer.`,
      );
    return Number(value);
  }
  const jobs = new LocalJobs({ directory: values.directory });
  let result: unknown;
  switch (action) {
    case 'submit': {
      // The queue validates the enum values and the full persisted request.
      const parameters = {
        quality: values.quality,
        resolution: values.resolution,
        codec: values.codec,
        burnSubtitles: !values['no-subtitles'],
      } as LocalJobRequest['parameters'];
      result = await jobs.submit(
        {
          type: 'render',
          projectPath: argument!,
          expectedRevision:
            values['expected-revision'] === undefined
              ? undefined
              : number('expected-revision'),
          parameters,
        },
        { idempotencyKey: values['idempotency-key'] },
      );
      break;
    }
    case 'status':
      result = await jobs.status(argument!);
      break;
    case 'cancel':
      result = await jobs.cancel(argument!);
      break;
    case 'retry':
      result = await jobs.retry(argument!, number('attempt'));
      break;
    case 'list':
      result = await jobs.list(values.state as JobState | undefined);
      break;
    case 'limits':
      result = jobs.limits();
      break;
    case 'start':
      await jobs.start();
      result = { directory: jobs.directory };
      break;
    case 'configure':
      result = await jobs.configure({
        concurrency: number('concurrency'),
        cpuSecondsPerJob: number('cpu-seconds'),
        memoryMiB: number('job-memory-mib'),
        scratchMiB: number('scratch-mib'),
      });
      break;
  }
  process.stdout.write(
    JSON.stringify(result, undefined, values.json ? undefined : 2) + '\n',
  );
}
