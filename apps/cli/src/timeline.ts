import { canvasColorPattern } from '@opencut/shared';
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
  setClipAudio,
  setTrackAudio,
  setClipVisual,
  setCanvas,
} from '@opencut/core';
import type {
  ClipAudioOptions,
  ClipVisualOptions,
  TrackAudioOptions,
} from '@opencut/core';
import { readProjectFile, updateProjectFile } from '@opencut/core/node';

export class UsageError extends Error {}

type Options = Record<string, string | boolean | undefined>;

/** Shared mutation flags; omitted revision means operate on the locked current revision. */
export function editOptions(values: Options): {
  dryRun?: boolean;
  expectedRevision?: number;
} {
  const value = values['expected-revision'];
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)))
  )
    throw new UsageError(
      '--expected-revision requires a nonnegative safe integer.',
    );
  return {
    ...(values['dry-run'] === true ? { dryRun: true } : {}),
    ...(value !== undefined ? { expectedRevision: Number(value) } : {}),
  };
}

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => character.charCodeAt(0) < 32);

export const timelineHelp = `Usage: opencut timeline list <project-file> [--json]
       opencut track add <project-file> --type <video|audio> --name <name> [--json]
       opencut track audio <project-file> <track-id> [--volume <0..1>] [--muted <true|false>] [--json]
       opencut track remove <project-file> <track-id> [--json]
       opencut clip add <project-file> <asset-id> --track <track-id> --at <frame> --in <frame> --out <frame> [--json]
       opencut clip move <project-file> <clip-id> [--track <track-id>] [--at <frame>] [--json]
       opencut clip trim <project-file> <clip-id> [--in <frame>] [--out <frame>] [--json]
       opencut canvas set <project-file> [--width <px>] [--height <px>] [--background-color <#RRGGBB|#RRGGBBAA|transparent>] [--json]
       opencut clip visual <project-file> <clip-id> [--x <px>] [--y <px>] [--scale <n>] [--opacity <0..1>] [--fit <contain|cover|stretch>] [--json]
       opencut clip audio <project-file> <clip-id> [--volume <0..1>] [--muted <true|false>] [--fade-in <frames>] [--fade-out <frames>] [--json]
       opencut clip split <project-file> <clip-id> --at <frame> [--json]
       opencut clip remove <project-file> <clip-id> [--json]

All time arguments are nonnegative safe integer frame indices at the PROJECT frame rate,
including source in/out (not source-file frame indices). Out points are exclusive.
--at is an absolute timeline position, including for split. Move/trim need at least one change option.
Trim keeps the timeline start fixed; move preserves source in/out. No implicit ripple or snapping.
Same-track overlaps fail; touching ends and cross-track overlaps are allowed.
Remove clips explicitly before removing a populated track. Split keeps the left ID and creates a right ID.
Later video tracks draw above earlier tracks; new tracks append on top.
Visual defaults: x/y 0 (pixel offsets from centered fitted rectangle), scale 1, opacity 1, fit contain.
Scale multiplies the canvas fitting rectangle (0.01–4); contain preserves aspect, cover crops centrally, stretch fills.
Clip add accepts the same visual flags. Use --x=-20 or --y=-20 for negative offsets.
Canvas defaults to black; color uses #RRGGBB, #RRGGBBAA or transparent. Gaps and transparent margins reveal lower layers/background.
Clip add accepts the same audio flags. Fade durations are project frames; 0 removes a fade.
Clip and track linear gains multiply (0 = silence, 1 = unchanged). Either mute silences the clip.
Known source durations are enforced. Unknown durations/images require explicit ranges with no inferred bound.
Offline editing needs no media tools; stored metadata is not refreshed or decoded.
Mutations create undo/redo history; --dry-run previews; --expected-revision <n> guards stale edits.
Mutations use guarded atomic updates; project-file symlinks/hard links are refused.
Errors are structured JSON on stderr with --json. Exit codes: 0 success, 1 invalid edit/data/file, 2 invalid arguments.
`;

