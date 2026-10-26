import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Project, RationalTime } from '@opencut/core';
import {
  clampTime,
  frameIndex,
  framePosition,
  indexTimeline,
  LABEL_WIDTH,
  pixelTime,
  relativePixels,
  RULER_HEIGHT,
  rulerTicks,
  scrollGeometry,
  snapToFrame,
  timelineTimecode,
  TRACK_HEIGHT,
  visibleClips,
  ZERO,
  ZOOM_LEVELS,
  zoomScroll,
} from './timeline-geometry.js';

export const exactTime = (value: RationalTime) =>
  `${value.numerator}/${value.denominator} s`;

export function ProjectTimeline({
  project,
  selected,
  onSelect,
  position = ZERO,
  onSeek,
  onPreviewClip,
  linkedClipId,
}: {
  project: Project | undefined;
  selected: string | null;
  onSelect: (id: string) => void;
  position?: RationalTime;
  onSeek?: (time: RationalTime) => void;
  onPreviewClip?: (id: string) => void;
  linkedClipId?: string | null;
}) {
  const index = useMemo(() => indexTimeline(project), [project]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(80);
  const [viewport, setViewport] = useState({
    width: 800,
    height: 140,
    left: 0,
    top: 0,
  });
  const pendingScroll = useRef<number | null>(null);
  const dragPointer = useRef<number | null>(null);
  const zoomHandler = useRef<(next: number, anchor: number) => void>(() => {});
  const width = Math.max(1, viewport.width - LABEL_WIDTH);
  const geometry = scrollGeometry(index.end, zoom, width);
  const scroll = viewport.left * geometry.ratio;
  const origin = pixelTime(scroll, zoom);
  const visibleEnd = pixelTime(scroll + width, zoom);
  const rate = project?.settings.frameRate ?? { numerator: 30, denominator: 1 };
  const ticks = rulerTicks(origin, width, zoom, rate);
  const playheadX = relativePixels(position, origin, zoom);
  const selectedClip = project?.clips.find((clip) => clip.id === selected);
  const previewable =
    selectedClip &&
    project?.tracks.find((track) => track.id === selectedClip.trackId)?.type ===
      'video' &&
    index.assets.get(selectedClip.assetId)?.metadata?.kind !== 'image';

  function measure() {
    const element = scrollRef.current;
    if (element)
      setViewport({
        width: element.clientWidth,
        height: element.clientHeight,
        left: element.scrollLeft,
        top: element.scrollTop,
      });
  }
  useLayoutEffect(() => {
    const element = scrollRef.current!;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    scrollRef.current!.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
    measure();
  }, [zoom]);
  function changeZoom(next: number, anchor: number) {
    if (next === zoom) return;
    const nextGeometry = scrollGeometry(index.end, next, width);
    pendingScroll.current =
      zoomScroll(scroll, anchor, zoom, next) / nextGeometry.ratio;
    setZoom(next);
  }
  zoomHandler.current = changeZoom;
  const currentZoom = useRef(zoom);
  currentZoom.current = zoom;
  useEffect(() => {
    const element = scrollRef.current!;
    function wheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const anchor = Math.max(
        0,
        Math.min(
          element.clientWidth - LABEL_WIDTH,
          event.clientX - element.getBoundingClientRect().left - LABEL_WIDTH,
        ),
      );
      const current = ZOOM_LEVELS.indexOf(currentZoom.current);
      zoomHandler.current(
        ZOOM_LEVELS[
          Math.max(
            0,
            Math.min(
              ZOOM_LEVELS.length - 1,
              current + (event.deltaY < 0 ? 1 : -1),
            ),
          )
        ]!,
        anchor,
      );
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  function seekRuler(event: PointerEvent<SVGSVGElement>) {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    onSeek?.(
      clampTime(
        snapToFrame(pixelTime(scroll + Math.max(0, x), zoom), rate),
        index.end,
      ),
    );
  }
  const firstTrack = Math.max(
    0,
    Math.floor((viewport.top - TRACK_HEIGHT) / TRACK_HEIGHT),
  );
  const lastTrack = Math.min(
    project?.tracks.length ?? 0,
    Math.ceil((viewport.top + viewport.height) / TRACK_HEIGHT) + 1,
  );
  const trackCount = project?.tracks.length ?? 0;
  return (
    <section className="timeline-panel" aria-label="Timeline">
      <div className="panel-heading timeline-heading">
        <h2>
          Timeline ({trackCount} tracks · {project?.clips.length ?? 0} clips)
        </h2>
        <div className="timeline-controls">
          <output
            role="timer"
            aria-live="off"
            data-testid="timeline-timecode"
            title="Project rate, nominal non-drop timecode"
          >
            {timelineTimecode(position, rate)} NDF
          </output>
          <button
            disabled={!previewable}
            onClick={() => selectedClip && onPreviewClip?.(selectedClip.id)}
          >
            Preview selected clip
          </button>
          <button
            aria-label="Zoom out"
            disabled={zoom === ZOOM_LEVELS[0]}
            onClick={() =>
              changeZoom(ZOOM_LEVELS[ZOOM_LEVELS.indexOf(zoom) - 1]!, width / 2)
            }
          >
            −
          </button>
          <label>
            Zoom{' '}
            <select
              aria-label="Timeline zoom"
              value={zoom}
              onChange={(event) =>
                changeZoom(Number(event.currentTarget.value), width / 2)
              }
            >
              {ZOOM_LEVELS.map((value) => (
                <option key={value} value={value}>
                  {value} px/s
                </option>
              ))}
            </select>
          </label>
          <button
            aria-label="Zoom in"
            disabled={zoom === ZOOM_LEVELS.at(-1)}
            onClick={() =>
              changeZoom(ZOOM_LEVELS[ZOOM_LEVELS.indexOf(zoom) + 1]!, width / 2)
            }
          >
            +
          </button>
        </div>
      </div>
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onScroll={measure}
        tabIndex={0}
        aria-label="Scrollable timeline"
      >
        <div
          className="timeline-spacer"
          style={{
            width: LABEL_WIDTH + geometry.physicalWidth,
            height: Math.max(
              viewport.height,
              RULER_HEIGHT + trackCount * TRACK_HEIGHT,
            ),
          }}
        />
        <div
          className="timeline-viewport"
          style={{ width: viewport.width, height: viewport.height }}
        >
          <div className="timeline-row ruler-row" style={{ top: 0 }}>
            <div className="track-heading">TRACKS</div>
            <svg
              className="time-ruler"
              width={width}
              height={RULER_HEIGHT}
              role="slider"
              tabIndex={0}
              aria-label="Timeline playhead"
              aria-valuemin={0}
              aria-valuemax={Number(frameIndex(index.end, rate))}
              aria-valuenow={Number(frameIndex(position, rate))}
              aria-valuetext={timelineTimecode(position, rate)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                dragPointer.current = event.pointerId;
                event.currentTarget.setPointerCapture(event.pointerId);
                seekRuler(event);
              }}
              onPointerMove={(event) => {
                if (
                  dragPointer.current === event.pointerId &&
                  event.buttons & 1
                )
                  seekRuler(event);
              }}
              onPointerUp={(event) => {
                if (dragPointer.current !== event.pointerId) return;
                dragPointer.current = null;
                // Commit the release coordinate too, including input batches that
                // coalesce the final move or release capture before pointerup.
                seekRuler(event);
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                dragPointer.current = null;
              }}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const frame = frameIndex(position, rate);
                const next =
                  event.key === 'Home'
                    ? ZERO
                    : event.key === 'End'
                      ? index.end
                      : framePosition(
                          event.key === 'ArrowLeft'
                            ? frame > 0n
                              ? frame - 1n
                              : 0n
                            : frame + 1n,
                          rate,
                        );
                onSeek?.(clampTime(next, index.end));
              }}
            >
              {ticks.map((tick) => (
                <g key={tick.label}>
                  <line x1={tick.x} x2={tick.x} y1="21" y2="30" />
                  <text x={tick.x + 5} y="14">
                    {tick.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          {!trackCount && (
            <div className="timeline-empty">
              <p>No timeline tracks. Add tracks and clips through the CLI.</p>
            </div>
          )}
          {project?.tracks.slice(firstTrack, lastTrack).map((track, offset) => {
            const trackIndex = firstTrack + offset;
            const clips = index.tracks.get(track.id) ?? [];
            return (
              <div
                className="timeline-row"
                key={track.id}
                data-track-id={track.id}
                style={{
                  top: RULER_HEIGHT + trackIndex * TRACK_HEIGHT - viewport.top,
                }}
              >
                <div className="track-heading" title={track.name}>
                  <span className={`track-badge ${track.type}`}>
                    {track.type === 'video' ? 'V' : 'A'}
                    {trackIndex + 1}
                  </span>
                  <span>
                    <strong>{track.name}</strong>
                    <small>{track.type}</small>
                  </span>
                </div>
                <svg
                  className="track-lane"
                  width={width}
                  height={TRACK_HEIGHT}
                  aria-label={`${track.name} clips`}
                >
                  {ticks.map((tick) => (
                    <line
                      className="timeline-grid"
                      key={tick.label}
                      x1={tick.x}
                      x2={tick.x}
                      y1={0}
                      y2={TRACK_HEIGHT}
                    />
                  ))}
                  {!clips.length && (
                    <text className="empty-lane-label" x="20" y="37">
                      No clips on this track.
                    </text>
                  )}
                  {visibleClips(clips, origin, visibleEnd).map(
                    ({ clip, end }) => {
                      // Clip geometry to the viewport before handing it to SVG; enormous
                      // offscreen coordinates must never reach browser layout/painting.
                      const x = Math.max(
                        -2,
                        relativePixels(clip.timelineStart, origin, zoom),
                      );
                      const right = Math.min(
                        width + 2,
                        relativePixels(end, origin, zoom),
                      );
                      const clipWidth = Math.max(0.5, right - x);
                      const asset = index.assets.get(clip.assetId);
                      return (
                        <g
                          key={clip.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Inspect clip ${clip.id}`}
                          aria-pressed={selected === clip.id}
                          className={`timeline-clip ${track.type}`}
                          onClick={() => onSelect(clip.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onSelect(clip.id);
                            }
                          }}
                        >
                          <title>
                            {clip.id} · {asset?.name} · Start{' '}
                            {exactTime(clip.timelineStart)} · Source{' '}
                            {exactTime(clip.sourceIn)} →{' '}
                            {exactTime(clip.sourceOut)}
                          </title>
                          <rect
                            x={x}
                            y="5"
                            width={clipWidth}
                            height="54"
                            rx="4"
                          />
                          <svg
                            x={x + 1}
                            y="6"
                            width={Math.max(0, clipWidth - 2)}
                            height="52"
                            overflow="hidden"
                          >
                            <text x="10" y="22">
                              {asset?.name ?? clip.assetId}
                            </text>
                            <text className="clip-id" x="10" y="40">
                              {clip.id}
                            </text>
                          </svg>
                        </g>
                      );
                    },
                  )}
                </svg>
              </div>
            );
          })}
          {playheadX >= 0 && playheadX <= width && (
            <div
              className="timeline-playhead"
              data-testid="timeline-playhead"
              style={{ left: LABEL_WIDTH + playheadX }}
            >
              <span />
            </div>
          )}
        </div>
      </div>
      <div className="timeline-footer">
        Read only · Click/drag ruler to seek · Ctrl/⌘ + wheel to zoom ·{' '}
        {linkedClipId
          ? `Source linked to ${linkedClipId}; playhead clamps to its range.`
          : 'Select a video clip, then Preview selected clip to link source playback.'}{' '}
        Reopen after CLI edits.
      </div>
    </section>
  );
}
