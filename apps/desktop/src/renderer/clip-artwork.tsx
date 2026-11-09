import { memo, useEffect, useState } from 'react';
import {
  projectRevision,
  clipSpeed,
  type Project,
  type MediaAsset,
  type TimelineClip,
} from '@opencut/core';
import {
  filmstripTiles,
  waveformPath,
  waveformTiles,
} from './artwork-geometry.js';
import type { TimelineArtworkInput, TimelineArtworkResult } from '../bridge.js';

type Listener = (value: TimelineArtworkResult) => void;
interface Job {
  id: number;
  input: TimelineArtworkInput;
  first: boolean;
  started: boolean;
  listeners: Set<Listener>;
}

const jobs = new Map<string, Job>();
let nextJob = 0;
let running = 0;
function drain() {
  if (running >= 2) return;
  const waiting = [...jobs.entries()]
    .filter(([, job]) => !job.started)
    .sort(([, a], [, b]) => Number(b.first) - Number(a.first));
  for (const [key, job] of waiting) {
    if (running >= 2) break;
    job.started = true;
    running++;
    void window.opencut
      .timelineArtwork(job.id, job.input)
      .catch(() => null)
      .then((value) => {
        if (jobs.get(key) === job) jobs.delete(key);
        for (const listener of job.listeners) listener(value);
        running--;
        drain();
      });
  }
}

function subscribe(
  key: string,
  input: TimelineArtworkInput,
  first: boolean,
  listener: Listener,
) {
  let job = jobs.get(key);
  if (!job) {
    job = { id: ++nextJob, input, first, started: false, listeners: new Set() };
    jobs.set(key, job);
  }
  job.listeners.add(listener);
  job.first ||= first;
  queueMicrotask(drain);
  return () => {
    job.listeners.delete(listener);
    if (job.listeners.size || jobs.get(key) !== job) return;
    jobs.delete(key);
    if (job.started)
      void window.opencut.cancelTimelineArtwork(job.id).catch(() => {});
  };
}

// Reopening or replacing a project must reauthorize lookups even if IDs match.
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

function ArtworkTile({
  input,
  snapshot,
  first,
  showLabel = first,
  x,
  y,
  width,
  height,
  waveform,
}: {
  input: TimelineArtworkInput;
  snapshot: number;
  first: boolean;
  showLabel?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  waveform?: { tile: ReturnType<typeof waveformTiles>[number]; zoom: number };
}) {
  const key = JSON.stringify([snapshot, input]);
  const [result, setResult] = useState<{
    key: string;
    value: TimelineArtworkResult;
  }>();
  useEffect(
    () => subscribe(key, input, first, (value) => setResult({ key, value })),
    [key],
  );
  const value = result?.key === key ? result.value : undefined;
  if (value && typeof value !== 'string' && !value.length) return null;
  const status =
    value === undefined ? 'loading' : value ? 'ready' : 'unavailable';
  return (
    <svg
      x={x}
      y={y}
      width={width}
      height={height}
      overflow="hidden"
      className="clip-artwork-tile"
      data-start={input.start}
      data-count={input.kind === 'frame' ? input.count : undefined}
      data-interval={input.kind === 'frame' ? input.interval : undefined}
      data-status={status}
    >
      {typeof value === 'string' ? (
        <image
          href={value}
          width={width}
          height={height}
          preserveAspectRatio="xMidYMid slice"
        />
      ) : value && waveform ? (
        <g className="waveform-peaks">
          <path className="waveform-baseline" d={`M0 ${height / 2}H${width}`} />
          <path d={waveformPath(value, waveform.tile, waveform.zoom, height)} />
        </g>
      ) : (
        <>
          <rect
            className="artwork-placeholder-fill"
            width={width}
            height={height}
          />
          {showLabel && height >= 20 && (
            <text
              x={Math.max(0, -x) + 6}
              y={height / 2 + 3}
              className="artwork-placeholder"
            >
              {status === 'loading' ? 'Loading…' : 'Preview unavailable'}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

export const ClipArtwork = memo(function ClipArtwork({
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
  if (!asset || width <= 0) return null;
  const speed = clipSpeed(clip);
  const sourceZoom = (zoom * speed.denominator) / speed.numerator;
  const sourceIn = clip.sourceIn.numerator / clip.sourceIn.denominator;
  const sourceOut = clip.sourceOut.numerator / clip.sourceOut.denominator;
  const image = asset.metadata?.kind === 'image';
  const hasAudio = !image && asset.metadata?.hasAudio !== false;
  const snapshot = snapshotId(project);
  const scope = {
    projectId: project.metadata.id,
    expectedRevision: projectRevision(project),
    assetId: asset.id,
  };
  const filmstripHeight = hasAudio ? 22 : 32;
  const frames = audio
    ? []
    : filmstripTiles(offset, width, sourceZoom, sourceIn, sourceOut, image);
  // Leave room for the status text when only a sliver of the first atlas is visible.
  const labelIndex = Math.max(
    0,
    frames.findIndex((tile) => {
      const visibleWidth =
        Math.min(width, tile.x + tile.width) - Math.max(0, tile.x);
      return visibleWidth >= Math.min(112, tile.width);
    }),
  );
  return (
    <g aria-hidden="true" className="clip-artwork">
      {!audio && (
        <g className="filmstrip">
          {frames.map((tile, index) => (
            <ArtworkTile
              key={tile.index}
              first={index === 0}
              showLabel={index === labelIndex}
              snapshot={snapshot}
              x={tile.x}
              y={20}
              width={tile.width}
              height={filmstripHeight}
              input={{
                ...scope,
                kind: 'frame',
                start: tile.start,
                count: tile.count,
                interval: tile.interval,
              }}
            />
          ))}
        </g>
      )}
      {hasAudio && (
        <g className="waveform">
          {waveformTiles(offset, width, sourceZoom, sourceIn, sourceOut).map(
            (tile, index) => (
              <ArtworkTile
                key={tile.start}
                first={index === 0}
                snapshot={snapshot}
                x={tile.x}
                y={audio ? 20 : 42}
                width={tile.width}
                height={audio ? 32 : 10}
                input={{ ...scope, kind: 'waveform', start: tile.start }}
                waveform={{ tile, zoom: sourceZoom }}
              />
            ),
          )}
        </g>
      )}
    </g>
  );
});
