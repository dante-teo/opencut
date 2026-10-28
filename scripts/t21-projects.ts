import {
  createProject,
  serializeProject,
  type Project,
  type TimelineClip,
} from '@opencut/core';

export const auditMedia = [
  'source.mp4',
  'mixed.webm',
  'tone.wav',
  'still.png',
] as const;
/** Deterministic, portable intent; media is generated separately, never user input. */
export function auditProjects(): Record<string, Project> {
  const make = (name: string): Project => {
    const project = createProject({
      name: `T21 ${name}`,
      settings: {
        width: 1280,
        height: 720,
        frameRate: { numerator: 30, denominator: 1 },
        backgroundColor: '#183048',
      },
    });
    project.metadata = {
      id: `t21-${name}`,
      name: `T21 ${name}`,
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
    };
    project.assets = auditMedia.map((file, i) => ({
      id: `asset-${i}`,
      name: file,
      file: { type: 'relative', path: file },
      mediaTypes:
        i === 2 ? ['audio'] : i === 0 ? ['video', 'audio'] : ['video'],
      ...(i === 3 ? {} : { duration: { numerator: 8, denominator: 1 } }),
      metadata: {
        kind: i === 2 ? 'audio' : i === 3 ? 'image' : 'video',
        formatName: [
          'mov,mp4,m4a,3gp,3g2,mj2',
          'matroska,webm',
          'wav',
          'png_pipe',
        ][i]!,
        durationSeconds: i === 3 ? null : 8,
        width: [1280, 640, null, 320][i]!,
        height: [720, 360, null, 180][i]!,
        videoCodec: ['h264', 'vp9', null, 'png'][i]!,
        audioCodec: i === 0 ? 'aac' : i === 2 ? 'pcm_s16le' : null,
        frameRate: i === 0 ? 30 : i === 1 ? 25 : null,
        frameRateRatio: i === 0 ? '30/1' : i === 1 ? '25/1' : null,
        hasAudio: i === 0 || i === 2,
      },
    }));
    project.tracks = [
      { id: 'v0', name: 'Camera', type: 'video' },
      { id: 'v1', name: 'Overlay', type: 'video' },
      { id: 'a0', name: 'Music', type: 'audio' },
    ];
    return project;
  };
  const clip = (
    id: string,
    asset: number,
    trackId: string,
    start: number,
    duration: number,
    sourceIn = 0,
  ): TimelineClip => ({
    id,
    assetId: `asset-${asset}`,
    trackId,
    timelineStart: { numerator: start, denominator: 30 },
    sourceIn: { numerator: sourceIn, denominator: 30 },
    sourceOut: { numerator: sourceIn + duration, denominator: 30 },
  });
  const cuts = make('cuts');
  cuts.clips = [clip('c0', 0, 'v0', 0, 90), clip('c1', 1, 'v0', 90, 90, 30)];
  const gaps = make('gaps');
  gaps.clips = [
    clip('c0', 0, 'v0', 30, 60),
    clip('c1', 1, 'v0', 120, 60),
    clip('tail', 2, 'a0', 180, 60),
  ];
  const overlays = make('overlays');
  overlays.clips = [
    clip('base', 0, 'v0', 0, 180),
    {
      ...clip('overlay', 3, 'v1', 30, 120),
      visual: { scale: 0.5, opacity: 0.5, x: 160, y: -80, fit: 'contain' },
    },
  ];
  const mixing = make('mixing');
  mixing.clips = [
    { ...clip('base', 0, 'v0', 0, 180), volume: 0.5 },
    { ...clip('mixed', 1, 'v1', 60, 120), visual: { scale: 0.5 }, muted: true },
    { ...clip('music', 2, 'a0', 30, 150), volume: 0.25 },
  ];
  const stress = make('stress');
  stress.tracks = Array.from({ length: 6 }, (_, i) => ({
    id: `v${i}`,
    name: `Layer ${i}`,
    type: 'video',
  }));
  stress.clips = Array.from({ length: 48 }, (_, i) => ({
    ...clip(
      `c${i}`,
      i % 2,
      `v${Math.floor(i / 8)}`,
      (i % 8) * 30,
      30,
      (i % 4) * 30,
    ),
    visual: { scale: 1 - Math.floor(i / 8) * 0.12, opacity: 0.7 },
    muted: true,
  }));
  const projects = { cuts, gaps, overlays, mixing, stress };
  for (const project of Object.values(projects)) serializeProject(project);
  return projects;
}