const trackAudioFlags = ['volume', 'muted'];
const clipAudioFlags = [...trackAudioFlags, 'fade-in', 'fade-out'];
const optionsForCommand: Record<string, readonly string[]> = {
  'timeline list': [],
  'canvas set': ['width', 'height', 'background-color'],
  'clip visual': ['x', 'y', 'scale', 'opacity', 'fit'],
  'track add': ['type', 'name'],
  'track remove': [],
  'track audio': trackAudioFlags,
  'clip add': [
    'track',
    'at',
    'in',
    'out',
    ...clipAudioFlags,
    'x',
    'y',
    'scale',
    'opacity',
    'fit',
  ],
  'clip audio': clipAudioFlags,
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
      (['timeline list', 'track add', 'canvas set'].includes(command) ? 3 : 4)
  )
    throw new UsageError(
      'Expected a timeline list, track add/remove/audio or clip add/move/trim/split/remove/audio/visual or canvas set command. Run opencut timeline --help for usage.',
    );
  const allowedOptions = [
    'json',
    ...allowed,
    ...(command === 'timeline list' ? [] : ['dry-run', 'expected-revision']),
  ];
  for (const option of Object.keys(values)) {
    if (!allowedOptions.includes(option))
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
  const audio: TrackAudioOptions = {};
  if (values.volume !== undefined) {
    const value = required('volume');
    if (
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
      !Number.isFinite(Number(value)) ||
      Number(value) > 1
    )
      throw new UsageError(
        '--volume requires a decimal linear gain between 0 and 1.',
      );
    audio.volume = Number(value);
  }
  if (values.muted !== undefined) {
    const value = required('muted');
    if (value !== 'true' && value !== 'false')
      throw new UsageError('--muted requires true or false.');
    audio.muted = value === 'true';
  }
  if (
    command === 'track audio' &&
    !trackAudioFlags.some((key) => values[key] !== undefined)
  )
    throw new UsageError('track audio requires --volume or --muted (or both).');
  if (
    command === 'clip audio' &&
    !clipAudioFlags.some((key) => values[key] !== undefined)
  )
    throw new UsageError(
      'clip audio requires --volume, --muted, --fade-in or --fade-out.',
    );
  const visual: ClipVisualOptions = {};
  for (const key of ['x', 'y', 'scale', 'opacity'] as const) {
    if (values[key] === undefined) continue;
    const value = required(key);
    const number = Number(value);
    const min = key === 'scale' ? 0.01 : key === 'opacity' ? 0 : -32768;
    const max = key === 'scale' ? 4 : key === 'opacity' ? 1 : 32768;
    if (
      !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
      !Number.isFinite(number) ||
      number < min ||
      number > max
    )
      throw new UsageError(
        `--${key} requires a decimal number between ${min} and ${max}.`,
      );
    visual[key] = number;
  }
  if (values.fit !== undefined) {
    const fit = required('fit');
    if (fit !== 'contain' && fit !== 'cover' && fit !== 'stretch')
      throw new UsageError('--fit requires contain, cover or stretch.');
    visual.fit = fit;
  }
  if (command === 'clip visual' && Object.keys(visual).length === 0)
    throw new UsageError('clip visual requires at least one visual option.');
  const canvas: { width?: number; height?: number; backgroundColor?: string } =
    {};
  for (const key of ['width', 'height'] as const) {
    if (values[key] === undefined) continue;
    const value = required(key);
    if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) <= 0
    )
      throw new UsageError(`--${key} requires a positive safe integer.`);
    canvas[key] = Number(value);
  }
  if (values['background-color'] !== undefined) {
    const value = required('background-color');
    if (!canvasColorPattern.test(value))
      throw new UsageError(
        '--background-color requires #RRGGBB, #RRGGBBAA or transparent.',
      );
    canvas.backgroundColor = value;
  }
  if (command === 'canvas set' && Object.keys(canvas).length === 0)
    throw new UsageError('canvas set requires at least one canvas option.');
  const frameFlags = ['at', 'in', 'out', 'fade-in', 'fade-out'] as const;
  const frames: Partial<Record<(typeof frameFlags)[number], number>> = {};
  for (const key of frameFlags) {
    if (values[key] === undefined) continue;
    const value = required(key);
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
      throw new UsageError(
        `--${key} requires a nonnegative safe integer project-frame index (0–9007199254740991).`,
      );
    frames[key] = number;
  }
  const options = editOptions(values);
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
        `Track: ${track.id} (${track.type}, ${track.name}); volume ${track.volume ?? 1}; muted ${track.muted ?? false}`,
        ...track.clips.map((clip) =>
          clip.text
            ? `  Text: ${clip.id}; timeline [${time(clip.timelineStart)}, ${time(clip.timelineEnd)}); text ${JSON.stringify(clip.text)}; visual ${JSON.stringify(clip.visual ?? {})}`
            : `  Clip: ${clip.id}; asset ${clip.assetId}; timeline [${time(clip.timelineStart)}, ${time(clip.timelineEnd)}); source [${time(clip.sourceIn)}, ${time(clip.sourceOut)}); volume ${clip.volume ?? 1}; muted ${clip.muted ?? false}; fade in ${clip.fadeIn ? time(clip.fadeIn.duration) : '0s'}; fade out ${clip.fadeOut ? time(clip.fadeOut.duration) : '0s'}; visual ${JSON.stringify(clip.visual ?? {})}`,
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
      const time = (key: (typeof frameFlags)[number]) =>
        frameTime(frames[key]!, project.settings.frameRate);
      const clipAudio: ClipAudioOptions = {
        ...audio,
        fadeIn: frames['fade-in'] === undefined ? undefined : time('fade-in'),
        fadeOut:
          frames['fade-out'] === undefined ? undefined : time('fade-out'),
      };
      let changed;
      switch (command) {
        case 'track add':
          changed = addTrack(project, {
            type: values.type as 'video' | 'audio',
            name: values.name as string,
          });
          break;
        case 'track audio':
          changed = setTrackAudio(project, id!, audio);
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
            ...clipAudio,
            ...(Object.keys(visual).length ? { visual } : {}),
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
        case 'canvas set':
          changed = setCanvas(project, canvas);
          break;
        case 'clip visual':
          changed = setClipVisual(project, id!, visual);
          break;
        case 'clip audio':
          changed = setClipAudio(project, id!, clipAudio);
          break;
        default:
          throw new UsageError('Unknown timeline operation.');
      }
      const { project: updated, ...fields } = changed;
      return { project: updated, result: { path: canonicalPath, ...fields } };
    },
    { ...options, label: command },
  );
  process.stdout.write(
    values.json
      ? JSON.stringify(result, null, 2) + '\n'
      : `${options.dryRun ? 'Validated' : 'Saved'} ${command}: ${JSON.stringify(result)}\n`,
  );
}
