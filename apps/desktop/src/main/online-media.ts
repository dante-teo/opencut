import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  OnlineMediaKind,
  OnlineMediaPage,
  OnlineMediaProvider,
  OnlineMediaResult,
  OnlineMediaSearch,
} from '../bridge.js';

const pageSize = 20;
const mediaLimit = 512 * 1024 * 1024;
const userAgent = 'OpenCut/0.1.0 (desktop media library)';
const mediaTypes: Record<string, [OnlineMediaKind, string]> = {
  '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'],
  '.png': ['image', 'image/png'],
  '.apng': ['image', 'image/png'],
  '.gif': ['image', 'image/gif'],
  '.webp': ['image', 'image/webp'],
  '.mp3': ['audio', 'audio/mpeg'],
  '.ogg': ['audio', 'audio/ogg'],
  '.oga': ['audio', 'audio/ogg'],
  '.opus': ['audio', 'audio/ogg'],
  '.wav': ['audio', 'audio/wav'],
  '.flac': ['audio', 'audio/flac'],
  '.m4a': ['audio', 'audio/mp4'],
  '.mp4': ['video', 'video/mp4'],
  '.webm': ['video', 'video/webm'],
};

type MediaURL = { url: URL; extension: string; mime: string };
type Candidate = Omit<OnlineMediaResult, 'id' | 'previewUrl' | 'importable'> & {
  original: MediaURL | null;
  preview: MediaURL | null;
};
type SearchPage = { results: Candidate[]; nextPage: string | null };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value
    .slice(0, 4096)
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, name: string) => entities[name]!,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function publicUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}

function mediaUrl(value: unknown, kind: OnlineMediaKind): MediaURL | null {
  const url = publicUrl(value);
  if (!url) return null;
  const commons =
    url.hostname === 'upload.wikimedia.org' &&
    url.pathname.startsWith('/wikipedia/commons/');
  const flickr =
    kind === 'image' &&
    /^(?:live|c[12]|farm\d+)\.staticflickr\.com$/.test(url.hostname) &&
    /^\/(?:\d+\/)*\d+_[a-z\d]+(?:_[a-z\d]+)?\.[a-z]+$/i.test(url.pathname);
  if (!commons && !flickr) return null;
  url.protocol = 'https:';
  url.hash = '';
  const extension = extname(url.pathname).toLowerCase();
  const format = mediaTypes[extension];
  if (!format || format[0] !== kind) return null;
  return { url, extension, mime: format[1] };
}

function readLicense(
  value: unknown,
): { license: string; licenseUrl: string } | null {
  const url = publicUrl(value);
  if (!url || url.hostname !== 'creativecommons.org') return null;
  const path = url.pathname.replace(/\/deed(?:\.[a-z-]+)?\/?$/i, '/');
  const match =
    /^\/licenses\/(by|by-sa)\/(\d\.\d)(?:\/[a-z-]+)?\/?$/i.exec(path) ??
    /^\/publicdomain\/(zero|mark)\/(1\.0)\/?$/i.exec(path);
  if (!match) return null;
  const labels: Record<string, string> = {
    by: 'CC BY',
    'by-sa': 'CC BY-SA',
    zero: 'CC0',
    mark: 'Public Domain Mark',
  };
  const code = match[1]!.toLowerCase();
  return {
    license: `${labels[code]} ${match[2]}`,
    licenseUrl: `https://creativecommons.org${path}`,
  };
}

function candidate(
  item: {
    title: unknown;
    creator: unknown;
    license: unknown;
    source: unknown;
    original: MediaURL | null;
    preview?: MediaURL | null;
  },
  kind: OnlineMediaKind,
): Candidate | null {
  const title = plainText(item.title);
  const source = publicUrl(item.source);
  const license = readLicense(item.license);
  if (!title || !source || source.protocol !== 'https:' || !license)
    return null;
  return {
    title,
    creator: plainText(item.creator) || null,
    sourceUrl: source.href,
    kind,
    ...license,
    original: item.original,
    preview: item.preview ?? item.original,
  };
}

