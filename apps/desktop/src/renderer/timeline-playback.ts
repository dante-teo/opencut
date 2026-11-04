import { fittingBox, visualGeometry } from '@opencut/shared';
import {
  addTimes,
  compareTimes,
  createTimelineEvaluator,
  projectRevision,
  resolveTimeline,
  type ResolvedTimelineClip,
  type Project,
  type RationalTime,
} from '@opencut/core';
import type { PreviewSource } from '../bridge.js';
import {
  clampTime,
  frameIndex,
  framePosition,
  ZERO,
} from './timeline-geometry.js';

export const seconds = (time: RationalTime) =>
  time.numerator / time.denominator;

// Chromium's media timestamps are quantized to microseconds. Land just inside
// the requested frame so conversion of a repeating rational cannot seek to the
// preceding frame. The evaluator and playback clock retain the exact time.
const decoderSeekTime = (time: RationalTime) => seconds(time) + 0.000001;

/** Compare without constructing a possibly unrepresentable time + 2 seconds. */
export function inPlaybackLookahead(start: RationalTime, time: RationalTime) {
  const delta =
    BigInt(start.numerator) * BigInt(time.denominator) -
    BigInt(time.numerator) * BigInt(start.denominator);
  return (
    delta > 0n &&
    delta <= 2n * BigInt(start.denominator) * BigInt(time.denominator)
  );
}

