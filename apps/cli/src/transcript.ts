import { execFile } from 'node:child_process';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  applyTranscriptTimings,
  fingerprintFile,
  matchesFingerprint,
  parseSubtitleTime,
  serializeSubtitles,
  speechBackendResultSchema,
  transcriptCues,
  transcriptSchema,
  validateTranscriptWindows,
} from '@opencut/core/video';
import type { Transcript } from '@opencut/core/video';
import {
  audioSourceDuration,
  audioSourceSeek,
  MediaError,
  probeMedia,
  runMediaTool,
  sourceIdentity,
} from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { readJsonArgument } from './json-argument.js';
import { UsageError } from './usage.js';
import type { CommandOptions } from './commands.js';

const exec = promisify(execFile);
const worker = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../native/transcript.py'
      : './transcript.py',
    import.meta.url,
  ),
);
const python = () => process.env.OPENCUT_SPEECH_PYTHON || 'python3';
const hint =
  'Use a Python environment with qwen-asr. Set OPENCUT_SPEECH_PYTHON, OPENCUT_QWEN_ASR_MODEL and OPENCUT_QWEN_ALIGNER_MODEL to local paths.';
type Readiness = {
  runtime: string | null;
  asrModel: boolean;
  alignerModel: boolean;
  alignmentLanguages: string[];
};

function callWorker(argument: string, timeout: number, signal?: AbortSignal) {
  return exec(python(), ['-B', worker, argument], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    ...(signal && { signal }),
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    },
  });
}

export async function inspectSpeechRuntime() {
  try {
    const { stdout } = await callWorker('status', 5000);
    const readiness = JSON.parse(stdout) as Readiness;
    return {
      ...readiness,
      status:
        readiness.runtime && (readiness.asrModel || readiness.alignerModel)
          ? ('available' as const)
          : ('missing' as const),
      ...((!readiness.runtime ||
        !readiness.asrModel ||
        !readiness.alignerModel) && { hint }),
    };
  } catch {
    return {
      status: 'missing' as const,
      runtime: null,
      asrModel: false,
      alignerModel: false,
      hint,
    };
  }
}

