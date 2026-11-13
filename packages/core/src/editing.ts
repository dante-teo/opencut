import { z } from 'zod';
import { transitionFrames, transitionInputSchema } from './transitions.js';
import {
  canvasShape,
  clipVisualSchema,
  colorGradeSchema,
  validateProject,
} from './project.js';
import type { HistoryEntry, Project, ProjectSnapshot } from './project.js';
import {
  audioEffectsSchema,
  clipAudioShape,
  trackAudioShape,
} from './audio.js';
import { frameTime, timeSchema } from './time.js';
import { keyframeEdits } from './keyframes.js';
import { clipSpeedSchema } from './clip-timing.js';
import { textLayerSchema } from './text-style.js';
import { editSubtitles, subtitleOperations } from './subtitles.js';
import {
  addClip,
  addText,
  addTrack,
  moveClip,
  replaceClipAsset,
  detachClipAudio,
  dissolveClips,
  addTransition,
  setTransition,
  removeTransition,
  flashClip,
  fadeClipVisual,
  insertFreeze,
  removeClip,
  removeTrack,
  splitClip,
  trimClip,
  setClipAudio,
  setClipSpeed,
  setTrackAudio,
  setClipVisual,
  setClipGrade,
  setClipGainKeys,
  setClipEffects,
  editClipKeyframe,
  setText,
  setCanvas,
} from './timeline.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const frame = z.int().nonnegative();
const clipAudioOptions = {
  ...trackAudioShape,
  fadeIn: frame.optional(),
  fadeOut: frame.optional(),
};
const name = z
  .string()
  .refine((value) => value.trim().length > 0, 'Must not be blank.');
