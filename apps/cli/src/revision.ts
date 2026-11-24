import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  fileFingerprintSchema,
  fingerprintFile,
  inspectVideoRevision,
  isVideoDefinitionPath,
  matchesFingerprint,
  preflightPictureReuse,
  renderCompiledVideo,
  revisionEvidenceSchema,
  revisionRenderSettings,
  reviewMarksSchema,
  reviewNotesSchema,
  reviewVideoRevisions,
} from '@opencut/core/video';
import type { ReviewVersion } from '@opencut/core/video';
import type { RenderProgress } from '@opencut/media';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage, type CommandOptions } from './commands.js';
import { readJsonArgument, readParams } from './json-argument.js';
import { readMixControls } from './mix-options.js';
import { parseProcessingControls } from './recipe-options.js';
import { parseRenderControls, parseRenderQuality } from './render-options.js';
import { positiveIntegerOption, UsageError } from './usage.js';
import { loadVideo } from './video.js';

function evidenceFrom(report: unknown) {
  return revisionEvidenceSchema.safeParse(
    report &&
      typeof report === 'object' &&
      'revisionEvidence' in report &&
      report.revisionEvidence,
  ).data;
}

function progress(values: CommandOptions) {
  return (event: RenderProgress) => {
    if (values.json) process.stderr.write(JSON.stringify(event) + '\n');
  };
}

export async function runReview(file: string, values: CommandOptions) {
  const { against, output } = values;
  const candidateIsDefinition = isVideoDefinitionPath(file);
  if (!against || !output || !(candidateIsDefinition || /\.mp4$/i.test(file)))
    throw new UsageError(commandUsage('review'));
  const maxDimension = positiveIntegerOption('size', values.size) ?? 640;
  if (maxDimension < 64 || maxDimension > 1920)
    throw new UsageError('--size must be 64–1920.');
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
      const evidence = evidenceFrom(report);
      const expected = fileFingerprintSchema.safeParse(
        report &&
          typeof report === 'object' &&
          'outputFingerprint' in report &&
          report.outputFingerprint,
      ).data;
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
    const evidence = evidenceFrom(report);
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
