import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkProjectRevision,
  projectRevision,
  serializeProject,
  EditError,
} from '@opencut/core';
import {
  OnlineMediaLibrary,
  checkProjectMedia,
  prepareOnlineMediaAsset,
  readProjectFile,
  updateProjectFile,
} from '@opencut/core/node';
import type { OnlineMediaSearch } from '@opencut/core/node';
import { UsageError } from './timeline.js';

export const onlineHelp = `Usage: opencut online search <request.json> [--json]
       opencut online import <project-file> <request.json> --result <id|index> --directory <media-directory> [--dry-run] [--expected-revision <n>] [--json]
Search Wikimedia Commons or Openverse. Request JSON: {"provider":"commons|openverse","kind":"image|audio|video","query":"...","page":"optional"}.
Import selects a result ID or zero-based index from a fresh search, checks the project revision, and retains source attribution. The download is an external artifact.
`;

async function input(file: string): Promise<OnlineMediaSearch> {
  try {
    return JSON.parse(
      await readFile(resolve(file), 'utf8'),
    ) as OnlineMediaSearch;
  } catch (cause) {
    throw new UsageError(
      `Could not read search request: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function runOnlineCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
      result: { type: 'string' },
      directory: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'expected-revision': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, action, projectOrRequest, requestFile] = positionals;
  if (
    command !== 'online' ||
    !['search', 'import'].includes(action ?? '') ||
    positionals.length !== (action === 'search' ? 3 : 4)
  )
    throw new UsageError(onlineHelp);
  if (action === 'search' && Object.keys(values).some((key) => key !== 'json'))
    throw new UsageError('online search accepts only --json.');
  const library = new OnlineMediaLibrary();
  const query = await input(
    action === 'search' ? projectOrRequest! : requestFile!,
  );
  if (action === 'search') {
    const page = await library.search(query);
    process.stdout.write(
      values.json
        ? `${JSON.stringify(page)}\n`
        : `${JSON.stringify(page, null, 2)}\n`,
    );
    return;
  }
  const index = Number(values.result);
  if (!values.result || !values.directory?.trim())
    throw new UsageError('Specify --result <ID|index> and --directory.');
  const expected =
    values['expected-revision'] === undefined
      ? undefined
      : Number(values['expected-revision']);
  if (
    expected !== undefined &&
    (!Number.isSafeInteger(expected) || expected < 0)
  )
    throw new UsageError('--expected-revision must be a nonnegative integer.');
  const path = resolve(projectOrRequest!);
  const snapshot = await readProjectFile(path);
  checkProjectRevision(snapshot, expected);
  const baseline = serializeProject(snapshot);
  const page = await library.search(query);
  const selected = /^\d+$/.test(values.result)
    ? page.results[index]
    : page.results.find((item) => item.id === values.result);
  if (!selected || !selected.importable)
    throw new UsageError(
      'Select an importable result ID or index from online search.',
    );
  const existing = snapshot.assets.find(
    (asset) =>
      asset.name === selected.title &&
      asset.provenance?.sourceUrl === selected.sourceUrl,
  );
  const available =
    existing &&
    (await checkProjectMedia(snapshot, path)).some(
      (entry) => entry.assetId === existing.id && entry.status === 'available',
    );
  if (available) {
    const result = {
      path,
      imported: false,
      asset: existing,
      revision: projectRevision(snapshot),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const download = await library.download(
    selected.id,
    resolve(values.directory),
  );
  const dryRun = values['dry-run'] ?? false;
  let commitPrepared = false;
  try {
    const prepared = await prepareOnlineMediaAsset(snapshot, path, download);
    const asset = prepared.result.asset;
    const result = await updateProjectFile(
      path,
      async (current) => {
        if (serializeProject(current) !== baseline)
          throw new EditError(
            'REVISION_CONFLICT',
            'Project changed during the download. Inspect and retry.',
          );
        commitPrepared = true;
        return {
          project: prepared.project,
          result: {
            path,
            imported: true,
            asset,
            revision: projectRevision(current) + (dryRun ? 0 : 1),
            dryRun,
            artifact: dryRun ? null : download.path,
          },
        };
      },
      {
        expectedRevision: projectRevision(snapshot),
        dryRun,
        label: 'Import online media',
      },
    );
    if (dryRun) await download.discard();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const uncertainCommit =
      commitPrepared &&
      error instanceof Error &&
      'code' in error &&
      [
        'COMMIT_OUTCOME_UNKNOWN',
        'SESSION_DISCONNECTED',
        'SESSION_TIMEOUT',
        'SESSION_PROTOCOL',
      ].includes(String(error.code));
    if (!uncertainCommit) await download.discard();
    throw error;
  }
}
