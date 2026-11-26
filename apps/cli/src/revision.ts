import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  compileCachedVideo,
  describeProjectContactTimeline,
  fileFingerprintSchema,
  fingerprintFile,
  inspectVideoRevision,
  isVideoDefinitionPath,
  matchesFingerprint,
  preflightPictureReuse,
  planPictureRevision,
  PictureRevisionTimingError,
  renderPictureRevision,
  renderCompiledVideo,
  revisionEvidenceSchema,
  revisionRenderSettings,
  reviewMarksSchema,
  reviewNotesSchema,
  reviewVideoRevisions,
  reviewSourcePicture,
  parseSubtitleTime,
  previewVideo,
} from '@opencut/core/video';
import type {
  ReviewVersion,
  RevisionRenderSettings,
} from '@opencut/core/video';
import type { RenderProgress } from '@opencut/media';
import { writeRenderProgress } from './render-progress.js';
import { parseFrameIndex } from './contact-sheet.js';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, mixOptions, type CommandOptions } from './commands.js';
import { readJsonArgument, readParams } from './json-argument.js';
import { readMixControls } from './mix-options.js';
import {
  parseProcessingControls,
  processingOptionTypes,
} from './recipe-options.js';
import {
  parseRenderControls,
  parseRenderQuality,
  renderOptionTypes,
} from './render-options.js';
import { positiveIntegerOption, UsageError } from './usage.js';
import { loadVideo, withDefinitionConsole } from './video.js';

function parseRevisionReport(report: unknown) {
  const fields =
    report && typeof report === 'object'
      ? (report as Record<string, unknown>)
      : {};
  return {
    evidence: revisionEvidenceSchema.safeParse(fields.revisionEvidence).data,
    fingerprint: fileFingerprintSchema.safeParse(fields.outputFingerprint).data,
  };
}

function reviewSize(size: string | undefined) {
  const maxDimension = positiveIntegerOption('size', size) ?? 640;
  if (maxDimension < 64 || maxDimension > 1920)
    throw new UsageError('--size must be 64–1920.');
  return maxDimension;
}

function progress(values: CommandOptions) {
  return (event: RenderProgress) => writeRenderProgress(event, values.json);
}