async function publishTranscript(
  output: string,
  content: string,
  signal: AbortSignal,
) {
  const stage = await mkdtemp(join(dirname(output), '.opencut-transcript-'));
  try {
    const file = join(stage, 'output');
    await writeFile(file, content, { signal });
    signal.throwIfAborted();
    await link(file, output);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function clockOption(name: string, value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    const time = parseSubtitleTime(value);
    return time.numerator / time.denominator;
  } catch {
    throw new UsageError(
      `--${name} requires source-relative seconds or a clock time.`,
    );
  }
}

export async function runTranscript(
  command: 'transcribe' | 'transcript align' | 'transcript export',
  file: string,
  values: CommandOptions,
) {
  const align = command === 'transcript align';
  const exporting = command === 'transcript export';
  const output = values.output && resolve(values.output);
  if (!output || !(exporting ? /\.(srt|vtt)$/i : /\.json$/i).test(output))
    throw new UsageError(
      exporting
        ? 'Choose --output <new.srt|new.vtt>.'
        : 'Choose --output <new.json>.',
    );
  if (align && !values.transcript)
    throw new UsageError('Supply the edited JSON using --transcript.');
  await withCommandCancellation(async (signal) => {
    if (exporting) {
      const input = transcriptSchema.parse(
        await readJsonArgument('transcript', file, signal),
      );
      const cues = transcriptCues(input);
      await publishTranscript(
        output,
        serializeSubtitles(
          cues,
          output.toLowerCase().endsWith('.srt') ? 'srt' : 'vtt',
        ),
        signal,
      );
      console.log(
        values.json
          ? JSON.stringify({ path: output, cues: cues.length })
          : `Saved ${cues.length} cues to ${output}`,
      );
      return;
    }
    const language =
      values.language && values.language.toLowerCase() !== 'auto'
        ? values.language
        : null;
    const ready = await inspectSpeechRuntime();
    if (!ready.runtime || !(align ? ready.alignerModel : ready.asrModel))
      throw new MediaError(
        'Local speech model or runtime is unavailable. ' + hint,
      );
    const path = resolve(file);
    const [fingerprint, media] = await Promise.all([
      fingerprintFile(path, signal, 'checking speech source', true),
      probeMedia(path, signal),
    ]);
    const available = audioSourceDuration(media);
    if (!available || !media.audio)
      throw new MediaError(
        'Choose local media with a readable audio stream and a known duration.',
      );
    const original = align
      ? transcriptSchema.parse(
          await readJsonArgument('transcript', values.transcript!, signal),
        )
      : undefined;
    if (
      original &&
      !matchesFingerprint(fingerprint, original.source.fingerprint)
    )
      throw new MediaError(
        'The input audio differs from the transcript source. Supply the original file or its byte-identical copy.',
      );
    const start =
      original?.interval.start ?? clockOption('start', values.start) ?? 0;
    const end =
      original?.interval.end ?? clockOption('end', values.end) ?? available;
    if (end <= start || end > available + 0.000001 || end - start > 80000)
      throw new MediaError(
        'Select a positive interval within the source audio, up to 80,000 seconds.',
      );
    const transcript: Transcript = original ?? {
      version: 1,
      source: {
        path,
        fingerprint: { bytes: fingerprint.bytes, sha256: fingerprint.sha256 },
      },
      backend: 'qwen3',
      interval: { start, end },
      segments: [],
    };
    if (!original) {
      for (let a = start, i = 0; a < end; a = start + ++i * 8) {
        const b = Math.min(end, start + (i + 1) * 8);
        transcript.segments.push({
          id: `speech-${i + 1}`,
          start: a,
          end: b,
          text: '',
          language,
          words: [],
          review: [],
        });
      }
    }
    validateTranscriptWindows(transcript);
    if (align)
      for (const segment of transcript.segments) {
        const selected = language ?? segment.language;
        if (
          segment.text.trim() &&
          (!selected ||
            !('alignmentLanguages' in ready) ||
            !ready.alignmentLanguages.includes(selected))
        )
          throw new MediaError(
            `Select a supported --language for segment '${segment.id}'. Supported: ${'alignmentLanguages' in ready ? ready.alignmentLanguages.join(', ') : 'see opencut doctor --json'}.`,
          );
      }
    const stage = await mkdtemp(join(tmpdir(), 'opencut-speech-'));
    try {
      const audio = join(stage, 'source.wav');
      await runMediaTool(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-ss',
          audioSourceSeek(media, start).toFixed(6),
          '-i',
          path,
          '-t',
          (end - start).toFixed(6),
          '-map',
          `0:${media.audio.index}`,
          '-vn',
          '-af',
          'aresample=16000:async=1:first_pts=0',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          '-rf64',
          'never',
          audio,
        ],
        undefined,
        600_000,
        { signal, stage: 'preparing local speech audio', writesFile: true },
      );
      const request = join(stage, 'request.json');
      await writeFile(
        request,
        JSON.stringify({
          operation: align ? 'align' : 'transcribe',
          audio,
          language,
          segments: transcript.segments.map((segment) => ({
            start: segment.start - start,
            end: segment.end - start,
            language: language ?? segment.language,
            ...(align && { text: segment.text }),
          })),
        }),
        { signal },
      );
      const response = await callWorker(request, 3_600_000, signal).catch(
        (error: unknown) => {
          signal.throwIfAborted();
          const stderr =
            error && typeof error === 'object' && 'stderr' in error
              ? String(error.stderr)
              : '';
          throw new MediaError(
            'Local Qwen speech processing failed. ' +
              (stderr.trim().split('\n').at(-1) || String(error)),
            { cause: error },
          );
        },
      );
      const results = speechBackendResultSchema.parse(
        JSON.parse(response.stdout),
      );
      if (results.length !== transcript.segments.length)
        throw new MediaError(
          'Speech backend returned an incomplete set of segments.',
        );
      transcript.segments = transcript.segments.map((segment, i) =>
        applyTranscriptTimings(segment, results[i]!, align),
      );
      if (sourceIdentity(path) !== fingerprint.identity)
        throw new MediaError(
          'Source changed during speech processing. Rerun with stable media.',
        );
      const result = transcriptSchema.parse(transcript);
      await publishTranscript(
        output,
        JSON.stringify(result, null, 2) + '\n',
        signal,
      );
      console.log(
        values.json
          ? JSON.stringify({ path: output, ...result })
          : `Saved ${result.segments.length} transcript segments to ${output}`,
      );
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}
