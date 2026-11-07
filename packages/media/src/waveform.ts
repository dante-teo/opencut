import {
  WAVEFORM_BINS_PER_SECOND,
  WAVEFORM_CHUNK_SECONDS,
} from '@opencut/shared';
import { type MediaMetadata } from './probe.js';
import { runMediaTool } from './process.js';

const sampleRate = 48000;
const samplesPerBin = sampleRate / WAVEFORM_BINS_PER_SECOND;
const binCount = WAVEFORM_CHUNK_SECONDS * WAVEFORM_BINS_PER_SECOND;

/** Summarize the selected stream on a fixed source-time grid without buffering PCM. */
export async function waveformPeaks(
  media: MediaMetadata,
  start: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const { audio } = media;
  if (!audio) return null;
  const peaks = Buffer.alloc(binCount);
  if (audio.startTimeSeconds !== null) {
    const audioStart = audio.startTimeSeconds - (media.startTimeSeconds ?? 0);
    if (
      audioStart >= start + WAVEFORM_CHUNK_SECONDS ||
      (audio.durationSeconds !== null &&
        audioStart + audio.durationSeconds <= start)
    )
      return peaks;
  }
  const samples = binCount * samplesPerBin;
  const output = await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-threads',
      '1',
      '-filter_threads',
      '1',
      '-ss',
      String(start),
      '-t',
      String(WAVEFORM_CHUNK_SECONDS),
      '-i',
      media.path,
      '-map',
      `0:${audio.index}`,
      '-af',
      [
        // Preserve stream delay, gaps and the silent tail in source time.
        `aresample=${sampleRate}:async=1:min_hard_comp=0.001:first_pts=0`,
        `apad=whole_len=${samples}`,
        `atrim=end_sample=${samples}`,
        `asetnsamples=n=${samplesPerBin}:p=0`,
        'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level',
        "ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file='pipe\\:1'",
      ].join(','),
      '-f',
      'null',
      '-',
    ],
    256 * 1024,
    30000,
    { signal },
  );
  // Use the peak across all channels. A mono mix would hide phase-inverted audio.
  for (const match of output
    .toString('utf8')
    .matchAll(/frame:(\d+).*\n *lavfi\.astats\.Overall\.Peak_level=(.*)/g)) {
    const bin = Number(match[1]);
    const amplitude = Math.pow(10, Number(match[2]) / 20);
    if (bin < binCount && !Number.isNaN(amplitude))
      peaks[bin] = Math.min(255, Math.round(amplitude * 255));
  }
  return peaks;
}
