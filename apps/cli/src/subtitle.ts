import { resolve } from 'node:path';
import {
  executeTransaction,
  projectRevision,
  sortSubtitleCues,
} from '@opencut/core';
import {
  readProjectFile,
  readSubtitleFile,
  updateProjectFile,
  writeSubtitleFile,
} from '@opencut/core/node';
import { editOptions, UsageError } from './timeline.js';

export const subtitleHelp = `Usage: opencut subtitle import <project-file> <file.srt|file.vtt> [--dry-run] [--expected-revision <n>] [--json]
       opencut subtitle list <project-file> [--json]
       opencut subtitle export <project-file> --output <new.srt|new.vtt> [--json]

Import appends cues in one undo step. Use edit apply for subtitle.add/set/move/split/merge/remove/style and edit undo/redo for history.
Sidecar export writes UTF-8 text and timing. Project render burns in shared subtitle styling by default; use --no-subtitles for a clean MP4.
`;

type Options = Record<string, string | boolean | undefined>;

export async function runSubtitleCommand(
  positionals: string[],
  options: Options,
) {
  const [, action, projectFile, file] = positionals;
  const allowed = ['json'];
  if (action === 'import') allowed.push('dry-run', 'expected-revision');
  if (action === 'export') allowed.push('output');
  if (
    !projectFile?.trim() ||
    !(action === 'import'
      ? positionals.length === 4 && file?.trim()
      : positionals.length === 3 &&
        (action === 'list' ||
          (action === 'export' && typeof options.output === 'string')))
  )
    throw new UsageError(subtitleHelp.trimEnd());
  for (const option of Object.keys(options))
    if (!allowed.includes(option))
      throw new UsageError(`--${option} does not apply to subtitle ${action}.`);
  const path = resolve(projectFile);
  let result;
  if (action === 'import') {
    const { format, cues } = await readSubtitleFile(file!);
    const edit = editOptions(options);
    result = await updateProjectFile(
      path,
      async (project, canonicalPath) => {
        const changed = executeTransaction(project, {
          expectedRevision: projectRevision(project),
          label: 'Import subtitles',
          operations: [{ type: 'subtitle.import', cues }],
        });
        return {
          project: changed.project,
          result: {
            path: canonicalPath,
            format,
            cueCount: cues.length,
            revision: projectRevision(changed.project),
            dryRun: edit.dryRun ?? false,
          },
        };
      },
      { ...edit, history: 'restore' },
    );
  } else {
    const project = await readProjectFile(path);
    const cues = project.subtitles?.cues ?? [];
    result =
      action === 'export'
        ? await writeSubtitleFile(String(options.output), cues)
        : {
            path,
            style: project.subtitles?.style ?? {},
            cues: sortSubtitleCues(cues),
          };
  }
  process.stdout.write(
    JSON.stringify(result, null, options.json || action === 'list' ? 2 : 0) +
      '\n',
  );
}
