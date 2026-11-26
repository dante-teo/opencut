import { link, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  compareAudioPackets,
  inspectPicturePackets,
  MediaError,
  PictureTimestampError,
  probeMedia,
  randomAccessFrames,
  renderVideoTimeline,
  runMediaTool,
  sameFrameRate,
  verifyDeliveryStreamTiming,
  verifyMuxedPictureTiming,
} from '@opencut/media';
import type { PicturePackets, RenderProgress } from '@opencut/media';
import { withRenderSources } from './render-sources.js';
import { inspectVideoLayout, VideoLayoutError } from './video-layout.js';
import { renderCompiledVideo } from './video-render.js';
import type { CompiledVideo } from './video-compiler.js';
import {
  compareRevisionTimelines,
  inspectVideoRevision,
  matchesRevisionPicture,
} from './video-revision.js';
import type { RevisionEvidence, RevisionTimeline } from './video-revision.js';
import {
  fingerprintFile,
  hashJson,
  matchesFingerprint,
  missing,
} from './video-integrity.js';
import type { FileFingerprint } from './video-integrity.js';
import { videoInputIdentity } from './video-input.js';

interface Range {
  startFrame: number;
  endFrame: number;
}
type Segment = Range & { action: 'encode' | 'copy' };
type TimingLocation =
  { stage: 'segment'; index: number } | { stage: 'join' | 'delivery' };

export class PictureRevisionTimingError extends MediaError {
  readonly details;

  constructor(
    stage: TimingLocation['stage'],
    frame: number,
    segment: (Segment & { index: number }) | undefined,
    cause: PictureTimestampError,
  ) {
    const range = segment
      ? `, segment ${segment.index + 1} (${segment.action}), frames [${segment.startFrame}, ${segment.endFrame})`
      : '';
    super(
      `Picture revision ${stage}${range}, frame ${frame}. ${cause.message}`,
      { cause },
    );
    this.details = { stage, frame, segment, timestamp: cause.timestamp };
  }
}

const length = ({ startFrame, endFrame }: Range) => endFrame - startFrame;
const overlaps = (a: Range, b: Range) =>
  a.startFrame < b.endFrame && b.startFrame < a.endFrame;

function merge(ranges: Range[]) {
  const result: Range[] = [];
  for (const range of ranges.sort((a, b) => a.startFrame - b.startFrame)) {
    const last = result.at(-1);
    if (last && range.startFrame <= last.endFrame)
      last.endFrame = Math.max(last.endFrame, range.endFrame);
    else
      result.push({ startFrame: range.startFrame, endFrame: range.endFrame });
  }
  return result;
}

/** Bind text dependencies to the pixels produced with the actual font fallback. */
function withRasterKeys(timeline: RevisionTimeline): RevisionTimeline {
  return {
    ...timeline,
    picture: timeline.picture.map((layer) =>
      layer.rasterKey
        ? { ...layer, key: hashJson([layer.key, layer.rasterKey]) }
        : layer,
    ),
  };
}

function streamSettings(metadata: PicturePackets['metadata']) {
  return [
    metadata.codec,
    metadata.width,
    metadata.height,
    metadata.pixelFormat,
    metadata.timeBase,
    metadata.frameRateRatio,
    metadata.colorSpace,
    metadata.colorPrimaries,
    metadata.colorTransfer,
    metadata.colorRange,
    metadata.rotation ?? 0,
    metadata.sampleAspectRatio ?? 1,
    metadata.hasHdrMetadata ?? false,
    metadata.chromaLocation,
    metadata.fieldOrder,
  ];
}

