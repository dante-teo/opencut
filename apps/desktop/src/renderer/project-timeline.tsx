import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent } from 'react';
import {
  compareTimes,
  audioFadeEdges,
  resolveAudioFade,
  sortSubtitleCues,
  type SubtitleFormat,
  projectRevision,
  clipTimelineEnd,
  type Project,
  type RationalTime,
  type TimelineClip,
} from '@opencut/core';
import {
  Scissors,
  Trash2,
  Clapperboard,
  Type,
  Captions,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { NumberProperty } from './clip-properties.js';
import { ClipArtwork } from './clip-artwork.js';
import { ASSET_DRAG_TYPE, readAssetDrag } from './media-library.js';
import type { AssetClipInput, TimelineOperation } from '../bridge.js';
import {
  proposeEdit,
  proposeSubtitleEdit,
  createTimelinePreview,
  type EditProposal,
  type GestureKind,
} from './timeline-editing.js';
import {
  clampTime,
  frameIndex,
  framePosition,
  indexTimeline,
  isSubtitleLane,
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
  disabled = false,
  onEdit,
  onAddAsset,
  onAddText,
  onAddSubtitle,
  onImportSubtitles,
  onExportSubtitles,
}: {
  project: Project | undefined;
  selected: string | null;
  onSelect: (id: string) => void;
  position?: RationalTime;
  onSeek?: (time: RationalTime) => void;
  onPreviewClip?: (id: string) => void;
  linkedClipId?: string | null;
  disabled?: boolean;
  onAddAsset?: (input: AssetClipInput) => Promise<void>;
  onAddText?: () => Promise<void>;
  onAddSubtitle?: () => Promise<void>;
  onImportSubtitles?: () => void;
  onExportSubtitles?: (format: SubtitleFormat) => void;
  onEdit?: (operations: TimelineOperation[], label: string) => Promise<void>;
}) {
  const gesture = useRef<{
    pointer: number;
    x: number;
    y: number;
    scroll: number;
    project: Project;
    preview: Project;
    clip: TimelineClip;
    kind: GestureKind;
    moved: boolean;
  } | null>(null);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const editingFade =
    gesture.current?.kind === 'fadeIn' || gesture.current?.kind === 'fadeOut';
  const [editError, setEditError] = useState('');
  const [snapPixels, setSnapPixels] = useState(8);
  const [snapping, setSnapping] = useState(true);
  const index = useMemo(() => indexTimeline(project), [project]);
  const previewProject = useMemo(
    () => project && createTimelinePreview(project),
    [project],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const subtitleMenu = useRef<HTMLDetailsElement>(null);
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
  const selectedClip =
    project?.clips.find((clip) => clip.id === selected) ??
    (selected === null ? undefined : index.subtitles.get(selected));
  const selectedSubtitle = selectedClip && isSubtitleLane(selectedClip.trackId);
  const sortedCues = useMemo(
    () => sortSubtitleCues(project?.subtitles?.cues ?? []),
    [project],
  );
  const nextCue = selectedSubtitle
    ? sortedCues[sortedCues.findIndex((cue) => cue.id === selected) + 1]
    : undefined;
  const previewable =
    selectedClip?.assetId &&
    project?.tracks.find((track) => track.id === selectedClip.trackId)?.type ===
      'video' &&
    index.assets.get(selectedClip.assetId)?.metadata?.kind !== 'image';

  const canSplit =
    selectedClip &&
    compareTimes(position, selectedClip.timelineStart) > 0 &&
    compareTimes(position, clipTimelineEnd(selectedClip)) < 0;
  function commit(operations: TimelineOperation[], label: string) {
    if (operations.length && !disabled && !gesture.current && onEdit)
      void onEdit(operations, label);
  }
  function splitSelected() {
    if (selectedClip && canSplit)
      commit(
        [
          {
            ...(selectedSubtitle
              ? { type: 'subtitle.split' as const, at: position }
              : {
                  type: 'clip.split' as const,
                  at: Number(frameIndex(position, rate, true)),
                }),
            id: selectedClip.id,
          },
        ],
        selectedSubtitle ? 'Split subtitle' : 'Split clip',
      );
  }
  function deleteSelected() {
    if (selectedClip)
      commit(
        [
          {
            type: selectedSubtitle ? 'subtitle.remove' : 'clip.remove',
            id: selectedClip.id,
          },
        ],
        selectedSubtitle ? 'Delete subtitle' : 'Delete clip',
      );
  }
  function cancelGesture() {
    const current = gesture.current;
    gesture.current = null;
    setProposal(null);
    if (current && scrollRef.current?.hasPointerCapture(current.pointer))
      scrollRef.current.releasePointerCapture(current.pointer);
  }
  useEffect(() => {
    cancelGesture();
  }, [project, disabled]);
  useEffect(() => {
    window.addEventListener('blur', cancelGesture);
    return () => window.removeEventListener('blur', cancelGesture);
  }, []);
  function beginEdit(
    event: PointerEvent<SVGElement>,
    clip: TimelineClip,
    kind: GestureKind,
  ) {
    if (
      event.button !== 0 ||
      disabled ||
      !onEdit ||
      !project ||
      !previewProject ||
      gesture.current
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    onSelect(clip.id);
    setEditError('');
    gesture.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scroll,
      project,
      preview: previewProject,
      clip,
      kind,
      moved: false,
    };
    scrollRef.current!.setPointerCapture(event.pointerId);
  }
  function updateGesture(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return null;
    const element = scrollRef.current!;
    const offset =
      event.clientX -
      current.x +
      element.scrollLeft * geometry.ratio -
      current.scroll;
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.x, event.clientY - current.y) < 3
    )
      return null;
    current.moved = true;
    const frames =
      frameIndex(pixelTime(Math.abs(offset), zoom), rate, true) *
      (offset < 0 ? -1n : 1n);
    const row = Math.floor(
      (event.clientY -
        element.getBoundingClientRect().top -
        RULER_HEIGHT +
        element.scrollTop) /
        TRACK_HEIGHT,
    );
    const track =
      current.kind === 'move'
        ? (current.project.tracks[row]?.id ?? '')
        : current.clip.trackId;
    const next = isSubtitleLane(current.clip.trackId)
      ? proposeSubtitleEdit(
          current.clip,
          current.kind,
          pixelTime(Math.abs(offset), zoom),
          offset < 0,
          position,
          zoom,
          snapping ? snapPixels : 0,
        )
      : proposeEdit(
          current.preview,
          current.clip,
          current.kind,
          frames,
          track,
          position,
          zoom,
          snapping ? snapPixels : 0,
        );
    if (current.project !== project)
      next.error = 'Project changed during the interaction. Try again.';
    setProposal(next);
    return next;
  }
  function keyboardEdit(
    clip: TimelineClip,
    kind: GestureKind,
    direction: bigint,
    trackId = clip.trackId,
  ) {
    if (!previewProject || disabled || gesture.current) return;
    const next = isSubtitleLane(clip.trackId)
      ? proposeSubtitleEdit(
          clip,
          kind,
          framePosition(direction < 0n ? -direction : direction, rate),
          direction < 0n,
          position,
          zoom,
          0,
        )
      : proposeEdit(
          previewProject,
          clip,
          kind,
          direction,
          trackId,
          position,
          zoom,
          0,
        );
    setEditError(next.error ?? '');
    if (!next.error) commit(next.operations, editLabel(kind, clip));
  }
  function editLabel(kind: GestureKind, clip: TimelineClip) {
    if (kind === 'fadeIn' || kind === 'fadeOut')
      return kind === 'fadeIn' ? 'Set fade in' : 'Set fade out';
    const action = kind === 'move' ? 'Move' : 'Trim';
    return `${action} ${isSubtitleLane(clip.trackId) ? 'subtitle' : 'clip'}`;
  }
  function subtitleAction(action: () => void) {
    if (subtitleMenu.current) subtitleMenu.current.open = false;
    action();
  }
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
      if (gesture.current) return;
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

  async function dropAsset(
    event: DragEvent<HTMLElement>,
    mediaType?: 'video' | 'audio',
  ) {
    event.preventDefault();
    if (disabled || !project || !onAddAsset) return;
    try {
      if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE))
        throw new Error('Import external files into the media library first.');
      const drag = readAssetDrag(event.dataTransfer.getData(ASSET_DRAG_TYPE));
      if (
        drag.projectId !== project.metadata.id ||
        drag.revision !== projectRevision(project)
      )
        throw new Error(
          'Library changed during the drag. Drag the asset again.',
        );
      const element = scrollRef.current!;
      const bounds = element.getBoundingClientRect();
      const x = event.clientX - bounds.left - LABEL_WIDTH;
      if (x < 0 && mediaType === undefined)
        throw new Error('Drop onto a timeline lane.');
      const row = Math.floor(
        (event.clientY - bounds.top - RULER_HEIGHT + element.scrollTop) /
          TRACK_HEIGHT,
      );
      const track = mediaType ? undefined : project.tracks[row];
      if (!track && !mediaType)
        throw new Error('Drop onto a track or a new-track target.');
      // Header targets have no time axis; create their clips at the playhead.
      let at = frameIndex(
        mediaType
          ? position
          : pixelTime(
              element.scrollLeft * geometry.ratio + Math.max(0, x),
              zoom,
            ),
        rate,
        true,
      );
      if (snapping) {
        let distance = snapPixels;
        const target = framePosition(at, rate);
        for (const candidate of [
          ZERO,
          position,
          ...project.clips.flatMap((clip) => [
            clip.timelineStart,
            clipTimelineEnd(clip),
          ]),
        ]) {
          const frame = frameIndex(candidate, rate, true);
          if (compareTimes(framePosition(frame, rate), candidate) !== 0)
            continue;
          const pixels = Math.abs(relativePixels(candidate, target, zoom));
          if (pixels <= distance) {
            at = frame;
            distance = pixels;
          }
        }
      }
      const frame = Number(at);
      if (!Number.isSafeInteger(frame))
        throw new Error('Drop is outside the supported frame range.');
      setEditError('');
      await onAddAsset({
        projectId: drag.projectId,
        expectedRevision: drag.revision,
        assetId: drag.assetId,
        ...(track ? { trackId: track.id } : {}),
        mediaType: mediaType ?? track!.type,
        at: frame,
      });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    }
  }
  function allowAssetDrop(event: DragEvent<HTMLElement>) {
    if (
      !disabled &&
      project &&
      event.dataTransfer.types.includes(ASSET_DRAG_TYPE)
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }
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
    index.rows.length,
    Math.ceil((viewport.top + viewport.height) / TRACK_HEIGHT) + 1,
  );
  const trackCount = index.rows.length;
  return (
    <section
      className="timeline-panel"
      aria-label="Timeline"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          cancelGesture();
          if (subtitleMenu.current) subtitleMenu.current.open = false;
          setEditError('');
          return;
        }
        const target = event.target as Element;
        if (
          event.defaultPrevented ||
          event.repeat ||
          event.nativeEvent.isComposing ||
          target.closest(
            'input, select, textarea, [contenteditable]:not([contenteditable="false"])',
          ) ||
          disabled ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          deleteSelected();
        } else if (event.key.toLowerCase() === 's') {
          event.preventDefault();
          splitSelected();
        }
      }}
    >
      <div className="panel-heading timeline-heading">
        <div className="timeline-title">
          <h2>
            Timeline (
            {(project?.tracks.length ?? 0) + Number(sortedCues.length > 0)}{' '}
            tracks · {project?.clips.length ?? 0} clips
            {sortedCues.length > 0 && <> · {sortedCues.length} cues</>})
          </h2>
          {project && (
            <div className="new-track-targets">
              {(['video', 'audio'] as const).map((type) => (
                <div
                  key={type}
                  role="region"
                  aria-label={`New ${type} track drop target`}
                  onDragOver={allowAssetDrop}
                  onDrop={(event) => {
                    void dropAsset(event, type);
                  }}
                >
                  + {type === 'video' ? 'Video' : 'Audio'} track
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="timeline-controls">
          <button
            disabled={disabled || !project || !!proposal}
            onClick={() => void onAddText?.()}
          >
            <Type aria-hidden="true" /> Add text
          </button>
          {project && (
            <details ref={subtitleMenu} className="subtitle-menu">
              <summary>
                <Captions aria-hidden="true" /> Subtitles
              </summary>
              <div className="subtitle-actions">
                <button
                  disabled={disabled || !!proposal}
                  onClick={() => subtitleAction(() => void onAddSubtitle?.())}
                >
                  Add subtitle
                </button>
                <button
                  disabled={disabled || !!proposal}
                  onClick={() => subtitleAction(() => onImportSubtitles?.())}
                >
                  Import SRT / WebVTT…
                </button>
                <button
                  disabled={disabled || !!proposal || !sortedCues.length}
                  onClick={() =>
                    subtitleAction(() => onExportSubtitles?.('srt'))
                  }
                >
                  Export SRT…
                </button>
                <button
                  disabled={disabled || !!proposal || !sortedCues.length}
                  onClick={() =>
                    subtitleAction(() => onExportSubtitles?.('vtt'))
                  }
                >
                  Export WebVTT…
                </button>
                {selectedSubtitle && (
                  <button
                    disabled={disabled || !!proposal || !nextCue}
                    onClick={() =>
                      subtitleAction(() =>
                        commit(
                          [
                            {
                              type: 'subtitle.merge',
                              ids: [selectedClip.id, nextCue!.id],
                            },
                          ],
                          'Merge subtitles',
                        ),
                      )
                    }
                  >
                    Merge with next subtitle
                  </button>
                )}
              </div>
            </details>
          )}
          <button
            disabled={disabled || !canSplit || !!proposal}
            onClick={splitSelected}
            aria-label="Split at playhead"
            title="Split at playhead (S)"
          >
            <Scissors aria-hidden="true" /> Split
          </button>
          <button
            disabled={disabled || !selectedClip || !!proposal}
            onClick={deleteSelected}
            aria-label={selectedSubtitle ? 'Delete subtitle' : 'Delete clip'}
            title={
              selectedSubtitle
                ? 'Delete subtitle (Delete)'
                : 'Delete clip (Delete)'
            }
          >
            <Trash2 aria-hidden="true" />
          </button>
          <label>
            <input
              type="checkbox"
              checked={snapping}
              disabled={!!proposal}
              onChange={(event) => setSnapping(event.currentTarget.checked)}
            />{' '}
            Snap
          </label>
          <label>
            Snap px{' '}
            <input
              aria-label="Snap threshold pixels"
              type="number"
              min="0"
              max="40"
              step="1"
              value={snapPixels}
              disabled={!!proposal}
              onChange={(event) =>
                setSnapPixels(
                  Math.max(0, Math.min(40, Number(event.currentTarget.value))),
                )
              }
            />
          </label>
          <output
            role="timer"
            aria-live="off"
            data-testid="timeline-timecode"
            title="Project rate, nominal non-drop timecode"
          >
            {timelineTimecode(position, rate)} NDF
          </output>
          <button
            aria-label="Preview selected clip"
            title="Preview selected clip"
            disabled={!previewable}
            onClick={() => selectedClip && onPreviewClip?.(selectedClip.id)}
          >
            <Clapperboard aria-hidden="true" />
          </button>
          <button
            aria-label="Zoom out"
            disabled={!!proposal || zoom === ZOOM_LEVELS[0]}
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
              disabled={!!proposal}
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
            disabled={!!proposal || zoom === ZOOM_LEVELS.at(-1)}
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
        onDragOver={allowAssetDrop}
        onDrop={(event) => {
          void dropAsset(event);
        }}
        ref={scrollRef}
        onScroll={measure}
        onPointerMove={updateGesture}
        onPointerUp={(event) => {
          if (gesture.current?.pointer !== event.pointerId) return;
          const current = gesture.current;
          const next = updateGesture(event);
          cancelGesture();
          if (!next) return;
          setEditError(next.error ?? '');
          if (!next.error)
            commit(next.operations, editLabel(current.kind, current.clip));
        }}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={(event) => {
          if (gesture.current?.pointer === event.pointerId) cancelGesture();
        }}
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
                if (event.button !== 0 || gesture.current) return;
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
              <p>Drag media here</p>
            </div>
          )}
          {index.rows.slice(firstTrack, lastTrack).map((track, offset) => {
            const trackIndex = firstTrack + offset;
            const top = RULER_HEIGHT + trackIndex * TRACK_HEIGHT - viewport.top;
            const artworkVisible =
              top < viewport.height && top + TRACK_HEIGHT > RULER_HEIGHT;
            const clips = index.tracks.get(track.id) ?? [];
            return (
              <div
                className="timeline-row"
                key={track.id}
                data-track-id={track.id}
                style={{
                  top,
                }}
              >
                <div className="track-heading" title={track.name}>
                  <span className={`track-badge ${track.type}`}>
                    {track.type === 'subtitle' ? (
                      <Captions aria-hidden="true" size={14} />
                    ) : (
                      `${track.type === 'video' ? 'V' : 'A'}${trackIndex + 1}`
                    )}
                  </span>
                  <div className="track-name">
                    <strong>{track.name}</strong>
                    {track.type !== 'subtitle' && (
                      <div className="track-audio-controls">
                        <NumberProperty
                          label={`${track.name} track volume`}
                          value={track.volume ?? 1}
                          min={0}
                          max={1}
                          step={0.01}
                          slider
                          compact
                          decibels
                          disabled={disabled || !onEdit}
                          onCommit={(volume) =>
                            onEdit?.(
                              [{ type: 'track.audio', id: track.id, volume }],
                              'Set track volume',
                            ) ?? Promise.resolve()
                          }
                        />
                        <button
                          type="button"
                          aria-label={`Mute ${track.name} track`}
                          title={track.muted ? 'Unmute track' : 'Mute track'}
                          aria-pressed={track.muted ?? false}
                          disabled={disabled || !onEdit}
                          onClick={() =>
                            commit(
                              [
                                {
                                  type: 'track.audio',
                                  id: track.id,
                                  muted: !track.muted,
                                },
                              ],
                              'Set track mute',
                            )
                          }
                        >
                          {track.muted ? (
                            <VolumeX size={13} aria-hidden="true" />
                          ) : (
                            <Volume2 size={13} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
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
                      const clipLeft = relativePixels(
                        clip.timelineStart,
                        origin,
                        zoom,
                      );
                      const clipRight = relativePixels(end, origin, zoom);
                      const x = Math.max(-2, clipLeft);
                      const clipWidth = Math.max(
                        0.5,
                        Math.min(width + 2, clipRight) - x,
                      );
                      const artworkWidth = Math.max(0, clipWidth - 2);
                      const asset =
                        clip.assetId === undefined
                          ? undefined
                          : index.assets.get(clip.assetId);
                      const title = clip.text
                        ? clip.text.content
                            .split(/\r?\n/, 1)[0]
                            ?.trim()
                            .slice(0, 100) ||
                          (track.type === 'subtitle' ? 'Subtitle' : 'Text')
                        : (asset?.name ?? 'Missing media');
                      return (
                        <g
                          key={clip.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Inspect ${track.type === 'subtitle' ? 'subtitle' : 'clip'} ${clip.id}`}
                          aria-pressed={selected === clip.id}
                          className={`timeline-clip ${track.type === 'subtitle' ? 'subtitle' : clip.text ? 'text' : track.type}`}
                          onClick={() => onSelect(clip.id)}
                          onPointerDown={(event) =>
                            beginEdit(event, clip, 'move')
                          }
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            if (
                              [
                                'ArrowLeft',
                                'ArrowRight',
                                'ArrowUp',
                                'ArrowDown',
                              ].includes(event.key)
                            ) {
                              event.preventDefault();
                              if (
                                event.key === 'ArrowLeft' ||
                                event.key === 'ArrowRight'
                              )
                                keyboardEdit(
                                  clip,
                                  'move',
                                  (event.key === 'ArrowLeft' ? -1n : 1n) *
                                    (event.shiftKey ? 10n : 1n),
                                );
                              else if (track.type !== 'subtitle') {
                                const direction =
                                  event.key === 'ArrowUp' ? -1 : 1;
                                for (
                                  let i = trackIndex + direction;
                                  project &&
                                  i >= 0 &&
                                  i < project.tracks.length;
                                  i += direction
                                ) {
                                  const destination = project.tracks[i]!;
                                  if (
                                    clip.text
                                      ? destination.type === 'video'
                                      : asset?.mediaTypes.includes(
                                          destination.type,
                                        )
                                  ) {
                                    keyboardEdit(
                                      clip,
                                      'move',
                                      0n,
                                      destination.id,
                                    );
                                    break;
                                  }
                                }
                              }
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onSelect(clip.id);
                            }
                          }}
                        >
                          <title>
                            {clip.id} · {title} ·{' '}
                            {exactTime(clip.timelineStart)} → {exactTime(end)}
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
                            width={artworkWidth}
                            height="52"
                            overflow="hidden"
                          >
                            {project && artworkVisible && !clip.text && (
                              <ClipArtwork
                                project={project}
                                clip={clip}
                                asset={asset}
                                audio={track.type === 'audio'}
                                offset={Math.max(0, x + 1 - clipLeft)}
                                width={artworkWidth}
                                zoom={zoom}
                              />
                            )}
                            <text className="clip-name" x="8" y="14">
                              {title}
                            </text>
                          </svg>
                          {(['left', 'right'] as const).map((edge) => {
                            const boundaryX =
                              edge === 'left' ? clipLeft : clipRight;
                            if (boundaryX < 0 || boundaryX > width) return null;
                            const handleWidth = Math.min(8, clipWidth / 3);
                            return (
                              <rect
                                key={edge}
                                className="trim-handle"
                                data-trim={edge}
                                role="button"
                                tabIndex={0}
                                aria-label={`Trim ${edge === 'left' ? 'start' : 'end'} of ${clip.id}`}
                                x={
                                  edge === 'left'
                                    ? boundaryX
                                    : boundaryX - handleWidth
                                }
                                y="6"
                                width={handleWidth}
                                height="52"
                                onPointerDown={(event) =>
                                  beginEdit(event, clip, edge)
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key !== 'ArrowLeft' &&
                                    event.key !== 'ArrowRight'
                                  )
                                    return;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onSelect(clip.id);
                                  keyboardEdit(
                                    clip,
                                    edge,
                                    (event.key === 'ArrowLeft' ? -1n : 1n) *
                                      (event.shiftKey ? 10n : 1n),
                                  );
                                }}
                              />
                            );
                          })}
                          {!clip.text &&
                            (track.type === 'audio' ||
                              (track.type === 'video' &&
                                asset?.metadata?.hasAudio !== false)) &&
                            audioFadeEdges.map((edge) => {
                              const left = edge === 'fadeIn';
                              const direction = left ? 1 : -1;
                              const fade =
                                editingFade &&
                                proposal?.clip.id === clip.id &&
                                !proposal.error
                                  ? proposal.clip[edge]
                                  : clip[edge];
                              const boundary = left ? clipLeft : clipRight;
                              const fadeX = fade
                                ? boundary +
                                  direction *
                                    relativePixels(fade.duration, ZERO, zoom)
                                : boundary;
                              // Clamp line geometry at the viewport and interpolate its height there.
                              const clipped = (x: number) =>
                                Math.max(-2, Math.min(width + 2, x));
                              const bounds =
                                fade && resolveAudioFade(edge, fade);
                              const outer =
                                (left ? bounds?.from : bounds?.to) ?? 0;
                              const inner =
                                (left ? bounds?.to : bounds?.from) ?? 1;
                              const y = (x: number) =>
                                55 -
                                30 *
                                  (outer +
                                    (inner - outer) *
                                      (boundary === fadeX
                                        ? 0
                                        : (x - boundary) / (fadeX - boundary)));
                              const handle = fade
                                ? fadeX
                                : boundary +
                                  direction *
                                    Math.min(13, (clipRight - clipLeft) / 2);
                              const label = `${left ? 'Fade in' : 'Fade out'} of ${clip.id}`;
                              return (
                                <g key={edge} className="clip-fade">
                                  {fade && (
                                    <line
                                      data-fade={edge}
                                      x1={clipped(boundary)}
                                      y1={y(clipped(boundary))}
                                      x2={clipped(fadeX)}
                                      y2={y(clipped(fadeX))}
                                    />
                                  )}
                                  {selected === clip.id &&
                                    !disabled &&
                                    clipWidth >= 13 &&
                                    handle >= 0 &&
                                    handle <= width && (
                                      <circle
                                        className="fade-handle"
                                        data-fade-handle={edge}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={label}
                                        cx={handle}
                                        cy={left ? 29 : 43}
                                        r="5"
                                        onPointerDown={(event) =>
                                          beginEdit(event, clip, edge)
                                        }
                                        onKeyDown={(event) => {
                                          if (
                                            ![
                                              'ArrowLeft',
                                              'ArrowRight',
                                            ].includes(event.key)
                                          )
                                            return;
                                          event.preventDefault();
                                          event.stopPropagation();
                                          keyboardEdit(
                                            clip,
                                            edge,
                                            (event.key === 'ArrowLeft'
                                              ? -1n
                                              : 1n) *
                                              (event.shiftKey ? 10n : 1n),
                                          );
                                        }}
                                      />
                                    )}
                                </g>
                              );
                            })}
                        </g>
                      );
                    },
                  )}
                </svg>
              </div>
            );
          })}
          {proposal &&
            !editingFade &&
            (() => {
              const row = index.rows.findIndex(
                (track) => track.id === proposal.clip.trackId,
              );
              const x = Math.max(
                0,
                relativePixels(proposal.clip.timelineStart, origin, zoom),
              );
              const right = Math.min(
                width,
                relativePixels(clipTimelineEnd(proposal.clip), origin, zoom),
              );
              return (
                <svg
                  className={`edit-preview ${proposal.error ? 'invalid' : ''}`}
                  data-testid="edit-preview"
                  width={viewport.width}
                  height={viewport.height}
                >
                  <rect
                    x={LABEL_WIDTH + x}
                    y={RULER_HEIGHT + row * TRACK_HEIGHT - viewport.top + 5}
                    width={Math.max(0, right - x)}
                    height="54"
                    rx="4"
                  />
                  {proposal.snap && (
                    <line
                      className="snap-guide"
                      x1={
                        LABEL_WIDTH +
                        relativePixels(proposal.snap, origin, zoom)
                      }
                      x2={
                        LABEL_WIDTH +
                        relativePixels(proposal.snap, origin, zoom)
                      }
                      y1="0"
                      y2={viewport.height}
                    />
                  )}
                </svg>
              );
            })()}
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
      {(proposal || editError || linkedClipId) && (
        <div className="timeline-footer">
          {(proposal?.error || editError) && (
            <span role="alert">{proposal?.error || editError} </span>
          )}
          {proposal && !proposal.error && (
            <span role="status">
              {gesture.current?.kind === 'move' ? 'Move' : 'Trim'} ·{' '}
              {exactTime(proposal.clip.timelineStart)} →{' '}
              {exactTime(clipTimelineEnd(proposal.clip))}
              {proposal.snap ? ' · Snapped' : ''} · Release to commit · Esc to
              cancel.{' '}
            </span>
          )}
          {linkedClipId && (
            <span
              title={`Source linked to ${linkedClipId}; playhead clamps to its range.`}
            >
              Source linked
            </span>
          )}
        </div>
      )}
    </section>
  );
}
