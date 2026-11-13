import { execFile } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { probeMedia } from './probe.js';
import {
  checkRenderSignal,
  localFile,
  MediaError,
  runMediaTool,
  sourceFileStamp,
} from './process.js';

const exec = promisify(execFile);
const separate = `
import pathlib, shutil, sys
import eluate
source, directory = sys.argv[1:]
result = eluate.elute(source, outputs=("speech",), output_dir=directory)
shutil.copyfile(result.speech, pathlib.Path(directory) / "speech.wav")
`;

/** Split a local mix with Bandit v2. The background is the sample-aligned residual. */
export async function separateDialogue(
  file: string,
  outputDirectory: string,
  signal?: AbortSignal,
) {
  checkRenderSignal(signal);
  const source = await localFile(file);
  const originalStamp = await sourceFileStamp(source);
  const metadata = await probeMedia(source, signal, { localMediaOnly: true });
  const duration = metadata.durationSeconds;
  if (!metadata.audio || duration === null || duration <= 0 || duration > 600)
    throw new MediaError(
      'Choose a local file with an audio stream and a known duration up to 600 seconds.',
    );
  const samples = Math.ceil(duration * 48000);
  const destination = resolve(outputDirectory);
  if (
    await lstat(destination).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    })
  )
    throw new MediaError('Choose a new folder for the separated audio.');
  const work = await mkdtemp(join(dirname(destination), '.opencut-dialogue-'));
  const input = join(work, 'input.mp4');
  const speech = join(work, 'speech.wav');
  const dialogue = join(work, 'dialogue.wav');
  const background = join(work, 'background.wav');
  const control = { signal };
  let created = false;
  let linkedDialogue = false;
  let linkedBackground = false;
  try {
    // Normalize the first audio stream against the source clock before inference.
    await runMediaTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-protocol_whitelist',
        'file',
        '-i',
        source,
        '-f',
        'lavfi',
        '-i',
        'color=size=16x16:rate=1',
        '-map',
        '1:v:0',
        '-map',
        '0:a:0',
        '-af',
        `aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,apad,atrim=end_sample=${samples}`,
        '-t',
        String(samples / 48000),
        '-c:v',
        'mpeg4',
        '-c:a',
        'alac',
        input,
      ],
      undefined,
      600_000,
      control,
    );
    try {
      await exec(
        process.env.OPENCUT_DIALOGUE_PYTHON || 'python3',
        ['-I', '-c', separate, input, work],
        {
          ...(signal ? { signal } : {}),
          timeout: 1_800_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (cause) {
      checkRenderSignal(signal);
      throw new MediaError(
        'Bandit v2 dialogue separation failed. Install ELUATE in the selected Python environment and run eluate setup to install its multilingual model.',
        { cause },
      );
    }
    const inferred = await probeMedia(speech, signal, { localMediaOnly: true });
    if (
      !inferred.audio ||
      inferred.durationSeconds === null ||
      Math.abs(inferred.durationSeconds - duration) > 0.1
    )
      throw new MediaError(
        'The dialogue model returned audio with an unexpected duration.',
      );
    await runMediaTool(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-i',
        input,
        '-i',
        speech,
        '-filter_complex',
        `[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=end_sample=${samples},asplit=2[voice][invert];[invert]aeval=-val(0)|-val(1):c=stereo[negative];[0:a][negative]amix=inputs=2:duration=first:normalize=0[background]`,
        '-map',
        '[voice]',
        '-c:a',
        'pcm_f32le',
        dialogue,
        '-map',
        '[background]',
        '-c:a',
        'pcm_f32le',
        background,
      ],
      undefined,
      600_000,
      control,
    );
    for (const path of [dialogue, background]) {
      const stem = await probeMedia(path, signal, { localMediaOnly: true });
      if (
        stem.audio?.sampleRate !== 48000 ||
        stem.audio.channels !== 2 ||
        stem.durationSeconds === null ||
        Math.abs(stem.durationSeconds - samples / 48000) > 0.000002
      )
        throw new MediaError(
          'The separation outputs did not match the expected sample grid.',
        );
    }
    if (originalStamp !== (await sourceFileStamp(source)))
      throw new MediaError('The source changed while separating dialogue.');
    checkRenderSignal(signal);
    await mkdir(destination);
    created = true;
    const result = {
      dialogue: join(destination, 'dialogue.wav'),
      background: join(destination, 'background.wav'),
    };
    await link(dialogue, result.dialogue);
    linkedDialogue = true;
    await link(background, result.background);
    linkedBackground = true;
    return result;
  } catch (error) {
    if (created) {
      if (linkedDialogue)
        await rm(join(destination, 'dialogue.wav'), { force: true });
      if (linkedBackground)
        await rm(join(destination, 'background.wav'), { force: true });
      await rmdir(destination).catch(() => {});
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
