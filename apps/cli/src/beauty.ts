import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  analyzeBeauty,
  beautyCapabilities,
  beautyCorrectionsSchema,
  beautyReviewSchema,
  discoverBeauty,
  evaluateBeautyRecipe,
  inspectBeautyAnalysis,
  inspectVideoRecipes,
  removeBeautyAnalysis,
  resolveBeautyReview,
  sampleBeautyAnalysis,
  validateBeautyRecipes,
  videoRecipeCacheDirectory,
} from '@opencut/core/video';
import { withCommandCancellation } from './cancellation.js';
import { commandUsage } from './commands.js';
import type { CommandOptions } from './commands.js';
import { readParams } from './json-argument.js';
import { parseProcessingControls } from './recipe-options.js';
import { UsageError } from './usage.js';
import { withDefinitionConsole } from './video.js';

type Command =
  | 'beauty capabilities'
  | 'beauty preflight'
  | 'beauty analyze'
  | 'beauty inspect'
  | 'beauty validate'
  | 'beauty remove'
  | 'beauty evaluate';

export function runBeautyCommand(
  command: Command,
  file: string,
  values: CommandOptions,
) {
  const jobId = randomUUID();
  const print = (value: object) =>
    console.log(JSON.stringify({ jobId, ...value }, null, 2));
  return withCommandCancellation(async (signal) => {
    const processing = parseProcessingControls(values);
    const directory = videoRecipeCacheDirectory(processing.cacheDirectory);
    if (command === 'beauty capabilities' || command === 'beauty preflight') {
      const runtime = await discoverBeauty(signal);
      const ok =
        command === 'beauty capabilities' || runtime.status === 'available';
      print({ ok, ...beautyCapabilities(), runtime });
      if (!ok) process.exitCode = 1;
    } else if (command === 'beauty analyze') {
      const corrections = values.edit
        ? beautyCorrectionsSchema.parse(
            JSON.parse(
              await readFile(values.edit, { encoding: 'utf8', signal }),
            ),
          )
        : [];
      const source = values['context-source'];
      const rawStart = values['context-start'];
      const start = Number(rawStart);
      if (
        (source !== undefined || rawStart !== undefined) &&
        (!source?.trim() ||
          !rawStart?.trim() ||
          !Number.isFinite(start) ||
          start < 0)
      )
        throw new UsageError(
          'Set --context-source and --context-start together. The start is the excerpt’s offset in the original recording, in seconds.',
        );
      const analysis = await analyzeBeauty(file, directory, {
        signal,
        corrections,
        ...(source !== undefined && { context: { source, start } }),
        limits: {
          maxBytes: processing.maxTemporaryBytes,
          maxMemory: processing.maxNativeBytes,
          timeoutMs: processing.timeoutMs,
        },
        onTime(seconds) {
          process.stderr.write(
            values.json
              ? JSON.stringify({
                  jobId,
                  event: 'progress',
                  stage: 'beauty-analysis',
                  seconds,
                }) + '\n'
              : 'Beauty analysis ' + seconds.toFixed(2) + 's\n',
          );
        },
      });
      print({ ok: true, status: 'completed', ...analysis });
    } else if (command === 'beauty inspect') {
      const analysis = await inspectBeautyAnalysis(directory, file, signal);
      const samples = values.output
        ? await sampleBeautyAnalysis(analysis, values.output, signal)
        : undefined;
      print({
        ok: true,
        ...analysis,
        ...(samples === undefined ? {} : { samples }),
      });
    } else if (command === 'beauty validate') {
      const params = await readParams(values.params, signal);
      const inspection = await withDefinitionConsole(() =>
        inspectVideoRecipes(file, { signal, params }),
      );
      const bindings = await validateBeautyRecipes(
        inspection.recipes,
        directory,
        signal,
      );
      print({ ok: true, definition: inspection.path, bindings });
    } else if (command === 'beauty evaluate') {
      if (
        !values.result ||
        !values.output ||
        !/^\d+$/.test(values.from ?? '') ||
        !/^\d+$/.test(values.to ?? '')
      )
        throw new UsageError(commandUsage(command));
      const range = {
        startFrame: Number(values.from),
        endFrame: Number(values.to),
      };
      const review = values.notes
        ? beautyReviewSchema.parse(
            JSON.parse(
              await readFile(values.notes, { encoding: 'utf8', signal }),
            ),
          )
        : undefined;
      const evidence = await evaluateBeautyRecipe(
        file,
        directory,
        values.result,
        values.output,
        range,
        signal,
      );
      const result = resolveBeautyReview(
        evidence,
        values.result,
        range.startFrame,
        range.endFrame,
        !!values['require-visual'],
        review,
      );
      print(result);
      if (!result.ok) process.exitCode = 1;
    } else {
      const removal = await removeBeautyAnalysis(directory, file, signal);
      print({ ok: true, removal });
    }
  }).catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        jobId,
        event: 'beauty-job-status',
        status: [130, 143].includes(Number(process.exitCode))
          ? 'cancelled'
          : 'failed',
      }) + '\n',
    );
    throw error;
  });
}
