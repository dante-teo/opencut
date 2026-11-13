import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import type { FrameRate } from '@opencut/core';
import type { PreviewSource } from '../bridge.js';
import {
  benchmarkPreview,
  frameAt,
  frameTarget,
  lastFrameIndex,
  seekPresented,
  previewTimecode,
  type PreviewBenchmark,
} from './preview.js';

export interface PreviewTransport {
  setPlaying?(playing: boolean): void;
  seekSeconds?(seconds: number): void;
  toggle(): void;
  step(direction: -1 | 1): void;
}

/** Source-local transport. Position props/callbacks are transient, in seconds. */
export function VideoPreview({
  source,
  opening = false,
  active = true,
  projectFrameRate,
  positionSeconds,
  positionRequestKey = 0,
  onPositionChange,
  onBusyChange,
  transportRef,
}: {
  source: PreviewSource;
  opening?: boolean;
  active?: boolean;
  projectFrameRate?: FrameRate | undefined;
  positionSeconds?: number | undefined;
  positionRequestKey?: number;
  onPositionChange?: ((seconds: number) => void) | undefined;
  onBusyChange?: (busy: boolean) => void;
  transportRef?: Ref<PreviewTransport> | undefined;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const latestPresented = useRef<number | null>(null);
  const cancelSeekDrag = useRef<(() => void) | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const actionPending = useRef(false);
  const positionCallback = useRef(onPositionChange);
  positionCallback.current = onPositionChange;
  const reportedPosition = useRef<number | null>(null);
  const appliedPosition = useRef<number | undefined>(undefined);
  const appliedRequest = useRef<number | undefined>(undefined);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [presented, setPresented] = useState<number | null>(null);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<PreviewBenchmark | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const fps = projectFrameRate
    ? projectFrameRate.numerator / projectFrameRate.denominator
    : source.frameRate;
  const rate =
    projectFrameRate ?? (fps ? { numerator: fps, denominator: 1 } : null);
  const videoEnd = Math.min(duration, source.videoEndSeconds ?? duration);
  useEffect(() => {
    const video = ref.current!;
    const controller = new AbortController();
    lifetime.current = controller;
    actionPending.current = false;
    latestPresented.current = null;
    reportedPosition.current = null;
    appliedPosition.current = undefined;
    appliedRequest.current = undefined;
    setReady(false);
    setPlaying(false);
    setTime(0);
    setPresented(null);
    setDuration(0);
    setBusy(false);
    busyCallback.current?.(false);
    setError('');
    setReport(null);
    setLatency(null);
    // Restore the source after StrictMode's development effect cleanup.
    if (video.getAttribute('src') !== source.url) video.src = source.url;
    let callback = 0;
    const observe: VideoFrameRequestCallback = (_now, metadata) => {
      latestPresented.current = metadata.mediaTime;
      setPresented(metadata.mediaTime);
      setTime(video.currentTime);
      reportedPosition.current = video.currentTime;
      positionCallback.current?.(video.currentTime);
      callback = video.requestVideoFrameCallback(observe);
    };
    callback = video.requestVideoFrameCallback(observe);
    return () => {
      cancelSeekDrag.current?.();
      lifetime.current?.abort();
      video.cancelVideoFrameCallback(callback);
      video.pause();
      video.removeAttribute('src');
      video.load();
      busyCallback.current?.(false);
    };
  }, [source.url]);
  useEffect(() => {
    if (!active || opening) ref.current?.pause();
    if (!active) {
      cancelSeekDrag.current?.();
      lifetime.current?.abort();
      actionPending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    } else if (lifetime.current?.signal.aborted) {
      lifetime.current = new AbortController();
    }
  }, [active, opening]);
  // Timeline seek requests are transient and never stored in the project.
  // Apply each changed external request once. Echoing reported positions must
  // not pause playback or keep reapplying an old seek after pressing Play.
  // Coalesce external positions while an interactive seek/drag is settling.
  useEffect(() => {
    const video = ref.current;
    if (
      !video ||
      !ready ||
      // A second ruler request can arrive while the first seek is decoding.
      // Apply it once metadata exists instead of deferring it until Play,
      // which would otherwise pause playback with an old seek request.
      video.readyState < HTMLMediaElement.HAVE_METADATA ||
      busy ||
      seekDraft !== null ||
      opening ||
      positionSeconds === undefined ||
      !Number.isFinite(positionSeconds) ||
      (positionSeconds === appliedPosition.current &&
        positionRequestKey === appliedRequest.current)
    )
      return;
    appliedPosition.current = positionSeconds;
    appliedRequest.current = positionRequestKey;
    if (positionSeconds === reportedPosition.current) return;
    const target = Math.max(0, Math.min(duration - 0.000001, positionSeconds));
    if (Math.abs(video.currentTime - target) < 0.000001) return;
    video.pause();
    video.currentTime = target;
  }, [
    positionSeconds,
    positionRequestKey,
    ready,
    busy,
    seekDraft,
    opening,
    duration,
  ]);
  async function perform(
    action: (video: HTMLVideoElement, signal: AbortSignal) => Promise<void>,
  ) {
    const signal = lifetime.current?.signal;
    if (
      actionPending.current ||
      opening ||
      !active ||
      cancelSeekDrag.current ||
      !ref.current ||
      !signal ||
      signal.aborted
    )
      return;
    actionPending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      await action(ref.current, signal);
    } catch (error) {
      if (!signal.aborted)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal.aborted && lifetime.current?.signal === signal) {
        actionPending.current = false;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  async function seek(video: HTMLVideoElement, target: number) {
    video.pause();
    if (Math.abs(video.currentTime - target) < 0.000001) return;
    if (
      !projectFrameRate &&
      fps &&
      latestPresented.current !== null &&
      frameAt(latestPresented.current, fps) === Math.floor(target * fps)
    )
      return;
    const signal = lifetime.current?.signal;
    const sample = await seekPresented(video, target, signal);
    if (signal?.aborted) return;
    setTime(video.currentTime);
    latestPresented.current = sample.presentedSeconds;
    setPresented(sample.presentedSeconds);
    setLatency(sample.presentedMs);
  }
  async function step(video: HTMLVideoElement, direction: -1 | 1) {
    if (!fps) return;
    const frame =
      (projectFrameRate
        ? Math.floor(video.currentTime * fps + 0.000001)
        : frameAt(latestPresented.current ?? video.currentTime, fps)) +
      direction;
    await seek(video, frameTarget(frame, fps, videoEnd));
  }
  async function seekFromSlider(video: HTMLVideoElement, value: number) {
    await seek(
      video,
      fps
        ? frameTarget(value, fps, videoEnd)
        : Math.min(value, duration - 0.001),
    );
  }
  function beginSeekDrag(event: ReactPointerEvent<HTMLInputElement>) {
    if (disabled || cancelSeekDrag.current) return;
    const input = event.currentTarget;
    const pointerId = event.pointerId;
    ref.current?.pause();
    setSeekDraft(Number(input.value));
    onBusyChange?.(true);
    const cleanup = () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', cancel);
      cancelSeekDrag.current = null;
    };
    const cancel = () => {
      cleanup();
      setSeekDraft(null);
      onBusyChange?.(false);
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (event.type === 'pointercancel') {
        cancel();
        return;
      }
      const value = Number(input.value);
      cleanup();
      setSeekDraft(null);
      void perform((video) => seekFromSlider(video, value));
    };
    cancelSeekDrag.current = cancel;
    // Window listeners also finish a drag released outside the input.
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', cancel);
  }
  const disabled = !ready || busy || opening || !active;
  const transportDisabled = disabled || seekDraft !== null;
  const lastFrame = fps ? lastFrameIndex(videoEnd, fps) : 0;
  const seekPosition =
    seekDraft ?? (fps ? Math.min(lastFrame, Math.floor(time * fps)) : time);
  const seekTime =
    seekDraft === null ? time : fps ? seekDraft / fps : seekDraft;
  const toggle = async (video: HTMLVideoElement) => {
    if (video.paused) await video.play();
    else video.pause();
  };
  useImperativeHandle(transportRef, () => ({
    seekSeconds(seconds) {
      if (!transportDisabled)
        void perform((video) => seek(video, Math.min(seconds, video.duration)));
    },
    setPlaying(playing) {
      if (!transportDisabled)
        void perform(async (video) => {
          if (playing) await video.play();
          else video.pause();
        });
    },
    toggle() {
      if (!transportDisabled) void perform(toggle);
    },
    step(direction) {
      if (!transportDisabled && fps)
        void perform((video) => step(video, direction));
    },
  }));
  function keyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      event.nativeEvent.isComposing ||
      target.closest(
        'input, button, select, textarea, [contenteditable="true"]',
      )
    )
      return;
    const key = event.key.toLowerCase();
    if (
      ![' ', 'k', 'arrowleft', 'arrowright', ',', '.', 'home', 'end'].includes(
        key,
      )
    )
      return;
    event.preventDefault();
    if (transportDisabled) return;
    if (key === ' ' || key === 'k') void perform(toggle);
    else if (key === 'home' || key === 'end')
      void perform((video) =>
        seek(video, key === 'home' ? 0 : Math.max(0, videoEnd - 0.000001)),
      );
    else if (fps)
      void perform((video) =>
        step(video, key === ',' || key === 'arrowleft' ? -1 : 1),
      );
  }
  return (
    <div
      className="player"
      aria-label="Video preview player"
      role="region"
      tabIndex={0}
      onKeyDown={keyboard}
      aria-busy={busy}
    >
      <h2 title={source.name}>{source.name}</h2>
      <p className="media-detail">
        {source.width && source.height
          ? `${source.width} × ${source.height} · `
          : ''}
        {source.frameRate
          ? `${source.frameRate.toFixed(3)} fps average`
          : 'Source frame rate unknown'}
        {projectFrameRate &&
          ` · Project ${projectFrameRate.numerator}/${projectFrameRate.denominator} fps`}
      </p>
      <video
        ref={ref}
        src={source.url}
        preload="auto"
        playsInline
        onLoadedData={() => {
          const video = ref.current!;
          if (
            !Number.isFinite(video.duration) ||
            video.duration <= 0 ||
            !video.videoWidth
          ) {
            setError('This file has no supported finite-duration video.');
            return;
          }
          setDuration(video.duration);
          setReady(true);
        }}
        onPlay={() => {
          if (!active || opening || lifetime.current?.signal.aborted)
            ref.current?.pause();
          else setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => {
          const seconds = ref.current!.currentTime;
          setTime(seconds);
          reportedPosition.current = seconds;
          positionCallback.current?.(seconds);
        }}
        onError={() => {
          setReady(false);
          ref.current?.pause();
          setError(
            'Unable to decode this video. Try H.264/AAC MP4 or a supported WebM file.',
          );
        }}
      />
      <div className="transport">
        <button
          disabled={transportDisabled || !fps}
          onClick={() => void perform((video) => step(video, -1))}
        >
          Previous frame
        </button>
        <button
          disabled={transportDisabled}
          onClick={() => void perform(toggle)}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          disabled={transportDisabled || !fps}
          onClick={() => void perform((video) => step(video, 1))}
        >
          Next frame
        </button>
      </div>
      <label className="seek-label">
        Seek
        <input
          aria-label="Seek"
          type="range"
          min="0"
          max={fps ? lastFrame : duration}
          step={fps ? 1 : 0.01}
          value={seekPosition}
          aria-valuetext={`${seekTime.toFixed(3)} seconds`}
          disabled={disabled}
          onPointerDown={beginSeekDrag}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (cancelSeekDrag.current) setSeekDraft(value);
            else void perform((video) => seekFromSlider(video, value));
          }}
        />
      </label>
      {rate && (
        <output
          data-testid="timecode"
          title={
            projectFrameRate
              ? 'Project rate, non-drop timecode'
              : 'Source average rate, non-drop timecode'
          }
        >
          {previewTimecode(time, rate)}{' '}
          <span className="timecode-divider">/</span>{' '}
          {previewTimecode(duration, rate)}{' '}
          <span className="timecode-divider">NDF</span>
        </output>
      )}
      {source.warning && <p role="note">{source.warning}</p>}
      {error && <p role="alert">{error}</p>}
      {busy && (
        <p className="media-detail" role="note">
          Working… Keep this window visible.
        </p>
      )}
      <div className="preview-tools">
        <details className="preview-details">
          <summary>
            {report ? 'Details & measurements' : 'Details & shortcuts'}
          </summary>
          <div className="preview-details-content">
            <output data-testid="position">
              Time {time.toFixed(3)} / {duration.toFixed(3)} s · Presented{' '}
              {presented === null ? '—' : presented.toFixed(6)} s · Frame{' '}
              {fps
                ? projectFrameRate
                  ? Math.floor(time * fps + 0.000001)
                  : presented !== null
                    ? frameAt(presented, fps)
                    : '—'
                : '—'}{' '}
              (nominal, zero based{projectFrameRate ? ', project clock' : ''})
            </output>
            <button
              disabled={transportDisabled}
              onClick={() =>
                void perform(async (video, signal) => {
                  setReport(null);
                  const result = await benchmarkPreview(
                    video,
                    source.frameRate,
                    () => window.opencut.getPreviewMetrics(),
                    signal,
                  );
                  if (!signal.aborted) setReport(result);
                })
              }
            >
              Run performance validation
            </button>

            {latency !== null && (
              <p className="media-detail">
                Last seek to presented frame: {latency.toFixed(1)} ms
              </p>
            )}
            <p className="media-detail">
              Frame steps seek by{' '}
              {projectFrameRate ? 'project FPS' : 'average source FPS'}. HTML
              video seeking is best effort; VFR, differing rates and stream
              offsets can repeat or skip decoded frames. Frame numbers are
              approximate.
            </p>
            <p className="media-detail">
              Focus player: Space/K play or pause · ←/→ or ,/. step · Home/End
              seek. The seek slider also supports arrow keys.
            </p>
            <p className="media-detail">
              Performance validation runs 30 seeks and up to 8 seconds of
              playback. Keep this window visible.
            </p>
            {report && (
              <div className="measurements">
                <p>
                  Seek to presented frame: median{' '}
                  {report.seek.presentedMs.median.toFixed(1)} ms · p95{' '}
                  {report.seek.presentedMs.p95.toFixed(1)} ms
                </p>
                <p>
                  Playback: {report.playback.droppedFrames} /{' '}
                  {report.playback.totalFrames} dropped frames (
                  {report.playback.droppedPercent.toFixed(2)}%) ·{' '}
                  {report.playback.waitingEvents} waiting events
                </p>
                <output
                  data-testid="benchmark-result"
                  data-report={JSON.stringify(report)}
                >
                  Performance validation complete
                </output>
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

function SimpleSourcePreview({
  source,
  active,
  transportRef,
}: {
  source: PreviewSource;
  active: boolean;
  transportRef?: Ref<PreviewTransport> | undefined;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState('');
  useImperativeHandle(transportRef, () => ({
    seekSeconds(seconds) {
      if (active && audio.current && Number.isFinite(audio.current.duration))
        audio.current.currentTime = Math.min(seconds, audio.current.duration);
    },
    setPlaying(playing) {
      const player = audio.current;
      if (!active || !player) return;
      if (playing)
        void player.play().catch((error: unknown) => setError(String(error)));
      else player.pause();
    },
    toggle() {
      const player = audio.current;
      if (!active || !player) return;
      if (player.paused)
        void player.play().catch((error: unknown) => setError(String(error)));
      else player.pause();
    },
    step() {},
  }));
  useEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  useEffect(() => {
    const player = audio.current;
    // StrictMode replays cleanup without recreating the audio element.
    if (player && player.getAttribute('src') !== source.url)
      player.src = source.url;
    return () => {
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    };
  }, [source.url]);
  return (
    <div className="simple-source-preview">
      <h2>{source.name}</h2>
      {source.kind === 'image' ? (
        <img
          src={source.url}
          alt={source.name}
          onError={() => setError('Unable to decode this image.')}
        />
      ) : (
        <audio
          ref={audio}
          src={source.url}
          controls
          preload="metadata"
          onPlay={() => {
            if (!active) audio.current?.pause();
          }}
          onError={() => setError('Unable to decode this audio.')}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function Preview({
  assetId = null,
  requestKey = 0,
  projectFrameRate,
  active = true,
  positionSeconds,
  positionRequestKey = 0,
  onPositionChange,
  onOpenLocal,
  transportRef,
}: {
  assetId?: string | null;
  requestKey?: number;
  projectFrameRate?: FrameRate | undefined;
  active?: boolean;
  positionSeconds?: number | undefined;
  positionRequestKey?: number;
  onPositionChange?: ((seconds: number) => void) | undefined;
  onOpenLocal?: () => void;
  transportRef?: Ref<PreviewTransport> | undefined;
}) {
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [opening, setOpening] = useState(false);
  const [playerBusy, setPlayerBusy] = useState(false);
  const [error, setError] = useState('');
  const selectionVersion = useRef(0);
  function openSource(load: () => Promise<PreviewSource | null>) {
    const version = ++selectionVersion.current;
    const isCurrent = () => version === selectionVersion.current;
    setOpening(true);
    setError('');
    void load()
      .then((next) => {
        if (isCurrent()) {
          if (next) setSource(next);
        } else if (next)
          void window.opencut.releasePreview(next.url).catch(() => {});
      })
      .catch((error: unknown) => {
        if (isCurrent())
          setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (isCurrent()) setOpening(false);
      });
  }
  useEffect(() => {
    return () => {
      selectionVersion.current++;
    };
  }, []);
  useEffect(() => {
    if (!source) return;
    return () => {
      void window.opencut.releasePreview(source.url).catch(() => {});
    };
  }, [source]);
  useEffect(() => {
    if (!assetId) return;
    setSource(null);
    setPlayerBusy(false);
    openSource(() => window.opencut.previewAsset(assetId));
    return () => {
      selectionVersion.current++;
    };
  }, [assetId, requestKey]);
  return (
    <section className="preview">
      <div className="preview-heading">
        <h2>Video preview</h2>
        <button
          disabled={opening || playerBusy}
          onClick={() => {
            onOpenLocal?.();
            openSource(() => window.opencut.openPreview());
          }}
        >
          {opening ? 'Opening…' : 'Open video'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {source &&
        (source.kind === 'image' || source.kind === 'audio' ? (
          <SimpleSourcePreview
            transportRef={transportRef}
            key={source.url}
            source={source}
            active={active}
          />
        ) : (
          <VideoPreview
            transportRef={transportRef}
            key={source.url}
            source={source}
            opening={opening}
            active={active}
            projectFrameRate={projectFrameRate}
            positionSeconds={positionSeconds}
            positionRequestKey={positionRequestKey}
            onPositionChange={onPositionChange}
            onBusyChange={setPlayerBusy}
          />
        ))}
    </section>
  );
}
