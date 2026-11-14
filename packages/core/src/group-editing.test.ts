import { describe, expect, it } from 'vitest';
import {
  clipTimelineEnd,
  compareTimes,
  copyClips,
  createProject,
  deserializeProject,
  executeTransaction,
  frameTime,
  projectRevision,
  projectSnapshot,
  redoEdit,
  serializeProject,
  undoEdit,
} from './index.js';
import type { EditOperation, Project } from './index.js';
import { insertFreeze } from './timeline.js';

const rate = { numerator: 30000, denominator: 1001 };
const time = (frame: number) => frameTime(frame, rate);
const apply = (project: Project, ...operations: EditOperation[]) =>
  executeTransaction(project, {
    expectedRevision: projectRevision(project),
    operations,
  }).project;

function fixture() {
  const project = createProject({
    name: 'Creator edit',
    settings: { width: 128, height: 96, frameRate: rate },
  });
  project.assets.push({
    id: 'asset',
    name: 'Source',
    file: { type: 'relative', path: 'source.mp4' },
    mediaTypes: ['video', 'audio'],
  });
  project.tracks.push(
    { id: 'v', name: 'Video', type: 'video' },
    { id: 'a', name: 'Audio', type: 'audio' },
    { id: 'music', name: 'Music', type: 'audio' },
  );
  return apply(
    project,
    {
      type: 'clip.add',
      id: 'v0',
      assetId: 'asset',
      trackId: 'v',
      at: 0,
      in: 0,
      out: 30,
    },
    {
      type: 'clip.add',
      id: 'a0',
      assetId: 'asset',
      trackId: 'a',
      at: 0,
      in: 0,
      out: 30,
    },
    {
      type: 'clip.add',
      id: 'v1',
      assetId: 'asset',
      trackId: 'v',
      at: 60,
      in: 0,
      out: 60,
    },
    {
      type: 'clip.add',
      id: 'a1',
      assetId: 'asset',
      trackId: 'a',
      at: 60,
      in: 0,
      out: 60,
    },
    {
      type: 'clip.add',
      id: 'bed',
      assetId: 'asset',
      trackId: 'music',
      at: 20,
      in: 0,
      out: 120,
    },
    { type: 'clips.link', ids: ['v0', 'a0'], linked: true },
    { type: 'clips.link', ids: ['v1', 'a1'], linked: true },
  );
}

const clip = (project: Project, id: string) =>
  project.clips.find((entry) => entry.id === id)!;

