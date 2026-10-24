#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { getApplicationInfo } from '@opencut/core';
import { extractFrame, probeMedia } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';

const help = `Usage: opencut [command] [options]

OpenCut — media inspection and frame extraction (T02).
Editing commands are not implemented yet.

Commands:
  probe <file>                         Inspect local media metadata
  extract-frame <file> --timestamp <s> --output <file.png>
                                       Extract one PNG frame, without overwriting

Options:
  -h, --help     Show this help
  -v, --version  Show the application version
  --json        Print media command results as JSON
  --timestamp   Frame timestamp in nonnegative decimal seconds
  --output      New PNG output path (parent directory must exist)

Media commands require ffprobe on PATH; extraction also requires ffmpeg.
Exit codes: 0 success, 1 runtime/media failure, 2 invalid arguments.
`;

class UsageError extends Error {}

function formatProbe(media: MediaMetadata): string {
  const { video, audio } = media;
  return [
    `File: ${media.path}`,
    `Format: ${media.formatName ?? 'unknown'}`,
    `Duration: ${media.durationSeconds === null ? 'unknown' : `${media.durationSeconds} s`}`,
    `Video: ${video ? `${video.codec ?? 'unknown'}, ${video.width ?? '?'}x${video.height ?? '?'}, ${video.frameRate ?? '?'} fps` : 'none'}`,
    `Audio: ${audio ? `${audio.codec ?? 'unknown'}, ${audio.sampleRate ?? '?'} Hz, ${audio.channels ?? '?'} channels` : 'none'}`,
    `Streams: ${media.streams.length}`,
    '',
  ].join('\n');
}

async function runCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      timestamp: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: false,
  });
  if (values.help || args.length === 0) {
    process.stdout.write(help);
    return;
  }
  if (
    values.version &&
    positionals.length === 0 &&
    !values.json &&
    values.timestamp === undefined &&
    values.output === undefined
  ) {
    process.stdout.write(`${getApplicationInfo().version}\n`);
    return;
  }

  const [command, file] = positionals;
  if (
    values.version ||
    positionals.length !== 2 ||
    !file ||
    !['probe', 'extract-frame'].includes(command ?? '')
  ) {
    throw new UsageError(
      'Expected probe <file> or extract-frame <file> --timestamp <seconds> --output <file.png>.',
    );
  }
  if (command === 'probe') {
    if (values.timestamp !== undefined || values.output !== undefined) {
      throw new UsageError(
        '--timestamp and --output apply only to extract-frame.',
      );
    }
    const media = await probeMedia(file);
    process.stdout.write(
      values.json ? `${JSON.stringify(media, null, 2)}\n` : formatProbe(media),
    );
    return;
  }

  const timestamp = values.timestamp;
  if (
    timestamp === undefined ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(timestamp) ||
    !Number.isFinite(Number(timestamp)) ||
    !values.output
  ) {
    throw new UsageError(
      'extract-frame requires --timestamp <nonnegative decimal seconds> and --output <file.png>.',
    );
  }
  if (!values.output.toLowerCase().endsWith('.png')) {
    throw new UsageError('--output must have a .png extension.');
  }
  const frame = await extractFrame(file, Number(timestamp), values.output);
  process.stdout.write(
    values.json
      ? `${JSON.stringify(frame, null, 2)}\n`
      : `Saved frame at ${frame.timestampSeconds}s to ${frame.path}\n`,
  );
}

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const usageError =
    error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS_');
  process.stderr.write(
    `opencut: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (usageError) process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode = usageError ? 2 : 1;
}