export async function runReview(file: string, values: CommandOptions) {
  if (values['source-comparison']) return runSourceComparison(file, values);
  if (
    [
      values.definition,
      values.timestamp,
      values.from,
      values.to,
      values['source-clip'],
      values['source-mapping'],
    ].some((value) => value !== undefined)
  )
    throw new UsageError(
      'Source comparison options require --source-comparison.',
    );
  const { against, output } = values;
  const candidateIsDefinition = isVideoDefinitionPath(file);
  if (!against || !output || !(candidateIsDefinition || /\.mp4$/i.test(file)))
    throw new UsageError(commandUsage('review'));
  const maxDimension = reviewSize(values.size);
  await withCommandCancellation(async (signal) => {
    const params = await readParams(values.params, signal);
    const baselineParams = await readParams(values['against-params'], signal);
    const {
      audioMixEdit,
      musicSelection,
      audioComparison,
      audioMixCacheDirectory,
    } = await readMixControls(values, signal);
    const musicLoudness = musicSelection?.matchLoudness
      ? 'matched'
      : 'authored';
    const marks =
      values.marks &&
      reviewMarksSchema.parse(
        await readJsonArgument('marks', values.marks, signal),
      );
    const notes =
      values.notes &&
      reviewNotesSchema.parse(
        await readJsonArgument('notes', values.notes, signal),
      );
    const processing = parseProcessingControls(values);
    const baselineIsDefinition = isVideoDefinitionPath(against);
    if (!baselineIsDefinition && !/\.mp4$/i.test(against))
      throw new UsageError(
        '--against requires a .video.ts definition or a constant-frame-rate MP4.',
      );
    if (!baselineIsDefinition && values['against-params'])
      throw new UsageError('--against-params requires a TypeScript baseline.');
    if (baselineIsDefinition && values['render-report'])
      throw new UsageError('--render-report requires an MP4 baseline.');
    if (!baselineIsDefinition && values['against-music'])
      throw new UsageError('--against-music requires a TypeScript baseline.');
    let baseline: ReviewVersion = {
      id: 'before',
      path: resolve(against),
      label: values['against-music'] ?? basename(against),
    };
    async function verifiedEvidence(
      path: string,
      reportPath: string,
      flag: string,
    ) {
      const report = await readJsonArgument(flag, reportPath, signal);
      const { evidence, fingerprint: expected } = parseRevisionReport(report);
      if (!evidence) return;
      const actual = await fingerprintFile(path, signal, 'review export', true);
      if (!expected || !matchesFingerprint(actual, expected))
        throw new UsageError(`MP4 '${path}' does not match its render report.`);
      return { evidence, identity: actual.identity };
    }
    const baselineReport = values['render-report']
      ? await verifiedEvidence(
          baseline.path,
          values['render-report'],
          'render-report',
        )
      : undefined;
    const evidence = baselineReport?.evidence;
    if (baselineReport)
      baseline = {
        ...baseline,
        timeline: baselineReport.evidence.timeline,
        exportIdentity: baselineReport.identity,
      };
    if (values['candidate-report'] && candidateIsDefinition)
      throw new UsageError('--candidate-report requires an MP4 candidate.');
    const candidateReport = values['candidate-report']
      ? await verifiedEvidence(
          resolve(file),
          values['candidate-report'],
          'candidate-report',
        )
      : undefined;
    if (
      !candidateIsDefinition &&
      (musicSelection?.candidate ||
        values['music-option']?.length ||
        audioMixEdit)
    )
      throw new UsageError(
        'Changing music or mix settings requires a TypeScript candidate.',
      );
    if (
      musicLoudness === 'matched' &&
      !baselineIsDefinition &&
      (!evidence ||
        evidence.timeline.audio.some(({ kind }) => kind === 'music'))
    )
      throw new UsageError(
        'Matched music review needs a TypeScript baseline or verified evidence that the MP4 has no music.',
      );
    const reportSettings = (evidence ?? candidateReport?.evidence)?.settings;
    const quality = parseRenderQuality(
      values.quality,
      reportSettings?.quality ?? 'quality',
    );
    const settings = {
      ...(reportSettings ?? revisionRenderSettings({ quality })),
      quality,
      ...(audioComparison && { audioComparison }),
    };
    const inspectionOutput = join(
      dirname(resolve(output)),
      '.review-' + randomUUID() + '.mp4',
    );
    async function openVersion(
      version: ReviewVersion,
      selection: string | undefined,
      before = false,
    ) {
      const compile = (forceMode: boolean) =>
        loadVideo(version.path, {
          params: before ? baselineParams : params,
          signal,
          preview: !settings.burnSubtitles,
          processing,
          quality: settings.quality,
          audioMixEdit: before ? undefined : audioMixEdit,
          musicSelection:
            selection || forceMode
              ? {
                  candidate: selection,
                  matchLoudness: musicLoudness === 'matched',
                }
              : undefined,
        });
      let video = await compile(false);
      if (
        video.project.musicComparison &&
        !selection &&
        Boolean(video.project.musicComparison.matchLoudness) !==
          (musicLoudness === 'matched')
      )
        video = await compile(true);
      if (
        musicLoudness === 'matched' &&
        !video.project.musicComparison &&
        video.project.tracks.some(({ audioRole }) => audioRole === 'music')
      )
        throw new UsageError(
          'Matched music review requires a musicComparison group in each definition with music.',
        );
      const { timeline } = await inspectVideoRevision(
        video,
        inspectionOutput,
        settings,
        signal,
      );
      return { ...version, video, timeline };
    }
    if (baselineIsDefinition)
      baseline = await openVersion(baseline, values['against-music'], true);
    const candidates = [];
    const sources = [
      { path: resolve(file), selection: musicSelection?.candidate },
      ...(values.candidate ?? []).map((path) => ({
        path: resolve(path),
        selection: undefined,
      })),
      ...(values['music-option'] ?? []).map((selection) => ({
        path: resolve(file),
        selection,
      })),
    ];
    for (const [index, { path, selection }] of sources.entries()) {
      const version = {
        id: 'after-' + (index + 1),
        path,
        label: selection ?? basename(path),
      };
      if (isVideoDefinitionPath(path))
        candidates.push(await openVersion(version, selection));
      else {
        if (!/\.mp4$/i.test(path))
          throw new UsageError(
            '--candidate requires a .video.ts definition or MP4.',
          );
        if (musicLoudness === 'matched')
          throw new UsageError(
            'Matched music review requires TypeScript candidates.',
          );
        const report = index === 0 ? candidateReport : undefined;
        candidates.push({
          ...version,
          ...(report && {
            timeline: report.evidence.timeline,
            exportIdentity: report.identity,
          }),
        });
      }
    }
    if (musicLoudness === 'matched') {
      const groups = new Set(
        [baseline, ...candidates]
          .map(({ timeline }) => timeline?.musicCandidatesKey)
          .filter(Boolean),
      );
      if (groups.size > 1)
        throw new UsageError(
          'Matched music review requires identical musicComparison candidate tracks and source settings.',
        );
    }
    const result = await reviewVideoRevisions(baseline, candidates, {
      output,
      marks: marks || undefined,
      notes: notes || undefined,
      quality,
      musicLoudness,
      maxDimension,
      signal,
      audioMixCacheDirectory,
      audioComparison: settings.audioComparison,
      burnSubtitles: settings.burnSubtitles,
      audioBitrateKbps: settings.audioBitrateKbps,
      audioChannels: settings.audioChannels,
      audioSampleRate: settings.audioSampleRate,
      onProgress: progress(values),
    });
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : 'Review saved to ' + join(result.output, 'index.html'),
    );
  });
}

