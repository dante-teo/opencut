#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { getApplicationInfo } from '@opencut/core';
import { composeMedia, extractFrame, probeMedia } from '@opencut/media';
import type { MediaMetadata } from '@opencut/media';

const help = `Usage: opencut [command] [options]

OpenCut — media inspection, frame extraction and composition prototype (T03).
Project and timeline editing are not implemented yet.

Commands:
  probe <file>                         Inspect local media metadata
  extract-frame <file> --timestamp <s> --output <file.png>
                                       Extract one PNG frame, without overwriting
  compose <clip1> <clip2> [more clips] --music <audio> --output <new.mp4>
                                       Concatenate video and mix background music

Options:
  -h, --help     Show this help
  -v, --version  Show the application version
  --json        Print media command results as JSON
  --timestamp   Frame timestamp in nonnegative decimal seconds
  --output      New PNG/MP4 output path (parent directory must exist)
  --music       Background audio path (compose only; looped to fit)
  --width       Even output width, 2–3840 (compose default: 1280)
  --height      Even output height, 2–2160 (compose default: 720)
  --fps         Integer output frame rate, 1–60 (compose default: 30)
  --clip-volume Original audio gain, 0–1 (compose default: 1; 0 mutes)
  --music-volume Music gain, 0–1 (compose default: 0.25)

Media commands require ffprobe on PATH; extraction/composition also need ffmpeg.
Compose supports 2–16 clips, up to 600 seconds; exports H.264/AAC MP4.
Exit codes: 0 success, 1 runtime/media failure, 2 invalid arguments.
`;

class UsageError extends Error {}

function numericArgument(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
    !Number.isFinite(number) ||
    number < minimum ||
    number > maximum ||
    (integer && !Number.isInteger(number))
  ) {
    throw new UsageError(
      `--${name} requires ${integer ? 'an integer' : 'a decimal number'} between ${minimum} and ${maximum}.`,
    );
  }
  return number;
}

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
      music: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      'clip-volume': { type: 'string' },
      'music-volume': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: false,
  });
  if (values.help || args.length === 0) {
    process.stdout.write(help);
    return;
  }
  const hasCompositionOptions = [
    values.music,
    values.width,
    values.height,
    values.fps,
    values['clip-volume'],
    values['music-volume'],
  ].some((value) => value !== undefined);
  if (
    values.version &&
    positionals.length === 0 &&
    !values.json &&
    values.timestamp === undefined &&
    values.output === undefined &&
    !hasCompositionOptions
  ) {
    process.stdout.write(`${getApplicationInfo().version}\n`);
    return;
  }

  const [command, file] = positionals;
  if (command === 'compose' && !values.version) {
    const clips = positionals.slice(1);
    if (
      clips.length < 2 ||
      clips.length > 16 ||
      !values.music ||
      !values.output ||
      values.timestamp !== undefined
    ) {
      throw new UsageError(
        'compose requires 2–16 video clips, --music <audio> and --output <new.mp4>; --timestamp is not supported.',
      );
    }
    if (!values.output.toLowerCase().endsWith('.mp4'))
      throw new UsageError('--output must have a .mp4 extension.');
    const width = numericArgument('width', values.width, 1280, 2, 3840, true);
    const height = numericArgument('height', values.height, 720, 2, 2160, true);
    if (width % 2 || height % 2)
      throw new UsageError('--width and --height must be even.');
    const result = await composeMedia({
      clips,
      music: values.music,
      output: values.output,
      width,
      height,
      fps: numericArgument('fps', values.fps, 30, 1, 60, true),
      clipVolume: numericArgument(
        'clip-volume',
        values['clip-volume'],
        1,
        0,
        1,
      ),
      musicVolume: numericArgument(
        'music-volume',
        values['music-volume'],
        0.25,
        0,
        1,
      ),
    });
    process.stdout.write(
      values.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `Saved ${result.durationSeconds}s composition (${result.width}x${result.height}, ${result.fps} fps, H.264/AAC) to ${result.path}\n`,
    );
    return;
  }
  if (
    values.version ||
    positionals.length !== 2 ||
    !file ||
    !['probe', 'extract-frame'].includes(command ?? '')
  ) {
    throw new UsageError(
      'Expected probe <file>, extract-frame <file> --timestamp <seconds> --output <file.png>, or compose <clip1> <clip2> --music <audio> --output <new.mp4>.',
    );
  }
  if (hasCompositionOptions)
    throw new UsageError(
      '--music, --width, --height, --fps, --clip-volume and --music-volume apply only to compose.',
    );
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