/** Audio device time is the only running clock. Never accumulate frame deltas. */
export class TimelineClock {
  position = ZERO;
  playing = false;
  error = '';
  private started = 0;
  constructor(
    readonly end: RationalTime,
    private readonly now: () => number,
  ) {}
  read(): RationalTime {
    if (!this.playing) return this.position;
    const elapsed = Math.max(
      0,
      Math.round((this.now() - this.started) * 1_000_000),
    );
    try {
      return clampTime(
        addTimes(this.position, { numerator: elapsed, denominator: 1_000_000 }),
        this.end,
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.playing = false;
      return this.position;
    }
  }
  play() {
    if (this.playing) return;
    if (compareTimes(this.position, this.end) >= 0) this.position = ZERO;
    this.started = this.now();
    this.playing = compareTimes(this.position, this.end) < 0;
  }
  pause() {
    this.position = this.read();
    this.playing = false;
  }
  seek(time: RationalTime) {
    this.pause();
    this.position = clampTime(time, this.end);
    this.error = '';
  }
}

export interface TimelineDiagnostics {
  presentedFrames: number;
  droppedFrames: number;
  decoderDroppedFrames: number;
  maxAudioSkewMs: number;
  blankVisualTicks: number;
  lateFrames: number;
  waitingEvents: number;
  clockCorrections: number;
  maxMediaSkewMs: number;
  maxPresentedSkewMs: number;
  maxTickGapMs: number;
  unavailable: string[];
  activeAudio: number;
  position: RationalTime;
  playing: boolean;
  outputLatencyMs: number;
  proxyDecoders: number;
  decoders: number;
  cachedFrames: number;
  visibleLayers: number;
  paintedLayers: number;
  compositeFrames: number;
  compositeFps: number;
  maxCompositionMs: number;
  lastSeekLatencyMs: number;
  maxSeekLatencyMs: number;
}
interface Entry {
  key: string;
  clip: ResolvedTimelineClip;
  media?: HTMLVideoElement;
  image?: HTMLImageElement;
  node?: MediaElementAudioSourceNode;
  gain?: GainNode;
  disposed: boolean;
  ready: boolean;
  failed: boolean;
  playPending: boolean;
  callback: number;
  lastQuality: number;
  settleUntil: number;
  scheduledAction: number;
}

/** Chromium decodes off-thread. This adapter only evaluates, schedules and paints. */
export class TimelinePlayback {
  readonly diagnostics: TimelineDiagnostics;
  readonly clock: TimelineClock;
  private readonly evaluate;
  private readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly entries = new Map<string, Entry>();
  private readonly aspects = new Map<string, number>();
  private readonly keys = new Map<string, string>();
  private readonly runs = new Map<string, ResolvedTimelineClip[]>();
  private readonly upcoming: ResolvedTimelineClip[];
  private readonly grants = new Map<string, Promise<PreviewSource>>();
  private readonly originalGrants = new Map<string, Promise<PreviewSource>>();
  private readonly retiredGrants = new Map<
    string,
    Set<Promise<PreviewSource>>
  >();
  private disposed = false;
  private action = 0;
  private animation = 0;
  private lastTick = 0;
  private lastReport = 0;
  private starting = false;
  private frameRequests = 0;
  private readonly wantedFrames = new Set<string>();
  private readonly cachedFrames = new Map<string, HTMLImageElement>();
  private compositeFrame = '';
  private playbackSeconds = 0;
  private seekStarted: number | null = null;
  private frameGeneration = 0;
  private readonly onVisibility = () => {
    if (document.hidden) this.pause();
  };
  constructor(
    readonly project: Project,
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly report: (
      time: RationalTime,
      diagnostics: TimelineDiagnostics,
    ) => void,
    private memoryBudget = 64 * 1024 ** 2,
  ) {
    this.evaluate = createTimelineEvaluator(project);
    // Resolve lookahead through T23 too; point queries remain the source-time authority.
    const clips = resolveTimeline(project).clips;
    let previous: ResolvedTimelineClip | undefined;
    for (const clip of clips) {
      // A split with contiguous source points shares its decoder and never restarts audio.
      const continuous =
        previous &&
        previous.trackId === clip.trackId &&
        previous.assetId === clip.assetId &&
        compareTimes(previous.timelineEnd, clip.timelineStart) === 0 &&
        compareTimes(previous.sourceOut, clip.sourceIn) === 0;
      this.keys.set(
        clip.id,
        continuous ? this.keys.get(previous!.id)! : clip.id,
      );
      const key = this.keys.get(clip.id)!;
      const run = this.runs.get(key) ?? [];
      run.push(clip);
      this.runs.set(key, run);
      previous = clip;
    }
    this.upcoming = clips.sort((a, b) =>
      compareTimes(a.timelineStart, b.timelineStart),
    );
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.context.onstatechange = () => {
      if (
        !this.disposed &&
        this.clock?.playing &&
        this.context.state !== 'running'
      )
        this.pause();
    };
    this.master = this.context.createGain();
    this.master.gain.value = 0;
    // Protect the live sum; this browser compressor is not export's FFmpeg limiter.
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.05;
    this.master.connect(limiter).connect(this.context.destination);
    this.clock = new TimelineClock(
      this.evaluate(ZERO).duration,
      () => this.context.currentTime,
    );
    this.diagnostics = {
      proxyDecoders: 0,
      decoders: 0,
      cachedFrames: 0,
      visibleLayers: 0,
      paintedLayers: 0,
      compositeFrames: 0,
      compositeFps: 0,
      maxCompositionMs: 0,
      lastSeekLatencyMs: 0,
      maxSeekLatencyMs: 0,
      presentedFrames: 0,
      droppedFrames: 0,
      decoderDroppedFrames: 0,
      maxAudioSkewMs: 0,
      blankVisualTicks: 0,
      lateFrames: 0,
      waitingEvents: 0,
      clockCorrections: 0,
      maxMediaSkewMs: 0,
      maxPresentedSkewMs: 0,
      maxTickGapMs: 0,
      unavailable: [],
      activeAudio: 0,
      position: ZERO,
      playing: false,
      outputLatencyMs:
        (this.context.outputLatency ?? this.context.baseLatency) * 1000,
    };
    canvas.width = Math.min(1920, project.settings.width);
    canvas.height = Math.max(
      1,
      Math.round(
        (canvas.width * project.settings.height) / project.settings.width,
      ),
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    this.tick();
  }
  private unavailable(entry: Entry, message: string) {
    if (entry.disposed || this.disposed) return;
    entry.failed = true;
    entry.media?.pause();
    if (entry.gain) entry.gain.gain.value = 0;
    const warning = `${entry.clip.assetId}: ${message}`;
    if (!this.diagnostics.unavailable.includes(warning))
      this.diagnostics.unavailable.push(warning);
  }
  private grant(assetId: string) {
    let request = this.grants.get(assetId);
    if (!request) {
      request = window.opencut.timelinePreview({
        projectId: this.project.metadata.id,
        expectedRevision: projectRevision(this.project),
        assetId,
      });
      this.grants.set(assetId, request);
    }
    return request;
  }
  private entry(clip: ResolvedTimelineClip): Entry {
    const key = this.keys.get(clip.id)!;
    let entry = this.entries.get(key);
    if (entry) {
      entry.clip = clip;
      return entry;
    }
    entry = {
      key,
      clip,
      disposed: false,
      ready: false,
      failed: false,
      playPending: false,
      callback: 0,
      lastQuality: 0,
      settleUntil: 0,
      scheduledAction: -1,
    };
    this.entries.set(key, entry);
    const item = entry;
    void this.grant(clip.assetId)
      .then((source) => {
        if (this.disposed || item.disposed) return;
        if (source.displayAspectRatio)
          this.aspects.set(clip.assetId, source.displayAspectRatio);
        if (source.kind === 'image') {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          item.image = image;
          image.onload = () => {
            if (!item.disposed) {
              item.ready = true;
              this.aspects.set(
                clip.assetId,
                image.naturalWidth / image.naturalHeight,
              );
            }
          };
          image.onerror = () =>
            this.unavailable(item, 'Image could not be decoded.');
          image.src = source.url;
          return;
        }
        const media = document.createElement('video');
        item.media = media;
        media.dataset.timelineClip = key;
        media.dataset.proxy = String(!!source.proxy);
        media.crossOrigin = 'anonymous';
        media.preload = 'auto';
        media.playsInline = true;
        media.setAttribute('aria-hidden', 'true');
        this.host.append(media);
        const node = this.context.createMediaElementSource(media);
        const gain = this.context.createGain();
        gain.gain.value = 0;
        node.connect(gain).connect(this.master);
        item.node = node;
        item.gain = gain;
        media.addEventListener('loadedmetadata', () => {
          if (item.disposed) return;
          if (
            media.dataset.proxy !== 'true' &&
            media.videoWidth &&
            media.videoHeight
          )
            this.aspects.set(
              clip.assetId,
              media.videoWidth / media.videoHeight,
            );
          const current = this.evaluate(this.clock.read()).activeClips.find(
            (c) => this.keys.get(c.id) === key,
          );
          media.currentTime = decoderSeekTime(
            current?.sourceTime ?? item.clip.sourceIn,
          );
        });
        media.addEventListener('loadeddata', () => {
          item.ready = true;
        });
        media.addEventListener('seeked', () => {
          item.ready = true;
          item.settleUntil = performance.now() + 150;
        });
        media.addEventListener('waiting', () => {
          if (this.clock.playing) this.diagnostics.waitingEvents++;
        });
        media.addEventListener('error', () => {
          if (media.dataset.proxy === 'true' && !item.disposed) {
            media.dataset.proxy = 'false';
            item.ready = false;
            // Retry the original at the evaluator's current source time, never splice bytes from different files.
            let replacement = this.originalGrants.get(clip.assetId);
            if (!replacement) {
              replacement = window.opencut.timelinePreview({
                projectId: this.project.metadata.id,
                expectedRevision: projectRevision(this.project),
                assetId: clip.assetId,
                originalOnly: true,
              });
              this.originalGrants.set(clip.assetId, replacement);
              const previous = this.grants.get(clip.assetId);
              if (previous) {
                const retired =
                  this.retiredGrants.get(clip.assetId) ?? new Set();
                retired.add(previous);
                this.retiredGrants.set(clip.assetId, retired);
              }
              this.grants.set(clip.assetId, replacement);
            }
            void replacement
              .then((grant) => {
                // The shared grant is released by remove() after the last owner.
                if (this.disposed || item.disposed) return;
                media.src = grant.url;
                media.load();
              })
              .catch((error) => this.unavailable(item, String(error)));
          } else
            this.unavailable(
              item,
              media.error?.message || 'Unsupported or unavailable media.',
            );
        });
        const observe: VideoFrameRequestCallback = (now, metadata) => {
          if (item.disposed || this.disposed) return;
          const active = this.evaluate(this.clock.read()).visualClips.find(
            (c) => this.visible(c) && this.keys.get(c.id) === key,
          );
          if (this.clock.playing && active && !media.seeking) {
            this.diagnostics.presentedFrames++;
            if (now > metadata.expectedDisplayTime + 2)
              this.diagnostics.lateFrames++;
            if (now > item.settleUntil)
              this.diagnostics.maxPresentedSkewMs = Math.max(
                this.diagnostics.maxPresentedSkewMs,
                Math.abs(metadata.mediaTime - seconds(active.sourceTime)) *
                  1000,
              );
          }
          item.callback = media.requestVideoFrameCallback(observe);
        };
        item.callback = media.requestVideoFrameCallback(observe);
        media.src = source.url;
        media.load();
      })
      .catch((error) => this.unavailable(item, String(error)));
    return item;
  }
  private remove(entry: Entry) {
    entry.disposed = true;
    const media = entry.media;
    if (media) {
      media.pause();
      media.cancelVideoFrameCallback(entry.callback);
      media.removeAttribute('src');
      media.load();
      media.remove();
    }
    if (entry.image) {
      entry.image.onload = null;
      entry.image.onerror = null;
      entry.image.src = '';
    }
    entry.node?.disconnect();
    entry.gain?.disconnect();
    this.entries.delete(entry.key);
    if (
      ![...this.entries.values()].some(
        (e) => e.clip.assetId === entry.clip.assetId,
      )
    ) {
      const grant = this.grants.get(entry.clip.assetId);
      const retired = this.retiredGrants.get(entry.clip.assetId) ?? new Set();
      if (grant) retired.add(grant);
      this.grants.delete(entry.clip.assetId);
      this.originalGrants.delete(entry.clip.assetId);
      this.retiredGrants.delete(entry.clip.assetId);
      for (const request of retired)
        void request
          .then((source) => window.opencut.releasePreview(source.url))
          .catch(() => {});
    }
  }
  setMemoryBudget(memoryBytes: number) {
    this.memoryBudget = memoryBytes;
    this.trimFrames();
  }
  private trimFrames(reservedBytes = 0) {
    let used = [...this.cachedFrames.values()].reduce(
      (sum, image) => sum + image.naturalWidth * image.naturalHeight * 4,
      reservedBytes,
    );
    for (const [key, image] of this.cachedFrames) {
      if (used <= this.memoryBudget) break;
      used -= image.naturalWidth * image.naturalHeight * 4;
      image.src = '';
      this.cachedFrames.delete(key);
    }
  }
  private visible(clip: ResolvedTimelineClip) {
    if (clip.trackType !== 'video' || clip.visual.opacity === 0) return false;
    // The fitting box encloses contain/cover/stretch regardless of source aspect.
    const box = fittingBox(
      this.project.settings.width,
      this.project.settings.height,
      clip.visual.scale,
    );
    return visualGeometry(
      this.project.settings.width,
      this.project.settings.height,
      this.aspects.get(clip.assetId) ?? box.width / box.height,
      1,
      clip.visual,
    ).visible;
  }
  private frameKey(assetId: string, time: RationalTime) {
    return `${assetId}:${time.numerator}/${time.denominator}`;
  }
  private clearFrames() {
    for (const image of this.cachedFrames.values()) image.src = '';
    this.cachedFrames.clear();
    this.wantedFrames.clear();
  }
  private requestFrame() {
    if (this.clock.playing || this.starting || this.disposed) return;
    for (const visual of this.evaluate(this.clock.position).visualClips) {
      if (!this.visible(visual) || visual.kind === 'image') continue;
      const key = this.frameKey(visual.assetId, visual.sourceTime);
      if (this.wantedFrames.has(key)) continue;
      if (this.frameRequests >= 2) break;
      const entry = this.entries.get(this.keys.get(visual.id)!);
      // Native frames are preferred; don't launch extraction for settled decoders.
      if (
        entry?.ready &&
        entry.media &&
        !entry.media.seeking &&
        Math.abs(entry.media.currentTime - seconds(visual.sourceTime)) < 0.001
      )
        continue;
      this.wantedFrames.add(key);
      const generation = this.frameGeneration;
      this.frameRequests++;
      void window.opencut
        .timelineFrame({
          projectId: this.project.metadata.id,
          expectedRevision: projectRevision(this.project),
          assetId: visual.assetId,
          timestamp: seconds(visual.sourceTime),
        })
        .then(async (url) => {
          if (
            !url ||
            this.disposed ||
            generation !== this.frameGeneration ||
            this.clock.playing
          )
            return;
          const image = new Image();
          image.src = url;
          await image.decode();
          if (
            this.disposed ||
            generation !== this.frameGeneration ||
            this.clock.playing
          ) {
            image.src = '';
            return;
          }
          // Bound decoded PNGs too, independently of the worker's encoded-byte cache.
          const size = image.naturalWidth * image.naturalHeight * 4;
          this.trimFrames(size);
          if (size <= this.memoryBudget) {
            this.cachedFrames.set(key, image);
            this.diagnostics.cachedFrames++;
          } else image.src = '';
        })
        .catch(() => {})
        .finally(() => {
          this.frameRequests--;
          this.requestFrame();
        });
    }
  }
  private silence() {
    this.master.gain.value = 0;
    for (const entry of this.entries.values()) {
      entry.media?.pause();
      entry.playPending = false;
      if (entry.gain) entry.gain.gain.value = 0;
    }
  }
  pause() {
    this.action++;
    this.starting = false;
    this.clock.pause();
    this.silence();
    this.publish();
  }
  seek(time: RationalTime) {
    this.pause();
    this.clock.seek(time);
    this.frameGeneration++;
    this.clearFrames();
    this.seekStarted = performance.now();
    this.requestFrame();
    for (const entry of this.entries.values()) {
      const clip = this.evaluate(this.clock.position).activeClips.find(
        (c) => this.keys.get(c.id) === entry.key,
      );
      if (clip && entry.media?.readyState) {
        entry.media.currentTime = decoderSeekTime(clip.sourceTime);
        entry.ready = false;
      }
    }
    this.render();
    this.publish();
  }
  step(direction: -1 | 1) {
    const frame = frameIndex(
      this.clock.read(),
      this.project.settings.frameRate,
    );
    this.seek(
      framePosition(
        direction < 0 ? (frame > 0n ? frame - 1n : 0n) : frame + 1n,
        this.project.settings.frameRate,
      ),
    );
  }
  async toggle() {
    if (this.clock.playing || this.starting) {
      this.pause();
      return;
    }
    this.starting = true;
    this.seekStarted = null;
    this.frameGeneration++;
    this.clearFrames();
    const action = ++this.action;
    try {
      await this.context.resume();
      if (this.disposed || action !== this.action) return;
      if (compareTimes(this.clock.position, this.clock.end) >= 0)
        this.clock.seek(ZERO);
      this.render();
      // Allow initial metadata/seek to settle before starting the authoritative clock.
      const deadline = performance.now() + 8000;
      while (
        this.evaluate(this.clock.position).activeClips.some((c) => {
          const e = this.entries.get(this.keys.get(c.id)!);
          return e && !e.ready && !e.failed;
        })
      ) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        if (this.disposed || action !== this.action) return;
        if (performance.now() > deadline)
          throw new Error('Media did not become ready within 8 seconds.');
      }
      const active = this.evaluate(this.clock.position).activeClips;
      await Promise.all(
        active.map(async (clip) => {
          const entry = this.entries.get(this.keys.get(clip.id)!);
          if (!entry?.media || entry.failed) return;
          entry.media.currentTime = decoderSeekTime(clip.sourceTime);
          entry.settleUntil = performance.now() + 250;
          try {
            await entry.media.play();
          } catch (error) {
            if (action === this.action) this.unavailable(entry, String(error));
          }
        }),
      );
      if (this.disposed || action !== this.action) {
        if (!this.clock.playing) this.silence();
        return;
      }
      this.clock.play();
      this.lastTick = performance.now();
      this.master.gain.value = 1;
    } catch (error) {
      if (action === this.action && !this.disposed) {
        this.diagnostics.unavailable.push(String(error));
        this.pause();
      }
    } finally {
      if (action === this.action) this.starting = false;
    }
  }
  private publish() {
    this.diagnostics.position = this.clock.read();
    this.diagnostics.playing = this.clock.playing;
    this.report(this.diagnostics.position, {
      ...this.diagnostics,
      unavailable: [...this.diagnostics.unavailable],
    });
  }
  private render() {
    try {
      this.renderFrame();
      if (this.clock.error) throw new Error(this.clock.error);
    } catch (error) {
      this.action++;
      this.clock.playing = false;
      this.starting = false;
      this.silence();
      const warning = String(error);
      if (!this.diagnostics.unavailable.includes(warning))
        this.diagnostics.unavailable.push(warning);
      this.publish();
    }
  }
  private renderFrame() {
    const time = this.clock.read();
    const evaluation = this.evaluate(time);
    const now = performance.now();
    const started = performance.now();
    const visuals = evaluation.visualClips.filter((c) => this.visible(c));
    const visualKeys = new Set(visuals.map((c) => this.keys.get(c.id)!));
    // Transparent, silent clips have neither visual nor audio work to decode.
    const needed = evaluation.activeClips.filter(
      (c) => visualKeys.has(this.keys.get(c.id)!) || c.effectiveVolume > 0,
    );
    const active = new Map(needed.map((c) => [this.keys.get(c.id)!, c]));
    const keep = new Set(active.keys());
    // Release distant runs before creating current decoders; cap all owned decoders.
    for (const entry of this.entries.values()) {
      if (
        !keep.has(entry.key) &&
        !inPlaybackLookahead(entry.clip.timelineStart, time)
      )
        this.remove(entry);
    }
    const missing = needed.filter(
      (c) => !this.entries.has(this.keys.get(c.id)!),
    ).length;
    for (const entry of this.entries.values()) {
      if (this.entries.size + missing <= 16) break;
      if (!keep.has(entry.key)) this.remove(entry);
    }
    for (const clip of needed) {
      if (this.entries.has(this.keys.get(clip.id)!) || this.entries.size < 16)
        this.entry(clip);
      else {
        const warning = 'Preview decoder limit (16) reached.';
        if (!this.diagnostics.unavailable.includes(warning))
          this.diagnostics.unavailable.push(warning);
      }
    }
    let speculative = 0;
    let speculativeBytes = 0;
    // Chromium owns native decode buffers. Budget estimates bound speculative work, not process RSS.
    let low = 0,
      high = this.upcoming.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareTimes(this.upcoming[middle]!.timelineStart, time) <= 0)
        low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < this.upcoming.length; i++) {
      const clip = this.upcoming[i]!;
      if (
        !this.visible(clip) &&
        (clip.muted || clip.volume === 0 || clip.audioPresence === 'absent')
      )
        continue;
      if (!inPlaybackLookahead(clip.timelineStart, time)) break;
      const asset = this.project.assets.find(
        (asset) => asset.id === clip.assetId,
      );
      const bytes =
        (asset?.metadata?.width ?? 1920) *
        (asset?.metadata?.height ?? 1080) *
        4 *
        3;
      if (
        !keep.has(this.keys.get(clip.id)!) &&
        (speculative >= 4 ||
          this.entries.size >= 16 ||
          speculativeBytes + bytes > this.memoryBudget)
      )
        continue;
      keep.add(this.keys.get(clip.id)!);
      if (!active.has(this.keys.get(clip.id)!)) {
        speculative++;
        speculativeBytes += bytes;
      }
      if (!this.entries.has(this.keys.get(clip.id)!)) this.entry(clip);
    }
    this.diagnostics.activeAudio = evaluation.mixingSources.filter((c) => {
      const e = this.entries.get(this.keys.get(c.id)!);
      return e?.ready && !e.failed;
    }).length;
    for (const entry of this.entries.values()) {
      if (!keep.has(entry.key)) {
        this.remove(entry);
        continue;
      }
      const clip = active.get(entry.key);
      const media = entry.media;
      if (!clip || entry.failed) {
        media?.pause();
        if (entry.gain) entry.gain.gain.value = 0;
        continue;
      }
      if (!media || !media.readyState) continue;
      const target = seconds(clip.sourceTime);
      const error = target - media.currentTime;
      if (this.clock.playing && !media.seeking && now > entry.settleUntil) {
        this.diagnostics.maxMediaSkewMs = Math.max(
          this.diagnostics.maxMediaSkewMs,
          Math.abs(error) * 1000,
        );
        if (clip.effectiveVolume > 0)
          this.diagnostics.maxAudioSkewMs = Math.max(
            this.diagnostics.maxAudioSkewMs,
            Math.abs(error) * 1000,
          );
        if (Math.abs(error) > 0.12) {
          media.currentTime = decoderSeekTime(clip.sourceTime);
          entry.settleUntil = now + 250;
          this.diagnostics.clockCorrections++;
        } else
          media.playbackRate =
            Math.abs(error) > 0.015 ? (error > 0 ? 1.02 : 0.98) : 1;
      } else if (
        !this.clock.playing &&
        !this.starting &&
        !media.seeking &&
        Math.abs(error) > 0.001
      )
        media.currentTime = decoderSeekTime(clip.sourceTime);
      if (entry.gain) {
        const param = entry.gain.gain;
        const audioNow = this.context.currentTime;
        if (!this.clock.playing || media.seeking) {
          param.cancelScheduledValues(audioNow);
          param.setValueAtTime(0, audioNow);
          entry.scheduledAction = -1;
        } else if (entry.scheduledAction !== this.action) {
          param.cancelScheduledValues(audioNow);
          param.setValueAtTime(clip.effectiveVolume, audioNow);
          // Schedule a continuous run once. Splits never insert an end-gate gap,
          // and their individual gain/mute changes land on the same audio clock.
          const run = this.runs.get(entry.key)!;
          for (const next of run) {
            if (compareTimes(next.timelineStart, time) <= 0) continue;
            param.setValueAtTime(
              next.muted || next.audioPresence === 'absent' ? 0 : next.volume,
              audioNow +
                Math.max(0, seconds(next.timelineStart) - seconds(time)),
            );
          }
          param.setValueAtTime(
            0,
            audioNow +
              Math.max(0, seconds(run.at(-1)!.timelineEnd) - seconds(time)),
          );
          entry.scheduledAction = this.action;
        }
      }
      if (this.clock.playing && media.paused && !entry.playPending) {
        entry.playPending = true;
        entry.settleUntil = now + 250;
        // Upcoming decoders were pre-seeked; catch up to the current timeline boundary.
        if (Math.abs(error) > 0.01)
          media.currentTime = decoderSeekTime(clip.sourceTime);
        const action = this.action;
        void media
          .play()
          .catch((error) => {
            if (action === this.action) this.unavailable(entry, String(error));
          })
          .finally(() => {
            entry.playPending = false;
            if (this.disposed || entry.disposed || !this.clock.playing)
              media.pause();
          });
      }
      const quality = media.getVideoPlaybackQuality();
      const dropped = Math.max(
        0,
        quality.droppedVideoFrames - entry.lastQuality,
      );
      this.diagnostics.decoderDroppedFrames += dropped;
      if (visualKeys.has(entry.key)) this.diagnostics.droppedFrames += dropped;
      entry.lastQuality = quality.droppedVideoFrames;
    }
    this.diagnostics.decoders = this.entries.size;
    this.diagnostics.proxyDecoders = [...this.entries.values()].filter(
      (entry) => entry.media?.dataset.proxy === 'true',
    ).length;
    const ctx = this.canvas.getContext('2d')!;
    ctx.resetTransform();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = evaluation.backgroundColor;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const painted: string[] = [];
    // Geometry is resolved in project pixels before preview downsampling.
    ctx.save();
    ctx.scale(
      this.canvas.width / this.project.settings.width,
      this.canvas.height / this.project.settings.height,
    );
    for (const visual of visuals) {
      const entry = this.entries.get(this.keys.get(visual.id)!);
      const nativeReady =
        entry &&
        !entry.failed &&
        entry.ready &&
        (entry.image ||
          (entry.media &&
            !entry.media.seeking &&
            Math.abs(entry.media.currentTime - seconds(visual.sourceTime)) <
              (this.clock.playing ? 0.15 : 0.001)));
      const cached =
        !nativeReady && !this.clock.playing
          ? this.cachedFrames.get(
              this.frameKey(visual.assetId, visual.sourceTime),
            )
          : undefined;
      const drawable =
        cached ?? (nativeReady ? (entry?.image ?? entry?.media) : undefined);
      const width =
        cached?.naturalWidth ??
        entry?.image?.naturalWidth ??
        entry?.media?.videoWidth;
      const height =
        cached?.naturalHeight ??
        entry?.image?.naturalHeight ??
        entry?.media?.videoHeight;
      if (!drawable || !width || !height) continue;
      const geometry = visualGeometry(
        this.project.settings.width,
        this.project.settings.height,
        this.aspects.get(visual.assetId) ?? width / height,
        1,
        visual.visual,
      );
      if (!geometry.visible) continue;
      ctx.save();
      ctx.globalAlpha = geometry.opacity;
      ctx.beginPath();
      ctx.rect(
        geometry.x,
        geometry.y,
        geometry.layerWidth,
        geometry.layerHeight,
      );
      ctx.clip();
      ctx.drawImage(
        drawable,
        geometry.x - geometry.cropX,
        geometry.y - geometry.cropY,
        geometry.scaledWidth,
        geometry.scaledHeight,
      );
      ctx.restore();
      painted.push(visual.id);
    }
    ctx.restore();
    const visual = visuals.at(-1);
    this.canvas.dataset.clipId = visual?.id ?? '';
    this.canvas.dataset.presentedClip = painted.at(-1) ?? '';
    this.canvas.dataset.layerIds = JSON.stringify(
      visuals.map((clip) => clip.id),
    );
    this.canvas.dataset.presentedLayers = JSON.stringify(painted);
    this.canvas.dataset.visualReady = String(
      visuals.length > 0 && painted.length === visuals.length,
    );
    this.canvas.dataset.position = `${time.numerator}/${time.denominator}`;
    this.diagnostics.visibleLayers = visuals.length;
    this.diagnostics.paintedLayers = painted.length;
    this.diagnostics.maxCompositionMs = Math.max(
      this.diagnostics.maxCompositionMs,
      performance.now() - started,
    );
    if (this.clock.playing) {
      if (painted.length < visuals.length) this.diagnostics.blankVisualTicks++;
      const frame = String(frameIndex(time, this.project.settings.frameRate));
      if (frame !== this.compositeFrame && painted.length === visuals.length) {
        this.compositeFrame = frame;
        this.diagnostics.compositeFrames++;
      }
    }
    if (
      this.seekStarted !== null &&
      !this.clock.playing &&
      painted.length === visuals.length
    ) {
      this.diagnostics.lastSeekLatencyMs = performance.now() - this.seekStarted;
      this.diagnostics.maxSeekLatencyMs = Math.max(
        this.diagnostics.maxSeekLatencyMs,
        this.diagnostics.lastSeekLatencyMs,
      );
      this.seekStarted = null;
    }
    this.requestFrame();
    if (this.clock.playing && compareTimes(time, this.clock.end) >= 0)
      this.pause();
  }
  private tick = () => {
    if (this.disposed) return;
    const now = performance.now();
    if (this.clock.playing && this.lastTick) {
      this.diagnostics.maxTickGapMs = Math.max(
        this.diagnostics.maxTickGapMs,
        now - this.lastTick,
      );
      this.playbackSeconds += (now - this.lastTick) / 1000;
      this.diagnostics.compositeFps =
        this.diagnostics.compositeFrames / this.playbackSeconds;
    }
    this.lastTick = now;
    this.render();
    if (now - this.lastReport > 50) {
      this.publish();
      this.lastReport = now;
    }
    this.animation = requestAnimationFrame(this.tick);
  };
  dispose() {
    this.pause();
    this.disposed = true;
    this.frameGeneration++;
    this.clearFrames();
    cancelAnimationFrame(this.animation);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const entry of this.entries.values()) this.remove(entry);
    void this.context.close();
  }
}