export async function planPictureRevision(
  video: CompiledVideo,
  baseline: string,
  output: string,
  evidence: RevisionEvidence,
  expected: FileFingerprint,
  signal?: AbortSignal,
) {
  const settings = evidence.settings;
  const candidate = await inspectVideoRevision(video, output, settings, signal);
  const { timeline, inspected } = candidate;
  const before = evidence.timeline;
  const reasons: string[] = [];
  const checks: { check: string; status: 'passed' | 'failed' | 'skipped' }[] =
    [];
  function check(name: string, passed: boolean | undefined, reason?: string) {
    checks.push({
      check: name,
      status: passed === undefined ? 'skipped' : passed ? 'passed' : 'failed',
    });
    if (passed === false && reason) reasons.push(reason);
  }
  // Legacy reports lack raster keys. When the full picture key differs, any
  // text range without matching raster evidence must be encoded again.
  const samePicture = before.pictureKey === timeline.pictureKey;
  const { ranges: differences } = samePicture
    ? compareRevisionTimelines(before, timeline)
    : compareRevisionTimelines(
        withRasterKeys(before),
        withRasterKeys(timeline),
      );
  const audioReuse =
    before.audioSettingsKey === timeline.audioSettingsKey &&
    !differences.some(({ affects }) => affects !== 'picture') &&
    before.frameCount === timeline.frameCount &&
    sameFrameRate(
      before.frameRate.numerator + '/' + before.frameRate.denominator,
      timeline.frameRate.numerator,
      timeline.frameRate.denominator,
    );
  const affectedRanges = differences.filter(
    ({ affects }) => affects !== 'audio',
  );
  const changed = merge([
    ...affectedRanges,
    ...(!audioReuse
      ? [...before.picture, ...timeline.picture].filter(
          ({ kind, audioDriven }) =>
            kind === 'audio-driven graphic' || audioDriven,
        )
      : []),
  ]);
  const compatible = !(
    before.pictureSettingsKey !== timeline.pictureSettingsKey ||
    evidence.width !== inspected.outputWidth ||
    evidence.height !== inspected.outputHeight ||
    before.frameCount !== timeline.frameCount ||
    evidence.frameCount !== timeline.frameCount ||
    !sameFrameRate(
      evidence.frameRate.numerator + '/' + evidence.frameRate.denominator,
      timeline.frameRate.numerator,
      timeline.frameRate.denominator,
    ) ||
    settings.outputFrameRate !== undefined
  );
  check(
    'candidate-delivery-settings',
    compatible,
    'The encoder, picture settings, duration or project-to-delivery frame grid differ.',
  );
  check(
    'picture-change-coverage',
    changed.length > 0 || samePicture,
    'Picture dependencies changed outside the ranges described by this report.',
  );

  const baselinePath = resolve(baseline);
  const fingerprint = await fingerprintFile(
    baselinePath,
    signal,
    'checking picture revision baseline',
    true,
  );
  check(
    'baseline-fingerprint',
    matchesFingerprint(fingerprint, expected),
    'The baseline MP4 fingerprint does not match the render report.',
  );
  let picture: PicturePackets | undefined;
  let access: number[] = [];
  let packetGrid: boolean | undefined;
  let randomAccess: boolean | undefined;
  if (!reasons.length) {
    packetGrid = false;
    try {
      picture = await inspectPicturePackets(baselinePath, signal);
      if (!matchesRevisionPicture(picture, evidence))
        throw new MediaError(
          'The baseline video stream or packet grid does not match the render report.',
        );
      packetGrid = true;
      randomAccess = false;
      access = await randomAccessFrames(baselinePath, picture, signal);
      randomAccess = access[0] === 0;
      if (!randomAccess)
        reasons.push(
          'The baseline lacks a provable initial random-access frame.',
        );
    } catch (error) {
      signal?.throwIfAborted();
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  check('baseline-packet-grid-and-identity', packetGrid);
  check('baseline-random-access', randomAccess);
  check(
    'baseline-unchanged',
    fingerprint.identity === videoInputIdentity(baselinePath),
    'The baseline changed during preflight.',
  );
  const segments: Segment[] = [];
  if (!reasons.length) {
    const edges = [...access, evidence.frameCount];
    for (const [i, endFrame] of edges.slice(1).entries()) {
      const range = { startFrame: edges[i]!, endFrame };
      const action = changed.some((other) => overlaps(range, other))
        ? 'encode'
        : 'copy';
      const previous = segments.at(-1);
      if (previous?.action === action) previous.endFrame = endFrame;
      else segments.push({ ...range, action });
    }
  }
  const copyRanges = segments.filter(({ action }) => action === 'copy');
  const encodeRanges = segments.filter(({ action }) => action === 'encode');
  check(
    'partial-reuse',
    segments.length ? copyRanges.length > 0 : undefined,
    'The safe coded boundaries cover the entire export. Use a full render.',
  );
  const pendingChecks: { check: string; ranges?: Segment[] }[] = [];
  if (!reasons.length) {
    if (video.layoutAssertions?.length)
      pendingChecks.push({ check: 'layout-assertions' });
    if (encodeRanges.length)
      pendingChecks.push({
        check: 'encoded-segment-timestamps-codec-and-random-access',
        ranges: encodeRanges,
      });
    pendingChecks.push(
      {
        check: 'copied-segment-timestamps-and-packet-identity',
        ranges: copyRanges,
      },
      { check: 'joined-packet-timestamps-and-identity' },
      { check: 'delivery-timestamps-audio-alignment-and-full-decode' },
    );
  }
  let reusedBytes = 0;
  if (picture) {
    const { packets, step } = picture;
    for (const { pts, size } of packets) {
      const frame = pts / step;
      if (
        copyRanges.some(
          ({ startFrame, endFrame }) => frame >= startFrame && frame < endFrame,
        )
      )
        reusedBytes += Number(size);
    }
  }
  return {
    report: {
      event: 'picture-revision-preflight',
      status: reasons.length ? ('blocked' as const) : ('eligible' as const),
      baseline: baselinePath,
      checks,
      pendingChecks,
      reasons,
      changedRanges: changed,
      affectedRanges,
      encodeRanges,
      copyRanges,
      audio: audioReuse ? ('reuse' as const) : ('render' as const),
      framesToEncode: encodeRanges.reduce(
        (frames, range) => frames + length(range),
        0,
      ),
      reusedBytes,
    },
    segments,
    picture,
    identity: fingerprint.identity,
    checkInputs: candidate.checkInputs,
    timeline,
  };
}

type Preflight = Awaited<ReturnType<typeof planPictureRevision>>;

function orderedHashes(picture: PicturePackets) {
  return [...picture.packets]
    .sort((a, b) => a.pts - b.pts)
    .map(({ data_hash }) => data_hash);
}

export async function renderPictureRevision(
  video: CompiledVideo,
  output: string,
  evidence: RevisionEvidence,
  preflight: Preflight,
  options: {
    signal?: AbortSignal | undefined;
    onProgress?: ((event: RenderProgress) => void) | undefined;
    audioMixCacheDirectory?: string | undefined;
  } = {},
) {
  const { report, picture, identity, segments } = preflight;
  if (report.status === 'blocked' || !picture)
    throw new MediaError(
      'Picture revision preflight blocked encoded packet reuse.',
    );
  const { signal, onProgress } = options;
  const path = resolve(output);
  if (
    await lstat(path).catch((error: unknown) => {
      if (!missing(error)) throw error;
    })
  )
    throw new MediaError(`Choose a new output path. '${path}' already exists.`);
  const { baseline } = report;
  const settings = evidence.settings;
  const { numerator, denominator } = evidence.frameRate;
  const seconds = (frames: number) =>
    ((frames * denominator) / numerator).toFixed(9);
  const count = evidence.frameCount;
  const videoArgs = [
    '-map',
    '0:v:0',
    '-an',
    '-c:v',
    'copy',
    '-video_track_timescale',
    String(numerator),
  ];
  const clock = performance.now();
  const scratch = await mkdtemp(
    join(dirname(path), '.opencut-picture-revision-'),
  );
  const run = (args: string[], stage: string, writesFile = true) =>
    runMediaTool(
      'ffmpeg',
      ['-v', 'error', '-nostdin', '-xerror', ...args],
      8 * 1024 * 1024,
      600_000,
      { signal, stage, writesFile },
    );
  const checkBaseline = () => {
    signal?.throwIfAborted();
    if (videoInputIdentity(baseline) !== identity)
      throw new MediaError('Baseline MP4 changed during picture revision.');
  };
  let timingLocation: TimingLocation | undefined;
  try {
    const lists: string[] = ['ffconcat version 1.0'];
    const expectedVideo: string[] = [];
    const baselineHashes = orderedHashes(picture);
    preflight.checkInputs();
    checkBaseline();
    const layout = video.layoutAssertions?.length
      ? await inspectVideoLayout(video, {
          burnSubtitles: settings.burnSubtitles,
          signal,
        })
      : undefined;
    if (layout && !layout.ok) throw new VideoLayoutError(layout);
    for (const [i, segment] of segments.entries()) {
      timingLocation = { stage: 'segment', index: i };
      const { startFrame, endFrame, action } = segment;
      const name = `part-${i}.mp4`;
      const part = join(scratch, name);
      if (action === 'copy')
        await run(
          [
            '-ss',
            seconds(startFrame),
            '-i',
            baseline,
            ...videoArgs,
            '-frames:v',
            String(length(segment)),
            part,
          ],
          'copying baseline video packets',
        );
      else
        await withRenderSources(
          video,
          signal,
          (plan) =>
            renderVideoTimeline({
              ...plan,
              ...settings,
              // Visuals keep the entire timeline, including reactive analysis.
              visualClips: plan.visualClips.filter(
                ({ subtitle }) => settings.burnSubtitles || !subtitle,
              ),
              output: part,
              range: { startFrame, endFrame },
              signal,
              ...(onProgress && { onProgress }),
            }),
          settings,
        );
      const encoded = await inspectPicturePackets(part, signal);
      if (
        encoded.frameCount !== length(segment) ||
        encoded.extradataHash !== picture.extradataHash ||
        hashJson(streamSettings(encoded.metadata)) !==
          hashJson(streamSettings(picture.metadata)) ||
        (await randomAccessFrames(part, encoded, signal))[0] !== 0
      )
        throw new MediaError(
          `Frames [${startFrame}, ${endFrame}) do not have compatible codec settings or an independent start. Use a full render.`,
        );
      const hashes = orderedHashes(encoded);
      if (
        action === 'copy' &&
        hashJson(hashes) !==
          hashJson(baselineHashes.slice(startFrame, endFrame))
      )
        throw new MediaError(
          `Packet copying changed frames [${startFrame}, ${endFrame}). Use a full render.`,
        );
      expectedVideo.push(...hashes);
      lists.push(`file '${name}'`, 'duration ' + seconds(length(segment)));
    }
    timingLocation = { stage: 'join' };
    const list = join(scratch, 'parts.ffconcat');
    await writeFile(list, lists.join('\n') + '\n', { signal });
    const joined = join(scratch, 'joined.mp4');
    await run(
      [
        '-f',
        'concat',
        '-safe',
        '1',
        '-auto_convert',
        '0',
        '-i',
        list,
        ...videoArgs,
        joined,
      ],
      'joining coded video ranges',
    );
    const joinedPicture = await inspectPicturePackets(joined, signal);
    if (joinedPicture.frameCount !== count)
      throw new MediaError(
        `Joined ranges have ${joinedPicture.frameCount} video packets. Expected ${count}.`,
      );
    const unit = `ticks (${picture.metadata.timeBase} seconds per tick)`;
    if (joinedPicture.step !== picture.step)
      throw new PictureTimestampError({
        field: 'Joined video packet duration',
        expected: picture.step,
        actual: joinedPicture.step,
        unit,
      });
    if (joinedPicture.packets[0]!.dts !== picture.packets[0]!.dts)
      throw new PictureTimestampError({
        field: 'First joined video decode timestamp (DTS)',
        expected: picture.packets[0]!.dts,
        actual: joinedPicture.packets[0]!.dts,
        unit,
      });
    if (
      joinedPicture.extradataHash !== picture.extradataHash ||
      hashJson(orderedHashes(joinedPicture)) !== hashJson(expectedVideo)
    )
      throw new MediaError(
        'Joined video failed packet identity verification. Use a full render.',
      );
    timingLocation = { stage: 'delivery' };
    const staged = join(scratch, 'delivery.mp4');
    if (report.audio === 'reuse')
      await run(
        [
          '-i',
          joined,
          '-i',
          baseline,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c',
          'copy',
          '-video_track_timescale',
          String(numerator),
          '-movflags',
          '+faststart',
          staged,
        ],
        'copying approved audio packets',
      );
    else
      await renderCompiledVideo(video, staged, {
        ...settings,
        signal,
        ...(onProgress && { onProgress }),
        audioMixCacheDirectory: options.audioMixCacheDirectory,
        pictureFrom: {
          path: joined,
          identity: videoInputIdentity(joined)!,
          packetHash: joinedPicture.packetHash,
          timingHash: joinedPicture.timingHash,
        },
      });

    const delivery = await inspectPicturePackets(staged, signal);
    verifyMuxedPictureTiming(joinedPicture, delivery);
    const metadata = await probeMedia(staged, signal);
    const durationSeconds = (count * denominator) / numerator;
    verifyDeliveryStreamTiming(metadata, durationSeconds, count);
    if (
      delivery.packetHash !== joinedPicture.packetHash ||
      metadata.audio?.codec !== 'aac' ||
      metadata.audio.sampleRate !== settings.audioSampleRate ||
      metadata.audio.channels !== settings.audioChannels
    )
      throw new MediaError(
        'Final delivery did not preserve packet timing or audio alignment.',
      );
    const audioIdentity =
      report.audio === 'reuse'
        ? await compareAudioPackets(baseline, staged, signal, {
            includeTiming: true,
          })
        : undefined;
    if (audioIdentity && !audioIdentity.passed)
      throw new MediaError(
        'The approved audio packets did not survive the mux.',
      );
    const joins = segments.slice(1).map(({ startFrame }) => startFrame);
    const joinFrames = [
      ...new Set(joins.flatMap((frame) => [frame - 1, frame])),
    ];
    const samples = await run(
      [
        '-i',
        staged,
        ...(joinFrames.length
          ? [
              '-map',
              '0:v:0',
              '-vf',
              'select=' +
                joinFrames.map((frame) => `eq(n\\,${frame})`).join('+'),
              '-fps_mode',
              'passthrough',
              '-f',
              'framemd5',
              'pipe:1',
              '-map',
              '0:a:0',
              '-f',
              'null',
              '-',
            ]
          : ['-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']),
      ],
      'decoding the complete picture revision and inspecting its joins',
      false,
    );
    const hashes = samples
      .toString('utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1)!.trim());
    if (
      hashes.length !== joinFrames.length ||
      hashes.some((hash) => !/^[a-f0-9]{32}$/.test(hash))
    )
      throw new MediaError('Could not decode every frame beside a coded join.');
    const joinSamples = joinFrames.map((frame, i) => ({
      frame,
      decodedMd5: hashes[i],
    }));
    const outputFingerprint = await fingerprintFile(staged, signal);
    preflight.checkInputs();
    checkBaseline();
    await link(staged, path);
    return {
      path,
      width: evidence.width,
      height: evidence.height,
      frameCount: delivery.frameCount,
      frameRate: evidence.frameRate,
      durationSeconds,
      revisionEvidence: {
        ...evidence,
        timeline: preflight.timeline,
        packetHash: delivery.packetHash,
        timingHash: delivery.timingHash,
      },
      ...(layout && { layout }),
      outputFingerprint: {
        bytes: outputFingerprint.bytes,
        sha256: outputFingerprint.sha256,
      },
      preflight: report,
      pictureRanges: segments.map(({ startFrame, endFrame, action }) => ({
        startFrame,
        endFrame,
        status: action === 'copy' ? ('reused' as const) : ('rendered' as const),
      })),
      verification: {
        completeDecode: true,
        joins,
        joinSamples,
        packetIdentity: true,
        audioIdentity,
      },
      seconds: (performance.now() - clock) / 1000,
    };
  } catch (error) {
    if (!(error instanceof PictureTimestampError) || !timingLocation)
      throw error;
    const { stage } = timingLocation;
    const index =
      stage === 'segment'
        ? timingLocation.index
        : segments.findIndex(
            ({ startFrame, endFrame }) =>
              error.frame >= startFrame && error.frame < endFrame,
          );
    const segment = segments[index];
    const frame =
      error.frame + (stage === 'segment' ? (segment?.startFrame ?? 0) : 0);
    throw new PictureRevisionTimingError(
      stage,
      frame,
      segment && { ...segment, index },
      error,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
