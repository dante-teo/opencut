import { z } from 'zod';
import { validateProject } from './project.js';
import type { HistoryEntry, Project, ProjectSnapshot } from './project.js';
import { frameTime } from './time.js';
import {
  addClip,
  addTrack,
  moveClip,
  removeClip,
  removeTrack,
  splitClip,
  trimClip,
} from './timeline.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const frame = z.int().nonnegative();
const name = z
  .string()
  .refine((value) => value.trim().length > 0, 'Must not be blank.');
const operationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('track.add'),
    id: id.optional(),
    name,
    mediaType: z.enum(['video', 'audio']),
  }),
  z.strictObject({ type: z.literal('track.remove'), id }),
  z.strictObject({
    type: z.literal('clip.add'),
    id: id.optional(),
    assetId: id,
    trackId: id,
    at: frame,
    in: frame,
    out: frame,
  }),
  z.strictObject({
    type: z.literal('clip.move'),
    id,
    trackId: id.optional(),
    at: frame.optional(),
  }),
  z.strictObject({
    type: z.literal('clip.trim'),
    id,
    in: frame.optional(),
    out: frame.optional(),
  }),
  z.strictObject({
    type: z.literal('clip.split'),
    id,
    at: frame,
    rightId: id.optional(),
  }),
  z.strictObject({ type: z.literal('clip.remove'), id }),
]);
const transactionSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  label: name.optional(),
  operations: z.array(operationSchema).min(1),
});
export type EditOperation = z.infer<typeof operationSchema>;
export type EditTransaction = z.infer<typeof transactionSchema>;

