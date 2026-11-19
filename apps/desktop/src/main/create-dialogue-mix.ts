import { writeFile } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import type { VideoDefinition } from '@opencut/core/video';
import {
  audioSourceDuration,
  probeRecipeMedia,
  videoSourceDuration,
} from '@opencut/media';

export async function createDialogueMixDefinition(
  path: string,
  dialogue: string[],
  music: string[],
  picture?: string,
) {
  if (dialogue.length + music.length + Number(!!picture) > 64)
    throw new Error(
      'Choose up to 64 clips across dialogue, music and picture.',
    );
  const frameRate = 30;
  const assets: NonNullable<VideoDefinition['assets']> = {};
  const tracks: VideoDefinition['tracks'] = [];
  let durationFrames = 0;
  async function audioTrack(
    files: string[],
    audioRole: 'dialogue' | 'music',
    name: string,
  ) {
    if (!files.length) return;
    const clips = [];
    let at = 0;
    for (const [index, file] of files.entries()) {
      const metadata = await probeRecipeMedia(file);
      const length = Math.floor(
        (audioSourceDuration(metadata) ?? 0) * frameRate,
      );
      if (!metadata.audio || length < 1)
        throw new Error(
          `Choose an audio file with a known duration. Check '${basename(file)}'.`,
        );
      const id = `${audioRole}-${index + 1}`;
      const asset = id + '-source';
      assets[asset] = {
        path: relative(dirname(path), file),
        kind: metadata.video ? 'video' : 'audio',
        name: basename(file),
      };
      clips.push({ id, asset, at, sourceOut: length });
      at += length;
    }
    tracks.push({
      id: audioRole,
      name,
      type: 'audio',
      audioRole,
      ...(audioRole === 'music' && { volume: 0.4 }),
      clips,
    });
    durationFrames = Math.max(durationFrames, at);
  }
  if (picture) {
    const media = await probeRecipeMedia(picture);
    const frames = Math.floor((videoSourceDuration(media) ?? 0) * frameRate);
    if (!media.video || frames < 1)
      throw new Error('Choose a video with a known duration for the picture.');
    durationFrames = frames;
    assets['picture-source'] = {
      path: relative(dirname(path), picture),
      kind: 'video',
      name: basename(picture),
    };
    tracks.push({
      id: 'picture',
      type: 'video',
      name: 'Picture',
      muted: true,
      clips: [{ asset: 'picture-source', at: 0, sourceOut: frames }],
    });
  }
  await audioTrack(dialogue, 'dialogue', 'Dialogue');
  await audioTrack(music, 'music', 'Music');
  if (durationFrames > 600 * frameRate)
    throw new Error('OpenCut limits the timeline to ten minutes.');
  const definition: VideoDefinition = {
    name: basename(path, '.video.ts'),
    canvas: { width: 1920, height: 1080, frameRate, durationFrames },
    assets,
    tracks,
    professionalMix: { preset: 'natural-cinematic' },
  };
  await writeFile(
    path,
    'export default ' + JSON.stringify(definition, null, 2) + ';\n',
    { flag: 'wx' },
  );
}