async function runSourceComparison(file: string, values: CommandOptions) {
  const { definition, output, timestamp, from, to } = values;
  if (
    !/\.mp4$/i.test(file) ||
    !definition ||
    !isVideoDefinitionPath(definition) ||
    !output ||
    values.against ||
    values.marks ||
    values.notes ||
    values.candidate ||
    values['candidate-report'] ||
    values['music-option'] ||
    values['against-params'] ||
    values['against-music'] ||
    (timestamp === undefined
      ? from === undefined || to === undefined
      : from !== undefined || to !== undefined)
  )
    throw new UsageError(commandUsage('review'));
  const maxDimension = reviewSize(values.size);
  await withCommandCancellation(async (signal) => {
    const reportPath = values['render-report'];
    const report =
      reportPath &&
      (await readJsonArgument('render-report', reportPath, signal));
    const { evidence: revision, fingerprint } = parseRevisionReport(report);
    if (reportPath && (!revision || !fingerprint) && !values['source-mapping'])
      throw new UsageError(
        'Supply compatible render JSON from render --revision-evidence --json, or provide --source-mapping.',
      );
    const { audioMixEdit, musicSelection } = await readMixControls(
      values,
      signal,
    );
    const video = await loadVideo(definition, {
      params: await readParams(values.params, signal),
      processing: parseProcessingControls(values),
      signal,
      audioMixEdit,
      musicSelection,
      quality:
        revision?.settings.quality ??
        parseRenderQuality(values.quality, 'quality'),
      preview: revision?.settings.burnSubtitles === false,
    });
    const startFrame =
      timestamp !== undefined
        ? previewVideo(video).inspectFrame(parseSubtitleTime(timestamp)).frame
        : parseFrameIndex('from', from!);
    const endFrame =
      to === undefined
        ? Math.min(
            video.frameCount,
            startFrame +
              Math.max(
                1,
                Math.round(
                  video.project.settings.frameRate.numerator /
                    video.project.settings.frameRate.denominator,
                ),
              ),
          )
        : parseFrameIndex('to', to);
    let mapping:
      | {
          clipId: string;
          projectStartFrame: number;
          deliveryStartFrame: number;
        }
      | undefined;
    if (values['source-mapping']) {
      const input = await readJsonArgument(
        'source-mapping',
        values['source-mapping'],
        signal,
      );
      if (
        !input ||
        typeof input !== 'object' ||
        !('clipId' in input) ||
        typeof input.clipId !== 'string' ||
        !('projectStartFrame' in input) ||
        !('deliveryStartFrame' in input)
      )
        throw new UsageError(
          '--source-mapping needs clipId, projectStartFrame, and deliveryStartFrame.',
        );
      mapping = {
        clipId: input.clipId,
        projectStartFrame: parseFrameIndex(
          'source-mapping projectStartFrame',
          String(input.projectStartFrame),
        ),
        deliveryStartFrame: parseFrameIndex(
          'source-mapping deliveryStartFrame',
          String(input.deliveryStartFrame),
        ),
      };
    }
    const result = await reviewSourcePicture(video, file, {
      output,
      startFrame,
      endFrame,
      signal,
      maxDimension,
      mapping,
      clipId: values['source-clip'],
      shortenToClip: timestamp !== undefined,
      evidence: revision && fingerprint ? { revision, fingerprint } : undefined,
      onProgress: progress(values),
    });
    console.log(
      values.json
        ? JSON.stringify(result, null, 2)
        : 'Source comparison saved to ' + join(result.output, 'index.html'),
    );
  });
}

