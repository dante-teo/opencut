import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  MediaError,
  orientedSource,
  probeMedia,
  renderReviewClip,
  renderVideoTimeline,
  resolveSourceWindow,
  sameFrameRate,
} from '@opencut/media';
import type { RenderProgress, VisualTimelineClip } from '@opencut/media';
import type { CompiledVideo } from './video-compiler.js';
import { originalRecipeTime } from './video-recipe.js';
import type { VideoRecipeInspection } from './video-recipe.js';
import { frameTime, rationalTime, subtractTimes } from './time.js';
import type { RationalTime } from './time.js';
import { fingerprintFile, matchesFingerprint } from './video-integrity.js';
import type { FileFingerprint } from './video-integrity.js';
import { inspectVideoRevision } from './video-revision.js';
import type { RevisionEvidence } from './video-revision.js';
import { clipSpeed } from './clip-timing.js';
import { previewVideo } from './video-preview.js';
import { videoInputIdentity } from './video-input.js';

type Shot = Extract<VisualTimelineClip, { path: string }>;

const decimal = (time: RationalTime) => time.numerator / time.denominator;
const scaledTime = (time: RationalTime, scale: RationalTime) =>
  rationalTime(
    BigInt(time.numerator) * BigInt(scale.numerator),
    BigInt(time.denominator) * BigInt(scale.denominator),
  );