async function getJson(url: URL) {
  const signal = AbortSignal.timeout(15000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 429)
        throw new Error(
          'The provider is rate limiting searches. Try again shortly.',
        );
      throw new Error(
        `The provider returned HTTP ${response.status}. Try again shortly.`,
      );
    }
    const body = new Response(limitBytes(response.body, 2 * 1024 * 1024));
    return record(await body.json());
  } catch (error) {
    if (signal.aborted)
      throw new Error(
        'The provider took too long to respond. Try again shortly.',
      );
    if (error instanceof TypeError)
      throw new Error(
        'Could not reach the provider. Check your connection and try again.',
      );
    throw error;
  }
}

async function commonsSearch(input: OnlineMediaSearch): Promise<SearchPage> {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  const video = input.kind === 'video';
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${input.query} filetype:${input.kind === 'image' ? 'bitmap' : input.kind}`,
    gsrlimit: String(pageSize),
    gsroffset: input.page ?? '0',
    ...(video
      ? {
          prop: 'videoinfo',
          viprop: 'url|extmetadata|derivatives',
          viextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
        }
      : {
          prop: 'imageinfo',
          iiprop: 'url|extmetadata',
          iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
        }),
    ...(input.kind === 'image' ? { iiurlwidth: '640' } : {}),
  }).toString();
  const data = await getJson(url);
  if (data.error)
    throw new Error('Wikimedia Commons could not complete the search.');
  const pages = list(record(data.query).pages).map(record);
  pages.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const results = pages.flatMap((page) => {
    const file = record(list(video ? page.videoinfo : page.imageinfo)[0]);
    const derivatives = list(file.derivatives)
      .map((entry) => mediaUrl(record(entry).src, 'video'))
      .filter((media) => media?.extension === '.webm');
    const metadata = record(file.extmetadata);
    const license =
      record(metadata.LicenseUrl).value ??
      (record(metadata.LicenseShortName).value === 'Public domain'
        ? 'https://creativecommons.org/publicdomain/mark/1.0/'
        : null);
    const item = candidate(
      {
        title: String(page.title ?? '').replace(/^File:/, ''),
        creator: record(metadata.Artist).value,
        license,
        source: file.descriptionurl,
        original: mediaUrl(file.url, input.kind) ?? derivatives.at(-1) ?? null,
        preview: derivatives[0] ?? mediaUrl(file.thumburl, input.kind),
      },
      input.kind,
    );
    return item ? [item] : [];
  });
  const next = record(data.continue).gsroffset;
  return {
    results,
    nextPage: typeof next === 'number' ? String(next) : null,
  };
}

async function openverseSearch(input: OnlineMediaSearch): Promise<SearchPage> {
  const collection = input.kind === 'image' ? 'images' : 'audio';
  const url = new URL(`https://api.openverse.org/v1/${collection}/`);
  const page = Number(input.page ?? '1');
  url.search = new URLSearchParams({
    q: input.query,
    license: 'cc0,pdm,by,by-sa',
    page: String(page),
    page_size: String(pageSize),
  }).toString();
  const data = await getJson(url);
  const results = list(data.results).flatMap((value) => {
    const file = record(value);
    const version = file.license_version;
    const code = file.license;
    const license =
      file.license_url ??
      (code === 'cc0' || code === 'pdm'
        ? `https://creativecommons.org/publicdomain/${code === 'cc0' ? 'zero' : 'mark'}/1.0/`
        : `https://creativecommons.org/licenses/${String(code)}/${String(version)}/`);
    const item = candidate(
      {
        title: file.title,
        creator: file.creator,
        license,
        source: file.foreign_landing_url,
        original: mediaUrl(file.url, input.kind),
      },
      input.kind,
    );
    return item ? [item] : [];
  });
  return {
    results,
    nextPage: page < Number(data.page_count) ? String(page + 1) : null,
  };
}

function searchInput(value: unknown): OnlineMediaSearch {
  const { provider, kind, query, page } = record(value);
  if (
    (provider !== 'commons' && provider !== 'openverse') ||
    (kind !== 'image' && kind !== 'audio' && kind !== 'video') ||
    (provider === 'openverse' && kind === 'video') ||
    typeof query !== 'string' ||
    !query.trim() ||
    query.length > 200 ||
    (page !== undefined &&
      (typeof page !== 'string' || !/^\d{1,4}$/.test(page)))
  )
    throw new Error('Enter a search and choose a supported media type.');
  return { provider, kind, query: query.trim(), ...(page ? { page } : {}) };
}

