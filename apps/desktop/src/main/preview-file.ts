import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import parseRange from 'range-parser';

const contentTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
};

// Only called with the main process's picker-authorized path, never a URL path.
export async function servePreviewFile(
  path: string,
  request: Request,
): Promise<Response> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Preview input is not a file.');
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type':
        contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    const range = request.headers.get('Range');
    const parsed = range
      ? parseRange(info.size, range, { combine: true })
      : null;
    if (
      range &&
      (!Array.isArray(parsed) || parsed.type !== 'bytes' || parsed.length !== 1)
    ) {
      await file.close();
      headers.set('Content-Range', `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }
    const bounds = Array.isArray(parsed) ? parsed[0] : null;
    const start = bounds?.start ?? 0;
    const end = bounds?.end ?? info.size - 1;
    if (end < start) {
      await file.close();
      headers.set('Content-Length', '0');
      return new Response(null, { headers });
    }
    headers.set('Content-Length', String(end - start + 1));
    if (bounds)
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
    const stream = file.createReadStream({ start, end, autoClose: true });
    // Readable.toWeb propagates consumer cancellation to the file stream.
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return new Response(body, { status: bounds ? 206 : 200, headers });
  } catch (error) {
    await file.close();
    throw error;
  }
}
