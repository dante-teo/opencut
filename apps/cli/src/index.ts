#!/usr/bin/env node
import { parseCommandLine, printHelp, resolveCommand } from './commands.js';
import type { CommandOptions } from './commands.js';
import { UsageError } from './usage.js';
import { findSourceChange, sourceIdentity } from '@opencut/media';

async function run(args: string[]) {
  const { values, positionals } = parseCommandLine(args);
  const { help, version, json } = values;
  if (positionals[0] === 'help') return printHelp(positionals.slice(1), json);
  if (help || !args.length) return printHelp(positionals, json);
  if (version) {
    if (
      positionals.length ||
      Object.keys(values).some((key) => key !== 'version' && key !== 'json')
    )
      throw new UsageError('--version takes no operands.');
    const { getApplicationInfo } = await import('@opencut/core');
    const info = getApplicationInfo();
    return console.log(json ? JSON.stringify(info) : info.version);
  }

  const { command, file } = resolveCommand(positionals, values);
  try {
    return await executeCommand(command, file, values);
  } catch (error) {
    const source = findSourceChange(error);
    if (
      !values['retry-source-change'] ||
      source?.change.content !== 'unchanged' ||
      sourceIdentity(source.change.path) !== source.change.after
    )
      throw error;
    process.stderr.write(
      json
        ? JSON.stringify({
            event: 'source-change-retry',
            attempt: 2,
            sourceChange: source.change,
          }) + '\n'
        : `Retrying after verifying unchanged bytes in '${source.change.path}'.\n`,
    );
    return executeCommand(command, file, values);
  }
}

async function executeCommand(
  command: ReturnType<typeof resolveCommand>['command'],
  file: string,
  values: CommandOptions,
) {
  const { json } = values;
  switch (command) {
    case 'convert': {
      const { runConvert } = await import('./convert.js');
      return runConvert(file, json);
    }
    case 'package':
    case 'package verify':
    case 'build inspect': {
      const { runBuildCommand } = await import('./video-build.js');
      return runBuildCommand(command, file, values);
    }
    case 'inspect dependencies': {
      const { runDependencies } = await import('./dependencies.js');
      return runDependencies(file, values);
    }
    case 'recipes inspect':
    case 'recipes validate':
    case 'validate':
    case 'inspect':
    case 'mix analyze':
    case 'render plan':
    case 'render': {
      const { runVideoCommand } = await import('./video.js');
      return runVideoCommand(command, file, values);
    }
    case 'batch': {
      const { runBatch } = await import('./video-batch.js');
      return runBatch(file, values);
    }
    case 'review':
    case 'remix': {
      const { runReview, runRemix } = await import('./revision.js');
      return (command === 'review' ? runReview : runRemix)(file, values);
    }
    case 'timeline patch': {
      const { runTimelinePatch } = await import('./timeline-patch.js');
      return runTimelinePatch(file, values);
    }
    case 'timeline edit-graphic': {
      const { runMotionEdit } = await import('./motion-edit.js');
      return runMotionEdit(file, values);
    }
    case 'preview':
    case 'timeline inspect':
    case 'preview frame':
    case 'preview clip': {
      const { runInspectionCommand } = await import('./inspection.js');
      return runInspectionCommand(command, file, values);
    }
    case 'preview contact-sheet': {
      const { runContactSheet } = await import('./contact-sheet.js');
      return runContactSheet(file, values);
    }
    case 'verify export': {
      const { runExportVerification } =
        await import('./export-verification.js');
      return runExportVerification(file, values);
    }
    case 'probe':
    case 'extract-frame':
    case 'separate-dialogue':
    case 'subtitles export':
    case 'online search':
    case 'online download': {
      const { runDefinitionTool } = await import('./definition-tools.js');
      return runDefinitionTool(command, file, values);
    }
    case 'doctor': {
      const { doctor, formatDoctor } = await import('./doctor.js');
      const result = await doctor();
      return console.log(json ? JSON.stringify(result) : formatDoctor(result));
    }
    case 'models inspect':
    case 'models install':
    case 'models remove': {
      if (file && file !== 'bandit-v2')
        throw new UsageError("Choose the model 'bandit-v2'.");
      const {
        inspectDialogueModel,
        installDialogueModel,
        removeDialogueModel,
      } = await import('@opencut/media');
      if (command === 'models install') {
        const { withCommandCancellation } = await import('./cancellation.js');
        await withCommandCancellation(installDialogueModel);
      }
      if (command === 'models remove') await removeDialogueModel();
      const result = await inspectDialogueModel();
      return console.log(
        json
          ? JSON.stringify(result)
          : 'Bandit v2 multilingual: ' +
              result.model.status +
              ' (ELUATE runtime: ' +
              result.backend.status +
              ')',
      );
    }
    case 'system inspect': {
      const { inspectSystem, formatSystem } = await import('./system.js');
      const result = await inspectSystem();
      return console.log(json ? JSON.stringify(result) : formatSystem(result));
    }
  }
}

const args = process.argv.slice(2);
try {
  await run(args);
} catch (error) {
  const source = findSourceChange(error);
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  const usage =
    error instanceof UsageError || code.startsWith('ERR_PARSE_ARGS_');
  const errorCode = usage
    ? 'INVALID_ARGUMENTS'
    : source?.code ||
      code ||
      (/Required executable|Install ELUATE/.test(message)
        ? 'MISSING_DEPENDENCY'
        : error instanceof Error && error.name === 'MediaError'
          ? 'PROCESSING_FAILED'
          : 'COMMAND_FAILED');
  const separator = args.indexOf('--');
  const json = (separator === -1 ? args : args.slice(0, separator)).includes(
    '--json',
  );
  process.stderr.write(
    json
      ? JSON.stringify({
          ok: false,
          ...(code === 'LAYOUT_ASSERTION_FAILED' &&
            error instanceof Error &&
            'layout' in error && { layout: error.layout }),
          error: {
            code: errorCode,
            message,
            ...(source && {
              sourceChange: source.change,
              recovery: {
                retry:
                  source.change.content === 'unchanged'
                    ? 'fresh-attempt'
                    : 'after-input-stabilizes',
                ...(source.change.stage.startsWith('MP4')
                  ? {}
                  : {
                      checkRecipeCache: 'build inspect',
                      checkPictureCache: 'render plan',
                    }),
              },
            }),
            ...(usage && { hint: 'Run opencut --help for usage.' }),
          },
        }) + '\n'
      : `opencut: ${message}\n`,
  );
  if (usage && !json) process.stderr.write('Run opencut --help for usage.\n');
  process.exitCode ??= usage ? 2 : 1;
}