const operationSchema = z.discriminatedUnion('type', [
  ...subtitleOperations,
  keyframeEdits.add.extend({ id }),
  keyframeEdits.set.extend({ id }),
  keyframeEdits.remove.extend({ id }),
  z.strictObject({
    type: z.literal('text.add'),
    id: id.optional(),
    trackId: id.optional(),
    at: frame,
    duration: frame.positive(),
    text: textLayerSchema,
    visual: clipVisualSchema.omit({ fit: true }).optional(),
  }),
  z.strictObject({
    type: z.literal('text.set'),
    id,
    text: textLayerSchema.partial().optional(),
    at: frame.optional(),
    duration: frame.positive().optional(),
  }),
  z.strictObject({
    type: z.literal('track.add'),
    id: id.optional(),
    name,
    mediaType: z.enum(['video', 'audio']),
  }),
  z.strictObject({ type: z.literal('track.remove'), id }),
  z.strictObject({ type: z.literal('track.audio'), id, ...trackAudioShape }),
  z.strictObject({
    type: z.literal('clip.add'),
    id: id.optional(),
    assetId: id,
    trackId: id,
    at: frame,
    in: frame,
    out: frame,
    ...clipAudioOptions,
    visual: clipVisualSchema.optional(),
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
    inTime: timeSchema.optional(),
    outTime: timeSchema.optional(),
  }),
  z.strictObject({ type: z.literal('clip.speed'), id, speed: clipSpeedSchema }),
  z.strictObject({
    type: z.literal('clip.replace'),
    id,
    assetId: id,
    sourceIn: timeSchema.optional(),
    sourceOut: timeSchema.optional(),
    ripple: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('clip.detach-audio'), id }),
  z.strictObject({
    type: z.literal('transition.add'),
    id: id.optional(),
    transition: transitionInputSchema,
  }),
  z.strictObject({
    type: z.literal('transition.set'),
    id,
    frames: transitionFrames,
  }),
  z.strictObject({ type: z.literal('transition.remove'), id }),
  z.strictObject({
    type: z.literal('clip.dissolve'),
    id,
    from: id,
    frames: frame.positive(),
  }),
  z.strictObject({
    type: z.literal('clip.flash'),
    id,
    frames: frame.positive(),
  }),
  z.strictObject({
    type: z.literal('clip.fade'),
    id,
    edge: z.enum(['in', 'out']),
    frames: frame.positive(),
  }),
  z.strictObject({
    type: z.literal('clip.freeze'),
    id,
    stillId: id,
    at: frame,
    frames: frame.positive(),
  }),
  z.strictObject({
    type: z.literal('clip.grade'),
    ids: z.array(id).min(1),
    grade: colorGradeSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('clip.effects'),
    id,
    effects: audioEffectsSchema,
  }),
  z.strictObject({
    type: z.literal('clip.gain-keys'),
    id,
    keys: clipAudioShape.gainKeys.unwrap().nullable(),
  }),
  z.strictObject({
    type: z.literal('clip.split'),
    id,
    at: frame,
    rightId: id.optional(),
  }),
  z.strictObject({ type: z.literal('clip.remove'), id }),
  z.strictObject({ type: z.literal('clip.audio'), id, ...clipAudioOptions }),
  z.strictObject({
    type: z.literal('clip.visual'),
    id,
    ...clipVisualSchema.shape,
  }),
  z.strictObject({ type: z.literal('canvas.set'), ...canvasShape }),
]);
const transactionSchema = z.strictObject({
  expectedRevision: z.int().nonnegative(),
  label: name.optional(),
  operations: z.array(operationSchema).min(1),
});
export type EditOperation = z.infer<typeof operationSchema>;
export type EditTransaction = z.infer<typeof transactionSchema>;
export function editTransactionJsonSchema() {
  return z.toJSONSchema(transactionSchema);
}

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
export function previewTransaction(project: Project, input: EditTransaction) {
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
        case 'subtitle.import':
        case 'subtitle.add':
        case 'subtitle.set':
        case 'subtitle.move':
        case 'subtitle.split':
        case 'subtitle.merge':
        case 'subtitle.remove':
        case 'subtitle.style':
        case 'subtitle.words':
        case 'subtitle.effects': {
          const edited = editSubtitles(next, operation);
          changed = { ...edited, project: checked(edited.project) };
          break;
        }
        case 'track.add':
          changed = addTrack(next, {
            ...(operation.id !== undefined ? { id: operation.id } : {}),
            name: operation.name,
            type: operation.mediaType,
          });
          break;
        case 'track.audio':
          changed = setTrackAudio(next, operation.id, operation);
          break;
        case 'track.remove':
          changed = removeTrack(next, operation.id);
          break;
        case 'clip.add':
        case 'clip.audio': {
          const { volume, muted, fadeIn, fadeOut } = operation;
          const audio = {
            volume,
            muted,
            fadeIn: fadeIn === undefined ? undefined : time(fadeIn),
            fadeOut: fadeOut === undefined ? undefined : time(fadeOut),
          };
          if (operation.type === 'clip.audio') {
            changed = setClipAudio(next, operation.id, audio);
            break;
          }
          changed = addClip(next, {
            ...(operation.id !== undefined ? { id: operation.id } : {}),
            assetId: operation.assetId,
            trackId: operation.trackId,
            timelineStart: time(operation.at),
            sourceIn: time(operation.in),
            sourceOut: time(operation.out),
            ...audio,
            visual: operation.visual,
          });
          break;
        }
        case 'text.add':
          changed = addText(next, {
            id: operation.id,
            trackId: operation.trackId,
            timelineStart: time(operation.at),
            duration: time(operation.duration),
            text: operation.text,
            visual: operation.visual,
          });
          break;
        case 'text.set':
          changed = setText(next, operation.id, {
            text: operation.text,
            timelineStart:
              operation.at === undefined ? undefined : time(operation.at),
            duration:
              operation.duration === undefined
                ? undefined
                : time(operation.duration),
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
        case 'clip.speed':
          changed = setClipSpeed(next, operation.id, operation.speed);
          break;
        case 'clip.replace':
          changed = replaceClipAsset(next, operation.id, operation);
          break;
        case 'clip.detach-audio':
          changed = detachClipAudio(next, operation.id);
          break;
        case 'transition.add':
          changed = addTransition(next, operation.transition, operation.id);
          break;
        case 'transition.set':
          changed = setTransition(next, operation.id, operation.frames);
          break;
        case 'transition.remove':
          changed = removeTransition(next, operation.id);
          break;
        case 'clip.dissolve':
          changed = dissolveClips(
            next,
            operation.from,
            operation.id,
            time(operation.frames),
          );
          break;
        case 'clip.flash':
          changed = flashClip(next, operation.id, time(operation.frames));
          break;
        case 'clip.fade':
          changed = fadeClipVisual(
            next,
            operation.id,
            operation.edge,
            time(operation.frames),
          );
          break;
        case 'clip.freeze':
          changed = insertFreeze(
            next,
            operation.id,
            operation.stillId,
            time(operation.at),
            time(operation.frames),
          );
          break;
        case 'clip.grade':
          changed = setClipGrade(
            next,
            operation.ids,
            operation.grade ?? undefined,
          );
          break;
        case 'clip.gain-keys':
          changed = setClipGainKeys(
            next,
            operation.id,
            operation.keys ?? undefined,
          );
          break;
        case 'clip.effects':
          changed = setClipEffects(next, operation.id, operation.effects);
          break;
        case 'clip.trim': {
          if (
            (operation.in !== undefined && operation.inTime !== undefined) ||
            (operation.out !== undefined && operation.outTime !== undefined)
          )
            throw new EditError(
              'INVALID_TRANSACTION',
              'Specify each trim boundary once, in frames or rational seconds.',
            );
          changed = trimClip(next, operation.id, {
            sourceIn:
              operation.inTime ??
              (operation.in === undefined ? undefined : time(operation.in)),
            sourceOut:
              operation.outTime ??
              (operation.out === undefined ? undefined : time(operation.out)),
          });
          break;
        }
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
        case 'clip.keyframe.add':
        case 'clip.keyframe.set':
        case 'clip.keyframe.remove':
          changed = editClipKeyframe(next, operation.id, operation);
          break;
        case 'clip.visual':
          changed = setClipVisual(next, operation.id, {
            crop: operation.crop,
            x: operation.x,
            y: operation.y,
            scale: operation.scale,
            opacity: operation.opacity,
            rotation: operation.rotation,
            fit: operation.fit,
          });
          break;
        case 'canvas.set':
          changed = setCanvas(next, {
            width: operation.width,
            height: operation.height,
            backgroundColor: operation.backgroundColor,
          });
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
    project: next,
    results,
  };
}

/** Commit the same validated commands used for transient previews as one history entry. */
export function executeTransaction(project: Project, input: EditTransaction) {
  const transaction = parseEditTransaction(input);
  const preview = previewTransaction(project, transaction);
  return {
    ...preview,
    project: commitEdit(
      project,
      preview.project,
      transaction.label ?? 'edit apply',
    ),
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
