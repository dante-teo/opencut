import { resolve } from 'node:path';
import {
  addClip,
  addTrack,
  frameTime,
  listTimeline,
  moveClip,
  removeClip,
  removeTrack,
  splitClip,
  trimClip,
} from '@opencut/core';
import { readProjectFile, updateProjectFile } from '@opencut/core/node';

export class UsageError extends Error {}

type Options = Record<string, string | boolean | undefined>;

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

export const timelineHelp = `Usage: opencut timeline list <project-file> [--json]
       opencut track add <project-file> --type <video|audio> --name <name> [--json]
       opencut track remove <project-file> <track-id> [--json]
       opencut clip add <project-file> <asset-id> --track <track-id> --at <frame> --in <frame> --out <frame> [--json]
       opencut clip move <project-file> <clip-id> [--track <track-id>] [--at <frame>] [--json]
       opencut clip trim <project-file> <clip-id> [--in <frame>] [--out <frame>] [--json]
       opencut clip split <project-file> <clip-id> --at <frame> [--json]
       opencut clip remove <project-file> <clip-id> [--json]

All time arguments are nonnegative safe integer frame indices at the PROJECT frame rate,
including source in/out (not source-file frame indices). Out points are exclusive.
--at is an absolute timeline position, including for split. Move/trim need at least one change option.
Trim keeps the timeline start fixed; move preserves source in/out. No implicit ripple or snapping.
Same-track overlaps fail; touching ends and cross-track overlaps are allowed.
Remove clips explicitly before removing a populated track. Split keeps the left ID and creates a right ID.
Known source durations are enforced. Unknown durations/images require explicit ranges with no inferred bound.
Offline editing needs no media tools; stored metadata is not refreshed or decoded.
Mutations use guarded atomic updates; project-file symlinks/hard links are refused.
Errors remain text on stderr with --json. Exit codes: 0 success, 1 invalid edit/data/file, 2 invalid arguments.
`;

const optionsForCommand: Record<string, readonly string[]> = {
  'timeline list': [],
  'track add': ['type', 'name'],
  'track remove': [],
  'clip add': ['track', 'at', 'in', 'out'],
  'clip move': ['track', 'at'],
  'clip trim': ['in', 'out'],
  'clip split': ['at'],
  'clip remove': [],
};

/** Parsing and persistence only; all edit semantics live in @opencut/core. */
export async function runTimelineCommand(
  positionals: string[],
  values: Options,
): Promise<void> {
  const [group, action, projectFile, id] = positionals;
  const command = `${group} ${action}`;
  const allowed = optionsForCommand[command];
  if (
    !allowed ||
    positionals.length !==
      (['timeline list', 'track add'].includes(command) ? 3 : 4)
  )
    throw new UsageError(
      'Expected a timeline list, track add/remove or clip add/move/trim/split/remove command. Run opencut timeline --help for usage.',
    );
  for (const option of Object.keys(values)) {
    if (option !== 'json' && !allowed.includes(option))
      throw new UsageError(`--${option} does not apply to ${command}.`);
  }
  if (positionals.some((value) => !value.trim() || hasControlCharacters(value)))
    throw new UsageError(
      'Timeline arguments must be nonblank and contain no control characters.',
    );
  const required = (key: string): string => {
    const value = values[key];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      hasControlCharacters(value)
    )
      throw new UsageError(
        `${command} requires --${key} <value> with no control characters.`,
      );
    return value;
  };
  if (command === 'track add') {
    const type = required('type');
    if (type !== 'video' && type !== 'audio')
      throw new UsageError('--type must be video or audio.');
    required('name');
  }
  if (command === 'clip add') {
    for (const key of ['track', 'at', 'in', 'out']) required(key);
  }
  if (command === 'clip split') required('at');
  if (
    command === 'clip move' &&
    values.track === undefined &&
    values.at === undefined
  )
    throw new UsageError('clip move requires --track or --at (or both).');
  if (
    command === 'clip trim' &&
    values.in === undefined &&
    values.out === undefined
  )
    throw new UsageError('clip trim requires --in or --out (or both).');
  if (values.track !== undefined) required('track');
  const frames: Partial<Record<'at' | 'in' | 'out', number>> = {};
  for (const key of ['at', 'in', 'out'] as const) {
    if (values[key] === undefined) continue;
    const value = required(key);
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
      throw new UsageError(
        `--${key} requires a nonnegative safe integer project-frame index (0–9007199254740991).`,
      );
    frames[key] = number;
  }
  const path = resolve(projectFile!);
  if (command === 'timeline list') {
    const result = { path, ...listTimeline(await readProjectFile(path)) };
    const time = (value: { numerator: number; denominator: number }) =>
      `${value.numerator}/${value.denominator}s`;
    const readable = [
      `Project: ${path}`,
      `Frame rate: ${result.frameRate.numerator}/${result.frameRate.denominator}`,
      `Duration: ${time(result.duration)}`,
      ...result.tracks.flatMap((track) => [
        `Track: ${track.id} (${track.type}, ${track.name})`,
        ...track.clips.map(
          (clip) =>
            `  Clip: ${clip.id}; asset ${clip.assetId}; timeline [${time(clip.timelineStart)}, ${time(clip.timelineEnd)}); source [${time(clip.sourceIn)}, ${time(clip.sourceOut)})`,
        ),
      ]),
      '',
    ].join('\n');
    process.stdout.write(
      values.json ? JSON.stringify(result, null, 2) + '\n' : readable,
    );
    return;
  }
  const result = await updateProjectFile(
    path,
    async (project, canonicalPath) => {
      const time = (key: 'at' | 'in' | 'out') =>
        frameTime(frames[key]!, project.settings.frameRate);
      let changed;
      switch (command) {
        case 'track add':
          changed = addTrack(project, {
            type: values.type as 'video' | 'audio',
            name: values.name as string,
          });
          break;
        case 'track remove':
          changed = removeTrack(project, id!);
          break;
        case 'clip add':
          changed = addClip(project, {
            assetId: id!,
            trackId: values.track as string,
            timelineStart: time('at'),
            sourceIn: time('in'),
            sourceOut: time('out'),
          });
          break;
        case 'clip move':
          changed = moveClip(project, id!, {
            ...(values.track !== undefined
              ? { trackId: values.track as string }
              : {}),
            ...(frames.at !== undefined ? { timelineStart: time('at') } : {}),
          });
          break;
        case 'clip trim':
          changed = trimClip(project, id!, {
            ...(frames.in !== undefined ? { sourceIn: time('in') } : {}),
            ...(frames.out !== undefined ? { sourceOut: time('out') } : {}),
          });
          break;
        case 'clip split':
          changed = splitClip(project, id!, time('at'));
          break;
        case 'clip remove':
          changed = removeClip(project, id!);
          break;
        default:
          throw new UsageError('Unknown timeline operation.');
      }
      const { project: updated, ...fields } = changed;
      return { project: updated, result: { path: canonicalPath, ...fields } };
    },
  );
  process.stdout.write(
    values.json
      ? JSON.stringify(result, null, 2) + '\n'
      : `Saved ${command}: ${JSON.stringify(result)}\n`,
  );
}
