import { describe, expect, it } from 'vitest';
import { addAssetClip } from './library.js';
import { createProject, serializeProject } from './project.js';
import { frameTime } from './time.js';
import { projectRevision, undoEdit, redoEdit } from './editing.js';
const rate = { numerator: 30000, denominator: 1001 };
function fixture() {
  const project = createProject({
    name: 'Library',
    settings: { width: 1920, height: 1080, frameRate: rate },
  });
  project.assets = [
    {
      id: 'video',
      name: 'Video',
      file: { type: 'relative', path: 'video.mp4' },
      mediaTypes: ['video', 'audio'],
      duration: { numerator: 3, denominator: 1 },
    },
    {
      id: 'audio',
      name: 'Audio',
      file: { type: 'relative', path: 'audio.wav' },
      mediaTypes: ['audio'],
      duration: { numerator: 2, denominator: 1 },
    },
    {
      id: 'image',
      name: 'Still',
      file: { type: 'relative', path: 'still.png' },
      mediaTypes: ['video'],
      metadata: {
        kind: 'image',
        formatName: 'png_pipe',
        durationSeconds: null,
        width: 10,
        height: 10,
        videoCodec: 'png',
        audioCodec: null,
        frameRate: null,
        frameRateRatio: null,
        hasAudio: false,
      },
    },
  ];
  project.tracks = [
    { id: 'v1', name: 'Video', type: 'video' },
    { id: 'a1', name: 'Audio', type: 'audio' },
  ];
  return project;
}
describe('library clip creation', () => {
  it('floors timed media to full project frames, preserving source bounds and frame-exact start', () => {
    const project = fixture();
    const next = addAssetClip(project, {
      assetId: 'video',
      trackId: 'v1',
      mediaType: 'video',
      at: 31,
    });
    expect(next.clips[0]).toMatchObject({
      timelineStart: frameTime(31, rate),
      sourceIn: frameTime(0, rate),
      sourceOut: frameTime(89, rate),
    });
    expect(project.clips).toEqual([]);
    const audio = addAssetClip(next, {
      assetId: 'audio',
      trackId: 'a1',
      mediaType: 'audio',
      at: 0,
    });
    expect(audio.clips[1]!.sourceOut).toEqual(frameTime(59, rate));
  });
  it('creates a new track and a five-second still as one undoable operation', () => {
    const project = fixture();
    const next = addAssetClip(project, {
      assetId: 'image',
      mediaType: 'video',
      at: 12,
    });
    expect(next.tracks).toHaveLength(3);
    expect(next.clips[0]!.sourceOut).toEqual(frameTime(150, rate));
    expect(projectRevision(next)).toBe(1);
    const undone = undoEdit(next, 1);
    expect(undone.tracks).toEqual(project.tracks);
    expect(undone.clips).toEqual([]);
    expect(redoEdit(undone, 2).clips).toEqual(next.clips);
  });
  it('rejects invalid destinations, overlap, unknown durations and invalid positions without mutation', () => {
    const initial = fixture();
    const project = addAssetClip(initial, {
      assetId: 'video',
      trackId: 'v1',
      mediaType: 'video',
      at: 0,
    });
    const before = serializeProject(project);
    for (const input of [
      { assetId: 'audio', trackId: 'v1', mediaType: 'video' as const, at: 0 },
      { assetId: 'video', trackId: 'v1', mediaType: 'audio' as const, at: 0 },
      {
        assetId: 'video',
        trackId: 'missing',
        mediaType: 'video' as const,
        at: 0,
      },
      { assetId: 'missing', mediaType: 'video' as const, at: 0 },
      { assetId: 'video', trackId: 'v1', mediaType: 'video' as const, at: 1 },
      { assetId: 'video', mediaType: 'video' as const, at: -1 },
      { assetId: 'video', mediaType: 'video' as const, at: 0.5 },
    ])
      expect(() => addAssetClip(project, input)).toThrow();
    expect(serializeProject(project)).toBe(before);
    delete initial.assets[0]!.duration;
    expect(() =>
      addAssetClip(initial, { assetId: 'video', mediaType: 'video', at: 0 }),
    ).toThrow('duration');
    initial.assets[0]!.duration = { numerator: 1, denominator: 1000 };
    expect(() =>
      addAssetClip(initial, { assetId: 'video', mediaType: 'video', at: 0 }),
    ).toThrow('shorter');
  });
});
