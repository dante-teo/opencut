import { localFile, MediaError, runMediaTool } from './process.js';

/** FFmpeg supplies the waveform; no samples or user files enter the renderer. */
export async function waveformImage(
  file: string,
  start: number,
  duration: number,
  width: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 120 ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > 2048
  )
    throw new MediaError('Invalid waveform range or dimensions.');
  const path = await localFile(file);
  const png = await runMediaTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-ss',
      start.toFixed(6),
      '-t',
      duration.toFixed(6),
      '-i',
      path,
      '-filter_complex',
      `[0:a:0]aformat=channel_layouts=mono,aresample=8000:async=1:first_pts=0,apad=whole_dur=${duration.toFixed(6)},atrim=duration=${duration.toFixed(6)},showwavespic=s=${width}x32:colors=0x47b89f:scale=sqrt[v]`,
      '-map',
      '[v]',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-c:v',
      'png',
      '-f',
      'image2pipe',
      'pipe:1',
    ],
    512 * 1024,
    30000,
    { signal },
  );
  if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new MediaError('No waveform could be decoded.');
  return png;
}