function geometry(
  shot: Shot,
  original: ReturnType<typeof orientedSource>,
  processed: ReturnType<typeof orientedSource>,
  recipe?: VideoRecipeInspection,
) {
  let x = 0;
  let y = 0;
  let width = original.width;
  let height = original.height;
  let scaleX = 1;
  let scaleY = 1;
  for (const { parameters, media } of recipe?.steps ?? []) {
    if (parameters.type === 'crop') {
      x += parameters.x * scaleX;
      y += parameters.y * scaleY;
      width = parameters.width * scaleX;
      height = parameters.height * scaleY;
    }
    if (media.width && media.height) {
      scaleX = width / media.width;
      scaleY = height / media.height;
    }
  }
  const window = resolveSourceWindow(processed, shot.clipId, shot.sourceWindow);
  const left = Math.round(x + window.x * scaleX);
  const top = Math.round(y + window.y * scaleY);
  const right = Math.round(x + (window.x + window.width) * scaleX);
  const bottom = Math.round(y + (window.y + window.height) * scaleY);
  const sourceWindow = resolveSourceWindow(original, shot.clipId, {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
  return {
    sourceWindow,
    // Use the processed display aspect while sampling the original pixels.
    sar:
      (window.width * processed.sar * sourceWindow.height) /
      (window.height * sourceWindow.width),
  };
}

const rows = [
  ['original.mp4', 'Original at delivery crop'],
  ['processed.mp4', 'Processed source'],
  ['delivered.mp4', 'Delivered picture'],
] as const;

export async function reviewSourcePicture(
  video: CompiledVideo,
  delivery: string,
  options: {
    output: string;
    startFrame: number;
    endFrame: number;
    clipId?: string | undefined;
    shortenToClip?: boolean | undefined;
    maxDimension: number;
    evidence?:
      { revision: RevisionEvidence; fingerprint: FileFingerprint } | undefined;
    mapping?:
      | {
          clipId: string;
          projectStartFrame: number;
          deliveryStartFrame: number;
        }
      | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((event: RenderProgress) => void) | undefined;
  },
) {
  const {
    startFrame,
    endFrame,
    maxDimension,
    signal,
    evidence,
    mapping,
    onProgress,
  } = options;
  const { frameRate } = video.project.settings;
  const output = resolve(options.output);
  const deliveryPath = resolve(delivery);
  const fingerprint = await fingerprintFile(
    deliveryPath,
    signal,
    'checking source review delivery',
    true,
  );
  const delivered = await probeMedia(deliveryPath, signal);
  const stream = delivered.video;
  if (
    !stream?.width ||
    !stream.height ||
    stream.startTimeSeconds !== 0 ||
    !sameFrameRate(
      stream.frameRateRatio,
      frameRate.numerator,
      frameRate.denominator,
    )
  )
    throw new MediaError(
      'Source comparison requires a zero-based MP4 on the project frame grid.',
    );
  let mappingReason = 'No matching revision render report was supplied.';
  let verified = false;
  let verifyInputs: (() => void) | undefined;
  if (evidence && matchesFingerprint(fingerprint, evidence.fingerprint)) {
    const candidate = await inspectVideoRevision(
      video,
      join(dirname(output), 'source-review-plan.mp4'),
      evidence.revision.settings,
      signal,
    );
    verified =
      candidate.timeline.pictureKey === evidence.revision.timeline.pictureKey;
    if (verified) verifyInputs = candidate.checkInputs;
    else
      mappingReason =
        'The supplied definition no longer matches the delivery picture in the report.';
  } else if (evidence)
    mappingReason = 'The supplied render report belongs to a different MP4.';
  if (!verified && !mapping)
    throw new MediaError(
      `${mappingReason} Supply --source-mapping with an explicit clip and frame correspondence.`,
    );
  if (mapping && options.clipId && mapping.clipId !== options.clipId)
    throw new MediaError(
      'The explicit mapping and --source-clip select different clips.',
    );
  const projectStart = mapping?.projectStartFrame ?? startFrame;
  const deliveryStart = mapping?.deliveryStartFrame ?? startFrame;
  const tools = previewVideo(video);
  const plan = await video.resolveRender();
  const layers = tools
    .inspectFrame(projectStart)
    .visualClips.filter(
      ({ kind, visible, id }) =>
        kind === 'video' &&
        visible &&
        (!(mapping?.clipId ?? options.clipId) ||
          id === (mapping?.clipId ?? options.clipId)),
    );
  const clip = layers.length === 1 ? layers[0] : undefined;
  const shot =
    clip &&
    plan.visualClips.find(({ clipId, path }) => path && clipId === clip.id);
  const maximum = shot
    ? shot.timelineStartFrame + shot.frameCount - projectStart
    : 0;
  const frames = options.shortenToClip
    ? Math.min(maximum, endFrame - startFrame)
    : endFrame - startFrame;
  const projectEnd = projectStart + frames;
  const duration = decimal(frameTime(frames, frameRate));
  if (
    frames < 1 ||
    duration > 20 ||
    projectEnd > video.frameCount ||
    stream.durationSeconds === null ||
    decimal(frameTime(deliveryStart + frames, frameRate)) >
      stream.durationSeconds + 0.000002
  )
    throw new MediaError(
      'Select a range of at most 20 seconds within both the delivery and project.',
    );
  const asset = clip?.assetId && video.definition.assets?.[clip.assetId];
  if (
    !clip ||
    !shot?.path ||
    !asset ||
    asset.kind !== 'video' ||
    projectStart < shot.timelineStartFrame ||
    projectEnd > shot.timelineStartFrame + shot.frameCount
  )
    throw new MediaError(
      'Select a range within one visible video clip. Use --source-clip when more than one clip is visible.',
    );
  const originalPath = resolve(dirname(video.path), asset.path);
  const processed = plan.sourceMetadata.get(shot.path);
  const original = await probeMedia(originalPath, signal);
  if (!original.video || !processed?.video)
    throw new MediaError(
      'Both the original and processed sources must have a video stream.',
    );
  const identity = video.sourceIdentity(originalPath);
  const processedIdentity = video.sourceIdentity(shot.path);
  const recipe = video.recipes.find(({ assetId }) => assetId === clip.assetId);
  const raw = geometry(
    shot,
    orientedSource(original.video),
    orientedSource(processed.video),
    recipe,
  );
  const originalIn = originalRecipeTime(clip.sourceIn, recipe);
  const originalOut = originalRecipeTime(clip.sourceOut, recipe);
  const sourceDuration = subtractTimes(originalOut, originalIn);
  const timelineDuration = subtractTimes(clip.timelineEnd, clip.timelineStart);
  const speed = rationalTime(
    BigInt(sourceDuration.numerator) * BigInt(timelineDuration.denominator),
    BigInt(sourceDuration.denominator) * BigInt(timelineDuration.numerator),
  );
  const timingChanged =
    originalIn.numerator * clip.sourceIn.denominator !==
      clip.sourceIn.numerator * originalIn.denominator ||
    speed.numerator * clipSpeed(clip).denominator !==
      clipSpeed(clip).numerator * speed.denominator;
  const ns = (time: RationalTime) => Math.trunc(decimal(time) * 1e9);
  const sourceOrigin =
    ns(originalIn) - ns(scaledTime(clip.timelineStart, speed));
  const adjustedSar =
    Math.abs(original.video.rotation ?? 0) % 180 === 90 ? 1 / raw.sar : raw.sar;
  const unprocessed: Shot = {
    ...shot,
    path: originalPath,
    sourceWindow: raw.sourceWindow,
    ...(timingChanged && {
      sourceStartFrame: 0,
      retiming: {
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineEnd,
        sourceIn: originalIn,
        sourceOut: originalOut,
        speed,
        sourceOriginNs: sourceOrigin,
        localSourceOriginNs:
          sourceOrigin +
          ns(scaledTime(frameTime(shot.timelineStartFrame, frameRate), speed)),
      },
    }),
  };
  const check = () => {
    signal?.throwIfAborted();
    verifyInputs?.();
    if (
      !identity ||
      videoInputIdentity(originalPath) !== identity ||
      !processedIdentity ||
      videoInputIdentity(shot.path!) !== processedIdentity ||
      videoInputIdentity(deliveryPath) !== fingerprint.identity
    )
      throw new MediaError(
        'A source or the delivery changed during review. Rerun the comparison.',
      );
  };
  check();
  const stage = await mkdtemp(join(dirname(output), '.opencut-source-review-'));
  let reserved = false;
  try {
    const scratch = join(stage, 'scratch');
    await mkdir(scratch);
    async function renderShot(
      layer: Shot,
      metadata: typeof original,
      file: string,
    ) {
      return renderVideoTimeline({
        width: plan.width,
        height: plan.height,
        frameRate,
        frameCount: plan.frameCount,
        backgroundColor: plan.backgroundColor,
        visualClips: [layer],
        sourceMetadata: new Map([[metadata.path, metadata]]),
        boundSourceIdentity: video.sourceIdentity,
        output: file,
        maxDimension,
        quality: 'fast',
        range: { startFrame: projectStart, endFrame: projectEnd },
        signal,
        ...(onProgress && { onProgress }),
      });
    }
    const rawPath = join(scratch, 'original.mp4');
    const processedPath = join(scratch, 'processed.mp4');
    const preview = await renderShot(
      unprocessed,
      {
        ...original,
        video: { ...original.video, sampleAspectRatio: adjustedSar },
      },
      rawPath,
    );
    await renderShot(shot, processed, processedPath);
    for (const [i, [file, label]] of rows.entries()) {
      const folder = join(scratch, String(i));
      await mkdir(folder);
      await renderReviewClip({
        source: [rawPath, processedPath, deliveryPath][i]!,
        output: join(folder, file),
        startSeconds:
          i === 2 ? decimal(frameTime(deliveryStart, frameRate)) : 0,
        sourceFrame: i === 2 ? deliveryStart : projectStart,
        duration,
        frameCount: frames,
        frameRate,
        width: preview.width,
        height: preview.height,
        label,
        signal,
        onProgress,
      });
      await rename(join(folder, file), join(stage, file));
    }
    await rm(scratch, { recursive: true });
    const result = {
      version: 1,
      output,
      delivery: deliveryPath,
      definition: video.path,
      mapping: mapping
        ? {
            status: 'unverified',
            reason: 'Editor-supplied mapping.',
            ...mapping,
          }
        : {
            status: 'verified',
            clipId: clip.id,
            projectStartFrame: projectStart,
            deliveryStartFrame: deliveryStart,
          },
      frameCount: frames,
      frameRate,
      assetId: clip.assetId,
      sourceTime: {
        original: originalRecipeTime(clip.sourceTime, recipe),
        processed: clip.sourceTime,
      },
      framing: { originalSourceWindow: raw.sourceWindow, visual: clip.visual },
      sources: { original, processed, delivered },
      panels: rows.map(([file, label]) => ({ file, label })),
    };
    await writeFile(
      join(stage, 'index.json'),
      JSON.stringify(result, null, 2) + '\n',
      { signal },
    );
    await writeFile(
      join(stage, 'index.html'),
      `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCut source comparison</title>
<style>body{font:1rem system-ui;background:#161616;color:white;margin:24px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}figure{margin:0}video{width:100%;max-height:75vh;background:black}button{margin-bottom:16px}</style>
<button type="button">Play or pause all</button>
<main>${rows.map(([file, label]) => `<figure><video controls playsinline preload="metadata" src="${file}" ${file === 'delivered.mp4' ? '' : 'muted'}></video><figcaption>${label}</figcaption></figure>`).join('')}</main>
<script>
const videos = [...document.querySelectorAll('video')];
videos.forEach(video => video.addEventListener('seeking', () => {
  videos.forEach(other => {
    if (Math.abs(other.currentTime - video.currentTime) > 0.02)
      other.currentTime = video.currentTime;
  });
}));
document.querySelector('button').onclick = () => {
  if (videos.some(video => !video.paused)) videos.forEach(video => video.pause());
  else {
    const lead = videos.at(-1);
    const start = lead.ended ? 0 : lead.currentTime;
    videos.forEach(video => { video.currentTime = start; void video.play(); });
  }
};
</script></html>`,
      { signal },
    );
    check();
    await mkdir(output);
    reserved = true;
    signal?.throwIfAborted();
    await rename(stage, output);
    reserved = false;
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (reserved) await rmdir(output);
  }
}
