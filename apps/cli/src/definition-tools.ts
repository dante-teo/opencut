import type { MediaMetadata } from '@opencut/media';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CommandOptions } from './commands.js';
import { UsageError } from './usage.js';
import { readParams } from './json-argument.js';
import { withCommandCancellation } from './cancellation.js';

function formatProbe(media: MediaMetadata): string {
  const { video, audio } = media;
  return [
    `File: ${media.path}`,
    `Format: ${media.formatName ?? 'unknown'}`,
    `Duration: ${media.durationSeconds === null ? 'unknown' : `${media.durationSeconds} s`}`,
    `Video: ${video ? `${video.codec ?? 'unknown'}, ${video.width ?? '?'}x${video.height ?? '?'}, ${video.frameRate ?? '?'} fps` : 'none'}`,
    `Audio: ${audio ? `${audio.codec ?? 'unknown'}, ${audio.sampleRate ?? '?'} Hz, ${audio.channels ?? '?'} channels` : 'none'}`,
    `Streams: ${media.streams.length}`,
  ].join('\n');
}

type MediaCommand =
  | 'probe'
  | 'extract-frame'
  | 'separate-dialogue'
  | 'subtitles export'
  | 'online search'
  | 'online download';

export async function runDefinitionTool(
  command: MediaCommand,
  file: string,
  values: CommandOptions,
) {
  const { output } = values;
  await withCommandCancellation(async (signal) => {
    let result: unknown;
    let formatted: string | undefined;
    if (command === 'subtitles export') {
      if (!output || !/\.(?:srt|vtt)$/i.test(output))
        throw new UsageError('Specify --output <new.srt|new.vtt>.');
      const { writeSubtitleFile } = await import('@opencut/core/video');
      const { loadVideo } = await import('./video.js');
      const { project } = await loadVideo(file, {
        preview: true,
        signal,
        params: await readParams(values.params, signal),
      });
      result = await writeSubtitleFile(
        output,
        project.subtitles?.cues ?? [],
        signal,
      );
    } else if (command === 'online search' || command === 'online download') {
      const { OnlineMediaLibrary } = await import('@opencut/core/video');
      const library = new OnlineMediaLibrary();
      const query = JSON.parse(
        await readFile(resolve(file), { encoding: 'utf8', signal }),
      );
      const page = await library.search(query, signal);
      if (command === 'online search') result = page;
      else {
        const { directory, result: id } = values;
        if (!directory?.trim() || !id?.trim())
          throw new UsageError(
            'Specify --result <id|index> and --directory <media-directory>.',
          );
        const selected = /^\d+$/.test(id)
          ? page.results[Number(id)]
          : page.results.find((item) => item.id === id);
        if (!selected?.importable)
          throw new UsageError('Select a downloadable online search result.');
        const download = await library.download(
          selected.id,
          resolve(directory),
          signal,
        );
        result = { path: download.path, provenance: download.provenance };
      }
    } else {
      const { extractFrame, probeMedia, separateDialogue } =
        await import('@opencut/media');
      if (command === 'probe') {
        const media = await probeMedia(file, signal);
        result = media;
        if (!values.json) formatted = formatProbe(media);
      } else if (command === 'separate-dialogue') {
        if (!output?.trim())
          throw new UsageError('Specify --output <new-directory>.');
        result = await separateDialogue(file, output, signal);
      } else {
        const timestamp = values.timestamp ?? '';
        if (
          !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(timestamp) ||
          !Number.isFinite(Number(timestamp)) ||
          !output?.toLowerCase().endsWith('.png')
        )
          throw new UsageError(
            'Specify --timestamp <nonnegative seconds> and --output <new.png>.',
          );
        const frame = await extractFrame(
          file,
          Number(timestamp),
          output,
          signal,
        );
        result = frame;
        if (!values.json)
          formatted = `Saved frame at ${frame.timestampSeconds}s to ${frame.path}`;
      }
    }
    signal.throwIfAborted();
    console.log(
      formatted ?? JSON.stringify(result, null, values.json ? undefined : 2),
    );
  });
}
