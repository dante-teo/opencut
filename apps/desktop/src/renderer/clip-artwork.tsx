import { useEffect, useState } from 'react';
import {
  projectRevision,
  type Project,
  type MediaAsset,
  type TimelineClip,
} from '@opencut/core';
import { artworkTiles } from './artwork-geometry.js';
import type { TimelineArtworkInput } from '../bridge.js';

// Two artwork decodes at a time; obsolete queued work is skipped before IPC.
const queue: (() => Promise<void>)[] = [];
let running = 0;
async function drain() {
  while (running < 2 && queue.length) {
    const work = queue.shift()!;
    running++;
    void work().finally(() => {
      running--;
      void drain();
    });
  }
}
// A reopened/copied project may reuse IDs and relative paths. Never reuse its
// renderer artwork without a fresh authorized decode for that snapshot.
const snapshots = new WeakMap<Project, number>();
let nextSnapshot = 0;
function snapshotId(project: Project) {
  let id = snapshots.get(project);
  if (id === undefined) {
    id = ++nextSnapshot;
    snapshots.set(project, id);
  }
  return id;
}
const images = new Map<string, string>();
let imageBytes = 0;
function remember(key: string, url: string) {
  // Encoded previews are bounded independently of the playback frame cache.
  if (url.length > 8 * 1024 ** 2) return;
  imageBytes -= images.get(key)?.length ?? 0;
  images.set(key, url);
  imageBytes += url.length;
  while (imageBytes > 8 * 1024 ** 2 || images.size > 128) {
    const first = images.keys().next().value!;
    imageBytes -= images.get(first)!.length;
    images.delete(first);
  }
}
function ArtworkTile({
  input,
  identity,
  x,
  width,
}: {
  input: TimelineArtworkInput;
  identity: string;
  x: number;
  width: number;
}) {
  const key = JSON.stringify([identity, input]);
  const [result, setResult] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const cached = images.get(key);
    if (cached) {
      setResult({ key, url: cached });
      return;
    }
    const work = async () => {
      if (!active) return;
      // Another visible tile can have filled this entry while it was queued.
      const url =
        images.get(key) ??
        (await window.opencut.timelineArtwork(input).catch(() => null));
      if (!active) return;
      if (url) remember(key, url);
      setResult({ key, url });
    };
    if (x <= 0) queue.unshift(work);
    else queue.push(work);
    void drain();
    return () => {
      active = false;
      const index = queue.indexOf(work);
      if (index >= 0) queue.splice(index, 1);
    };
  }, [key]);
  const current = result?.key === key ? result : null;
  return (
    <svg
      x={x}
      y={20}
      width={width}
      height={32}
      overflow="hidden"
      className="clip-artwork-tile"
      data-start={input.start}
      data-count={input.count ?? 1}
      data-interval={input.interval ?? 0}
      data-status={
        current ? (current.url ? 'ready' : 'unavailable') : 'loading'
      }
    >
      {current?.url ? (
        <image
          href={current.url}
          width={width}
          height={32}
          preserveAspectRatio={
            input.kind === 'waveform' ? 'none' : 'xMidYMid slice'
          }
        />
      ) : (
        <text x={6} y={21} className="artwork-placeholder">
          {current ? 'Preview unavailable' : 'Loading…'}
        </text>
      )}
    </svg>
  );
}
export function ClipArtwork({
  project,
  clip,
  asset,
  audio,
  offset,
  width,
  zoom,
}: {
  project: Project;
  clip: TimelineClip;
  asset: MediaAsset | undefined;
  audio: boolean;
  offset: number;
  width: number;
  zoom: number;
}) {
  if (!asset) return null;
  const sourceIn = clip.sourceIn.numerator / clip.sourceIn.denominator;
  const sourceOut = clip.sourceOut.numerator / clip.sourceOut.denominator;
  const tiles = artworkTiles(
    offset,
    width,
    zoom,
    sourceIn,
    sourceOut,
    audio,
    asset.metadata?.kind === 'image',
  );
  return (
    <g
      aria-hidden="true"
      className={`clip-artwork ${audio ? 'waveform' : 'filmstrip'}`}
    >
      {tiles.map((tile) => (
        <ArtworkTile
          key={tile.start}
          x={tile.x}
          width={tile.width}
          identity={JSON.stringify([snapshotId(project), asset.file])}
          input={{
            projectId: project.metadata.id,
            expectedRevision: projectRevision(project),
            assetId: asset.id,
            kind: audio ? 'waveform' : 'frame',
            start: asset.metadata?.kind === 'image' ? 0 : tile.start,
            ...(!audio && asset.metadata?.kind !== 'image' && tile.count > 1
              ? { count: tile.count, interval: tile.interval }
              : {}),
            duration: tile.duration,
            width: Math.max(1, Math.ceil(tile.width)),
          }}
        />
      ))}
    </g>
  );
}