export async function runRemix(file: string, values: CommandOptions) {
  const {
    output,
    'picture-from': source,
    'render-report': reportPath,
  } = values;
  if (
    !source?.toLowerCase().endsWith('.mp4') ||
    !reportPath ||
    !output?.toLowerCase().endsWith('.mp4') ||
    !isVideoDefinitionPath(file)
  )
    throw new UsageError(commandUsage('remix'));
  await withCommandCancellation(async (signal) => {
    const baseline = resolve(source);
    function blocked(reason: string) {
      console.log(
        JSON.stringify(
          {
            event: 'picture-preflight',
            baseline,
            status: 'blocked',
            checks: [],
            reasons: [reason],
            affectedRanges: [],
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
    let report: unknown;
    try {
      report = await readJsonArgument('render-report', reportPath, signal);
    } catch (error) {
      signal.throwIfAborted();
      blocked(error instanceof Error ? error.message : String(error));
      return;
    }
    const { evidence } = parseRevisionReport(report);
    if (!evidence) {
      blocked(
        'The report has no compatible revision evidence. Use a saved picture version, or explicitly render the picture with render --picture-cache --revision-evidence --json.',
      );
      return;
    }
    const { audioBitrateKbps, audioSampleRate, audioChannels } =
      parseRenderControls(values);
    const {
      audioMixEdit,
      musicSelection,
      audioComparison,
      audioMixCacheDirectory,
    } = await readMixControls(values, signal);
    const settings = {
      ...evidence.settings,
      audioBitrateKbps: audioBitrateKbps ?? evidence.settings.audioBitrateKbps,
      audioSampleRate: audioSampleRate ?? evidence.settings.audioSampleRate,
      audioChannels: audioChannels ?? evidence.settings.audioChannels,
      audioComparison: audioComparison ?? evidence.settings.audioComparison,
    };
    const video = await loadVideo(file, {
      params: await readParams(values.params, signal),
      processing: parseProcessingControls(values),
      signal,
      audioMixEdit,
      musicSelection,
      quality: settings.quality,
      preview: !settings.burnSubtitles,
    });
    const candidate = await inspectVideoRevision(
      video,
      output,
      settings,
      signal,
    );
    const { pictureFrom, ...decision } = await preflightPictureReuse(
      baseline,
      evidence,
      candidate,
      signal,
    );
    const preflight = { event: 'picture-preflight', ...decision };
    if (!pictureFrom || values.preflight) {
      console.log(JSON.stringify(preflight, null, 2));
      if (!pictureFrom) process.exitCode = 1;
      return;
    }
    process.stderr.write(JSON.stringify(preflight) + '\n');
    candidate.checkInputs();
    const result = await renderCompiledVideo(video, output, {
      ...settings,
      signal,
      pictureFrom,
      audioMixCacheDirectory,
      revisionEvidence: true,
      onProgress: progress(values),
    });
    console.log(
      values.json
        ? JSON.stringify({ ...result, preflight }, null, 2)
        : 'Reused verified picture and saved the revised mix to ' + result.path,
    );
  });
}

function hasOutputEntry(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    // The command will report any destination error when it runs.
    return false;
  }
}

function fullRenderFallback(
  file: string,
  output: string,
  values: CommandOptions,
  settings?: RevisionRenderSettings,
) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  let destination = resolve(output);
  if (hasOutputEntry(destination)) {
    const ext = extname(destination);
    destination =
      destination.slice(0, -ext.length) + `-full-${randomUUID()}` + ext;
  }
  const args = [
    'opencut',
    'render',
    quote(resolve(file)),
    '--output',
    quote(destination),
  ];
  const options = {
    quality: settings?.quality,
    codec: settings?.codec,
    resolution: settings?.resolution,
    encoder: settings?.encoder,
    width: settings?.outputSize?.width,
    height: settings?.outputSize?.height,
    fps:
      settings?.outputFrameRate &&
      `${settings.outputFrameRate.numerator}/${settings.outputFrameRate.denominator}`,
    'keyframe-interval': settings?.keyframeInterval,
    'video-bitrate': settings?.videoBitrateKbps,
    'audio-bitrate': settings?.audioBitrateKbps,
    'audio-rate': settings?.audioSampleRate,
    'audio-channels': settings?.audioChannels,
    'mix-comparison': values['mix-comparison'] ?? settings?.audioComparison,
  };
  const inputOptions = [
    'params',
    ...mixOptions.filter((key) => key !== 'mix-comparison'),
    ...(Object.keys(
      processingOptionTypes,
    ) as (keyof typeof processingOptionTypes)[]),
  ] as const;
  for (const [key, value] of [
    ...Object.entries(options),
    ...inputOptions.map((key) => [key, values[key]] as const),
  ]) {
    if (value !== undefined) args.push(`--${key}=${quote(String(value))}`);
  }
  if (settings?.burnSubtitles === false) args.push('--no-subtitles');
  if (values.json || values['revision-evidence'])
    args.push('--revision-evidence', '--json');
  return args.join(' ');
}

export async function runPictureRevision(file: string, values: CommandOptions) {
  const {
    output,
    'picture-from': baseline,
    'render-report': reportPath,
  } = values;
  if (
    !baseline?.toLowerCase().endsWith('.mp4') ||
    !reportPath ||
    !output?.toLowerCase().endsWith('.mp4') ||
    !isVideoDefinitionPath(file)
  )
    throw new UsageError(commandUsage('render'));
  const incompatibleOptions = [
    ...(Object.keys(renderOptionTypes) as (keyof typeof renderOptionTypes)[]),
    'picture-cache',
    'picture-version',
  ] as const;
  if (incompatibleOptions.some((key) => values[key] !== undefined))
    throw new UsageError(
      'Picture revisions use the baseline report’s export settings and a new output path. Use a full render to change encoding settings.',
    );
  await withCommandCancellation(async (signal) => {
    let settings: RevisionRenderSettings | undefined;
    let plan:
      Awaited<ReturnType<typeof planPictureRevision>>['report'] | undefined;
    const fallback = () => fullRenderFallback(file, output, values, settings);
    try {
      const report = await readJsonArgument(
        'render-report',
        reportPath,
        signal,
      );
      const { evidence, fingerprint } = parseRevisionReport(report);
      settings = evidence?.settings;
      if (!evidence || !fingerprint)
        throw new UsageError(
          'Supply matching render JSON from render --revision-evidence --json.',
        );
      const {
        audioMixEdit,
        musicSelection,
        audioMixCacheDirectory,
        audioComparison,
      } = await readMixControls(values, signal);
      if (
        audioComparison !== undefined &&
        audioComparison !== (evidence.settings.audioComparison ?? 'after')
      )
        throw new UsageError(
          'Use a full render to switch the mix comparison setting.',
        );

      const options = {
        params: await readParams(values.params, signal),
        processing: parseProcessingControls(values),
        signal,
        audioMixEdit,
        musicSelection,
        quality: evidence.settings.quality,
        preview: !evidence.settings.burnSubtitles,
      };
      const video = values.preflight
        ? await withDefinitionConsole(() => compileCachedVideo(file, options))
        : await loadVideo(file, options);
      const preflight = await planPictureRevision(
        video,
        baseline,
        output,
        evidence,
        fingerprint,
        signal,
      );
      plan = preflight.report;
      if (values.preflight || plan.status === 'blocked') {
        const blocked = plan.status === 'blocked';
        console.log(
          JSON.stringify(
            { ...plan, ...(blocked && { fallback: fallback() }) },
            null,
            2,
          ),
        );
        if (blocked) process.exitCode = 1;
        return;
      }
      const result = await renderPictureRevision(
        video,
        output,
        evidence,
        preflight,
        {
          signal,
          onProgress: progress(values),
          audioMixCacheDirectory,
        },
      );
      console.log(
        values.json
          ? JSON.stringify(
              {
                definitionPath: video.path,
                contactTimeline: describeProjectContactTimeline(video.project),
                ...result,
              },
              null,
              2,
            )
          : 'Verified picture revision saved to ' + result.path,
      );
    } catch (error) {
      signal.throwIfAborted();
      const failedDuringRender = plan?.status === 'eligible';
      const reason = error instanceof Error ? error.message : String(error);
      const command = fallback();
      process.exitCode = 1;
      if (failedDuringRender && !values.json) {
        process.stderr.write(
          `${reason}\n\nRun a full render with\n${command}\n`,
        );
        return;
      }
      console.log(
        JSON.stringify(
          {
            baseline: resolve(baseline),
            reasons: [reason],
            fallback: command,
            ...(failedDuringRender
              ? {
                  event: 'picture-revision-failed',
                  status: 'failed',
                  preflight: plan,
                  ...(error instanceof PictureRevisionTimingError && {
                    timing: error.details,
                  }),
                }
              : {
                  event: 'picture-revision-preflight',
                  status: 'blocked',
                  checks: [],
                  pendingChecks: [],
                  changedRanges: [],
                  encodeRanges: [],
                  copyRanges: [],
                  audio: 'unavailable',
                }),
          },
          null,
          2,
        ),
      );
    }
  });
}