describe('creator timeline edits', () => {
  it('ripples linked tracks, keeps existing gaps, and refuses to collapse an occupied range', () => {
    const original = fixture();
    expect(() =>
      apply(original, {
        type: 'clips.remove',
        ids: ['v0'],
        ripple: 'all-unlocked',
      }),
    ).toThrow('spans');
    const rippled = apply(original, {
      type: 'clips.remove',
      ids: ['v0'],
      ripple: 'selected-tracks',
    });
    expect(rippled.clips.map((entry) => entry.id)).toEqual(['v1', 'a1', 'bed']);
    expect(clip(rippled, 'v1').timelineStart).toEqual(time(30));
    expect(clip(rippled, 'a1').timelineStart).toEqual(time(30));
    expect(clip(rippled, 'bed').timelineStart).toEqual(time(20));
    const undone = undoEdit(deserializeProject(serializeProject(rippled)));
    expect(projectSnapshot(undone)).toEqual(projectSnapshot(original));
    expect(projectSnapshot(redoEdit(undone))).toEqual(projectSnapshot(rippled));
  });

  it('closes a common gap and refuses shifts that would separate linked clips', () => {
    const original = fixture();
    expect(() =>
      apply(original, { type: 'timeline.close-gap', trackIds: ['v'], at: 45 }),
    ).toThrow('desynchronize');
    const closed = apply(original, {
      type: 'timeline.close-gap',
      trackIds: ['v', 'a'],
      at: 45,
    });
    expect(clip(closed, 'a1').timelineStart).toEqual(time(30));
    expect(clip(closed, 'v1').timelineStart).toEqual(
      clipTimelineEnd(clip(closed, 'v0')),
    );
    expect(() =>
      apply(original, {
        type: 'timeline.close-gap',
        trackIds: ['v', 'music'],
        at: 45,
      }),
    ).toThrow('gap');
  });

  it('inserts a clipboard inside linked clips and splits their source mapping and links', () => {
    const original = fixture();
    const clipboard = copyClips(original, ['v0']);
    expect(clipboard.clips.map((clip) => clip.id)).toEqual(['v0', 'a0']);
    const inserted = apply(original, {
      type: 'clips.paste',
      clipboard,
      at: 90,
      insert: 'selected-tracks',
    });
    expect(inserted.clips).toHaveLength(original.clips.length + 4);
    expect(clip(inserted, 'v1').sourceOut).toEqual(time(30));
    const right = inserted.clips.filter(
      (entry) => compareTimes(entry.timelineStart, time(120)) === 0,
    );
    expect(right).toHaveLength(2);
    expect(right[0]?.linkId).toBe(right[1]?.linkId);
    expect(right[0]?.linkId).not.toBe(clip(inserted, 'v1').linkId);
    expect(
      right.every((entry) => compareTimes(entry.sourceIn, time(30)) === 0),
    ).toBe(true);
    expect(() =>
      apply(original, { type: 'clips.paste', clipboard, at: 90 }),
    ).toThrow('overlaps');
    expect(() =>
      apply(original, {
        type: 'clips.paste',
        clipboard: { ...clipboard, projectId: 'different' },
        at: 150,
      }),
    ).toThrow('another project');
  });

  it('preserves transitions in a copy and leaves locked tracks in place', () => {
    const original = apply(
      fixture(),
      {
        type: 'transition.add',
        id: 'fade',
        transition: { kind: 'fade-in', clipId: 'v0', frames: 8 },
      },
      { type: 'track.lock', id: 'music', locked: true },
    );
    const duplicated = apply(original, {
      type: 'clips.duplicate',
      ids: ['v0'],
      at: 120,
    });
    expect(duplicated.transitions).toHaveLength(2);
    expect(duplicated.transitions?.[1]?.id).not.toBe('fade');
    expect(
      duplicated.clips
        .filter(
          (entry) =>
            !original.clips.some((previous) => previous.id === entry.id),
        )
        .map((entry) => entry.timelineStart),
    ).toEqual([time(120), time(120)]);
    expect(() =>
      apply(original, { type: 'clip.move', id: 'bed', at: 30 }),
    ).toThrow('locked');
    const rippled = apply(original, {
      type: 'clips.remove',
      ids: ['v0'],
      ripple: 'all-unlocked',
    });
    expect(clip(rippled, 'bed')).toEqual(clip(original, 'bed'));
  });

  it('rejects a freeze edit on a locked track even with a prepared still', () => {
    const original = fixture();
    delete original.editing;
    original.assets.push({
      id: 'still',
      name: 'Still',
      file: { type: 'relative', path: 'still.png' },
      mediaTypes: ['video'],
      metadata: {
        kind: 'image',
        formatName: null,
        durationSeconds: null,
        width: 128,
        height: 96,
        videoCodec: null,
        audioCodec: null,
        frameRate: null,
        frameRateRatio: null,
        hasAudio: false,
      },
    });
    const locked = apply(
      original,
      { type: 'clips.link', ids: ['v0'], linked: false },
      { type: 'track.lock', id: 'v', locked: true },
    );
    const freeze = {
      type: 'clip.freeze',
      id: 'v0',
      stillId: 'still',
      at: 12,
      frames: 3,
    } as const;
    expect(() =>
      insertFreeze(locked, 'v0', 'still', time(12), time(3)),
    ).toThrow('locked');
    const unlocked = apply(
      locked,
      { type: 'track.lock', id: 'v', locked: false },
      {
        type: 'clips.link',
        ids: ['v1'],
        linked: false,
      },
      freeze,
    );
    expect(
      unlocked.clips.find((entry) => entry.assetId === 'still')?.timelineStart,
    ).toEqual(time(12));
  });

  it('returns a clipboard from a cut and restores the edit in a single undo', () => {
    const original = fixture();
    const result = executeTransaction(original, {
      expectedRevision: projectRevision(original),
      operations: [{ type: 'clips.cut', ids: ['a0'] }],
    });
    expect(result.results[0]?.clipboard).toEqual(copyClips(original, ['v0']));
    expect(projectSnapshot(undoEdit(result.project))).toEqual(
      projectSnapshot(original),
    );
    expect(clip(result.project, 'v1').timelineStart).toEqual(time(60));
  });
});