function limitBytes(body: ReadableStream<Uint8Array>, limit: number) {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit)
          throw new Error('Media exceeds the download limit.');
        controller.enqueue(chunk);
      },
    }),
  );
}

async function fetchMedia(
  media: MediaURL,
  signal: AbortSignal,
  range?: string,
) {
  const response = await fetch(media.url, {
    signal,
    redirect: 'error',
    headers: { 'User-Agent': userAgent, ...(range ? { Range: range } : {}) },
  });
  const mime = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.toLowerCase();
  const rangeHeader = response.headers.get('content-range');
  const rangeTotal = rangeHeader?.match(/^bytes \d+-\d+\/(\d+)$/)?.[1];
  const size = Number(rangeTotal ?? response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const matchingMime =
    mime === media.mime ||
    (media.mime === 'image/png' && mime === 'image/apng') ||
    (media.mime === 'audio/ogg' && mime === 'application/ogg') ||
    (media.mime === 'audio/wav' && mime === 'audio/x-wav') ||
    (media.mime === 'audio/flac' && mime === 'audio/x-flac');
  if (
    (response.status !== 200 &&
      !(range && response.status === 206 && rangeTotal)) ||
    !response.body ||
    !matchingMime ||
    (encoding && encoding !== 'identity') ||
    size > mediaLimit
  ) {
    await response.body?.cancel();
    throw new Error(
      size > mediaLimit
        ? 'Media exceeds the 512 MiB download limit.'
        : 'The source did not return a supported media file.',
    );
  }
  return { response, body: limitBytes(response.body, mediaLimit) };
}

export class OnlineMediaLibrary {
  private readonly results = new Map<
    string,
    { provider: OnlineMediaProvider; item: Candidate }
  >();

  async search(value: unknown): Promise<OnlineMediaPage> {
    const input = searchInput(value);
    const page = await (input.provider === 'commons'
      ? commonsSearch(input)
      : openverseSearch(input));
    return {
      nextPage: page.nextPage,
      results: page.results.slice(0, pageSize).map((item) => {
        const id = randomUUID();
        this.results.set(id, { provider: input.provider, item });
        if (this.results.size > 240)
          this.results.delete(this.results.keys().next().value!);
        const { original, preview, ...info } = item;
        return {
          ...info,
          id,
          importable: Boolean(original),
          previewUrl: preview ? `opencut://media/online/${id}` : null,
        };
      }),
    };
  }

  source(id: unknown) {
    const { title, sourceUrl } = this.result(id).item;
    return { title, sourceUrl };
  }

  private result(id: unknown) {
    const result = typeof id === 'string' ? this.results.get(id) : undefined;
    if (!result) throw new Error('This search result expired. Search again.');
    return result;
  }

  async preview(id: string, request: Request) {
    const { item } = this.result(id);
    if (!item.preview || request.method !== 'GET')
      return new Response(null, { status: 403 });
    const range = request.headers.get('range');
    if (range && !/^bytes=\d*-\d*$/.test(range))
      return new Response(null, { status: 416 });
    const { response, body } = await fetchMedia(
      item.preview,
      AbortSignal.any([request.signal, AbortSignal.timeout(120000)]),
      range ?? undefined,
    );
    const headers = new Headers({
      'Content-Type': item.preview.mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    for (const name of ['accept-ranges', 'content-length', 'content-range']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(body, { status: response.status, headers });
  }

  async download(id: unknown, root: string) {
    const { provider, item } = this.result(id);
    if (!item.original)
      throw new Error(
        'Download this file from its source and import it locally.',
      );
    const signal = AbortSignal.timeout(120000);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, 'asset-'));
    const path = join(directory, `media${item.original.extension}`);
    const discard = () => rm(directory, { recursive: true, force: true });
    try {
      const { body } = await fetchMedia(item.original, signal);
      await pipeline(
        body,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        {
          signal,
        },
      );
      return {
        path,
        discard,
        title: item.title,
        kind: item.kind,
        provenance: {
          provider,
          creator: item.creator,
          sourceUrl: item.sourceUrl,
          license: item.license,
          licenseUrl: item.licenseUrl,
        },
      };
    } catch (error) {
      await discard();
      throw error;
    }
  }
}