export class EditError extends Error {
  override name = 'EditError';
  constructor(
    public readonly code:
      | 'INVALID_TRANSACTION'
      | 'REVISION_CONFLICT'
      | 'REVISION_EXHAUSTED'
      | 'NOTHING_TO_UNDO'
      | 'NOTHING_TO_REDO'
      | 'HISTORY_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

export function parseEditTransaction(value: unknown): EditTransaction {
  const result = transactionSchema.safeParse(value);
  if (!result.success)
    throw new EditError(
      'INVALID_TRANSACTION',
      `Invalid transaction: ${result.error.message}`,
    );
  return result.data;
}

function checked(project: Project): Project {
  const result = validateProject(project);
  if (!result.success) throw result.error;
  return result.project;
}

/** History snapshots exclude history and revision, avoiding recursive or quadratic storage. */
export function projectSnapshot(project: Project): ProjectSnapshot {
  const snapshot = checked(project);
  delete snapshot.editing;
  return snapshot;
}

export function projectRevision(project: Project): number {
  return project.editing?.revision ?? 0;
}

export function checkProjectRevision(
  project: Project,
  expected?: number,
): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new EditError(
      'INVALID_TRANSACTION',
      'Expected revision must be a nonnegative safe integer.',
    );
  const actual = projectRevision(project);
  if (expected !== actual)
    throw new EditError(
      'REVISION_CONFLICT',
      `Project revision conflict: expected ${expected}, found ${actual}. Reload the project and retry.`,
    );
}

function nextRevision(project: Project): number {
  const revision = projectRevision(project);
  if (revision === Number.MAX_SAFE_INTEGER)
    throw new EditError(
      'REVISION_EXHAUSTED',
      'Project revision is exhausted; cannot commit another edit.',
    );
  return revision + 1;
}
const equal = (a: ProjectSnapshot, b: ProjectSnapshot) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Refuse to restore snapshots over externally edited content or a broken history chain. */
function checkHistory(project: Project): void {
  const undo = project.editing?.undo ?? [];
  const redo = project.editing?.redo ?? [];
  let previous: HistoryEntry | undefined;
  for (const entry of [...undo, ...redo.toReversed()]) {
    if (previous && !equal(previous.after, entry.before))
      throw new EditError(
        'HISTORY_CONFLICT',
        'Editing history is inconsistent; restore a valid project backup.',
      );
    previous = entry;
  }
  const current = projectSnapshot(project);
  if (
    (undo.length && !equal(undo.at(-1)!.after, current)) ||
    (redo.length && !equal(redo.at(-1)!.before, current))
  )
    throw new EditError(
      'HISTORY_CONFLICT',
      'Project content differs from its editing history. Reload a valid project backup before editing.',
    );
}

/** Record one already validated edit; the caller retains its original project on failure. */
export function commitEdit(
  project: Project,
  changed: Project,
  label = 'edit',
): Project {
  const before = checked(project);
  checkProjectRevision(before, projectRevision(changed));
  checkHistory(before);
  const previous = projectSnapshot(before);
  const after = projectSnapshot(changed);
  if (previous.metadata.id !== after.metadata.id)
    throw new EditError(
      'INVALID_TRANSACTION',
      'An edit cannot change project identity.',
    );
  // Intermediate operations refresh updatedAt even when their content changes cancel out.
  const unchanged = equal(previous, {
    ...after,
    metadata: { ...after.metadata, updatedAt: previous.metadata.updatedAt },
  });
  if (unchanged) return before;
  const entry: HistoryEntry = {
    id: globalThis.crypto.randomUUID(),
    label,
    committedAt: new Date().toISOString(),
    before: previous,
    after,
  };
  return checked({
    ...after,
    editing: {
      revision: nextRevision(before),
      undo: [...(before.editing?.undo ?? []), entry],
      redo: [],
    },
  });
}

/** Reuse T08 primitives, validating each operation against the evolving transaction state. */
export function executeTransaction(project: Project, input: EditTransaction) {
  const transaction = parseEditTransaction(input);
  const before = checked(project);
  checkProjectRevision(before, transaction.expectedRevision);
  let next = before;
  const results: Record<string, unknown>[] = [];
  for (const [index, operation] of transaction.operations.entries()) {
    try {
      const time = (frame: number) => frameTime(frame, next.settings.frameRate);
      let changed;
      switch (operation.type) {
        case 'track.add':
          changed = addTrack(next, {
            ...(operation.id !== undefined ? { id: operation.id } : {}),
            name: operation.name,
            type: operation.mediaType,
          });
          break;
        case 'track.remove':
          changed = removeTrack(next, operation.id);
          break;
        case 'clip.add':
          changed = addClip(next, {
            ...(operation.id !== undefined ? { id: operation.id } : {}),
            assetId: operation.assetId,
            trackId: operation.trackId,
            timelineStart: time(operation.at),
            sourceIn: time(operation.in),
            sourceOut: time(operation.out),
          });
          break;
        case 'clip.move':
          changed = moveClip(next, operation.id, {
            ...(operation.trackId !== undefined
              ? { trackId: operation.trackId }
              : {}),
            ...(operation.at !== undefined
              ? { timelineStart: time(operation.at) }
              : {}),
          });
          break;
        case 'clip.trim':
          changed = trimClip(next, operation.id, {
            ...(operation.in !== undefined
              ? { sourceIn: time(operation.in) }
              : {}),
            ...(operation.out !== undefined
              ? { sourceOut: time(operation.out) }
              : {}),
          });
          break;
        case 'clip.split':
          changed = splitClip(
            next,
            operation.id,
            time(operation.at),
            operation.rightId,
          );
          break;
        case 'clip.remove':
          changed = removeClip(next, operation.id);
          break;
      }
      const { project: updated, ...result } = changed;
      next = updated;
      results.push({ type: operation.type, ...result });
    } catch (cause) {
      throw new EditError(
        'INVALID_TRANSACTION',
        `Operation ${index + 1} (${operation.type}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return {
    project: commitEdit(before, next, transaction.label ?? 'edit apply'),
    results,
  };
}

function restore(
  project: Project,
  direction: 'undo' | 'redo',
  expectedRevision?: number,
): Project {
  const current = checked(project);
  checkProjectRevision(current, expectedRevision);
  checkHistory(current);
  const undo = current.editing?.undo ?? [];
  const redo = current.editing?.redo ?? [];
  const entry = (direction === 'undo' ? undo : redo).at(-1);
  if (!entry)
    throw new EditError(
      direction === 'undo' ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO',
      `Nothing to ${direction}.`,
    );
  return checked({
    ...(direction === 'undo' ? entry.before : entry.after),
    editing: {
      revision: nextRevision(current),
      undo: direction === 'undo' ? undo.slice(0, -1) : [...undo, entry],
      redo: direction === 'undo' ? [...redo, entry] : redo.slice(0, -1),
    },
  });
}
export const undoEdit = (
  project: Project,
  expectedRevision?: number,
): Project => restore(project, 'undo', expectedRevision);
export const redoEdit = (
  project: Project,
  expectedRevision?: number,
): Project => restore(project, 'redo', expectedRevision);

export function getEditHistory(project: Project) {
  const current = checked(project);
  checkHistory(current);
  const summary = ({ id, label, committedAt }: HistoryEntry) => ({
    id,
    label,
    committedAt,
  });
  return {
    revision: projectRevision(current),
    undo: (current.editing?.undo ?? []).map(summary),
    redo: (current.editing?.redo ?? []).map(summary),
  };
}
