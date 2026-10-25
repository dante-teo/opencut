import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  executeTransaction,
  getEditHistory,
  parseEditTransaction,
  projectRevision,
  redoEdit,
  undoEdit,
} from '@opencut/core';
import { readProjectFile, updateProjectFile } from '@opencut/core/node';
import { editOptions, UsageError } from './timeline.js';

type Options = Record<string, string | boolean | undefined>;
export const editHelp = `Usage: opencut edit apply <project-file> <batch.json> [--dry-run] [--expected-revision <n>] [--json]
       opencut edit undo <project-file> [--dry-run] [--expected-revision <n>] [--json]
       opencut edit redo <project-file> [--dry-run] [--expected-revision <n>] [--json]
       opencut edit history <project-file> [--json]

Batch JSON: { "expectedRevision": 0, "label": "Optional description", "operations": [
  { "type": "track.add", "id": "v1", "name": "Video", "mediaType": "video" }
] }
Operations: track.add/remove, clip.add/move/trim/split/remove/audio.
clip.add and clip.audio accept volume (linear 0–1, default 1) and muted (boolean, default false).
Times (at/in/out) are nonnegative safe integer PROJECT frame indices.
Use explicit IDs to reference newly added tracks/clips later in the same batch.
Each operation validates against the preceding result; any failure rolls back the batch.
A batch requires expectedRevision from edit history; a conflicting CLI revision fails.
Individual timeline and media mutations also create history transactions.
Undo/redo restore exact content, including IDs and timestamps; revisions always increase.
New edits clear redo. No-op edits retain history. Dry-run validates and previews without saving.
History persists in the project JSON; no media files are changed.
JSON errors remain text on stderr. Exit codes: 0 success, 1 data/file/conflict, 2 arguments.
See docs/CLI.md for the complete batch schema and result fields.
`;

export async function runEditCommand(
  positionals: string[],
  values: Options,
): Promise<void> {
  const [, action, projectFile, batchFile] = positionals;
  if (
    !['apply', 'undo', 'redo', 'history'].includes(action ?? '') ||
    positionals.length !== (action === 'apply' ? 4 : 3) ||
    positionals.some(
      (value) =>
        !value.trim() ||
        Array.from(value).some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new UsageError(
      'Expected edit apply <project-file> <batch.json> or edit undo|redo|history <project-file>.',
    );
  const allowed =
    action === 'history' ? ['json'] : ['json', 'dry-run', 'expected-revision'];
  for (const option of Object.keys(values))
    if (!allowed.includes(option))
      throw new UsageError(`--${option} does not apply to edit ${action}.`);
  const path = resolve(projectFile!);
  if (action === 'history') {
    const result = { path, ...getEditHistory(await readProjectFile(path)) };
    process.stdout.write(
      values.json
        ? JSON.stringify(result, null, 2) + '\n'
        : `Project: ${path}\nRevision: ${result.revision}\nUndo (oldest first): ${JSON.stringify(result.undo)}\nRedo (next last): ${JSON.stringify(result.redo)}\n`,
    );
    return;
  }
  const options = editOptions(values);
  const transaction =
    action === 'apply'
      ? parseEditTransaction(
          JSON.parse(await readFile(resolve(batchFile!), 'utf8')) as unknown,
        )
      : undefined;
  if (
    transaction &&
    options.expectedRevision !== undefined &&
    options.expectedRevision !== transaction.expectedRevision
  )
    throw new UsageError(
      '--expected-revision must match the batch expectedRevision.',
    );
  const result = await updateProjectFile(
    path,
    async (project, canonicalPath) => {
      const { project: next, ...fields } = transaction
        ? executeTransaction(project, transaction)
        : {
            project: action === 'undo' ? undoEdit(project) : redoEdit(project),
          };
      return {
        project: next,
        result: {
          path: canonicalPath,
          dryRun: options.dryRun ?? false,
          baseRevision: projectRevision(project),
          changed: projectRevision(next) !== projectRevision(project),
          ...getEditHistory(next),
          ...fields,
        },
      };
    },
    {
      ...options,
      history: 'restore',
      ...(transaction
        ? { expectedRevision: transaction.expectedRevision }
        : {}),
    },
  );
  process.stdout.write(
    values.json
      ? JSON.stringify(result, null, 2) + '\n'
      : `${result.dryRun ? 'Validated' : 'Saved'} edit ${action}: ${JSON.stringify(result)}\n`,
  );
}
