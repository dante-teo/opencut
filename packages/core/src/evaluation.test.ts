import { expect, it } from 'vitest';
import {
  createProject,
  evaluateTimeline,
  evaluateTimelineFrame,
  frameTime,
} from './index.js';

it('selects exactly one clip at touching fractional boundaries and retains defaults', () => {
  const project = createProject({ name: 'Boundaries' });
  project.settings.frameRate = { numerator: 30000, denominator: 1001 };
  const at = (frame: number) => frameTime(frame, project.settings.frameRate);
  project.assets = [
    {
      id: 'asset',
      name: 'Unknown video',
      mediaTypes: ['video'],
      file: { type: 'relative', path: 'offline.mp4' },
    },
  ];
  project.tracks = [{ id: 'track', name: 'Video', type: 'video' }];
  project.clips = Array.from({ length: 64 }, (_, i) => ({
    id: `clip-${i}`,
    assetId: 'asset',
    trackId: 'track',
    timelineStart: at(i),
    sourceIn: at(i + 7),
    sourceOut: at(i + 8),
  }));
  for (let i = 0; i < 64; i++) {
    const result = evaluateTimelineFrame(project, i);
    expect(result.activeClips).toHaveLength(1);
    expect(result.activeClips[0]).toMatchObject({
      id: `clip-${i}`,
      sourceTime: at(i + 7),
      visual: { x: 0, y: 0, scale: 1, opacity: 1, fit: 'contain' },
      volume: 1,
      muted: false,
      audioPresence: 'unknown',
    });
  }
  expect(evaluateTimelineFrame(project, 64).activeClips).toEqual([]);
  const before = structuredClone(project);
  const result = evaluateTimeline(project, at(0));
  result.activeClips[0]!.sourceIn.numerator = 99;
  expect(project).toEqual(before);
});
