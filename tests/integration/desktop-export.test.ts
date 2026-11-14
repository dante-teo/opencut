import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProject, frameTime, projectRevision } from '@opencut/core';
import { resolveProjectRender } from '@opencut/core/node';
import {
  renderVideoTimeline,
  validateVideoTimeline,
} from '../../packages/media/dist/index.js';
import { ExportSession } from '../../apps/desktop/src/main/export-session.js';
import type {
  DesktopProject,
  ExportState,
} from '../../apps/desktop/src/bridge.js';
import { exportPresets } from '../../apps/desktop/src/export-settings.js';

vi.mock('../../packages/media/dist/index.js', async (original) => ({
  ...(await original<typeof import('../../packages/media/dist/index.js')>()),
  renderVideoTimeline: vi.fn(),
  validateVideoTimeline: vi.fn(),
}));
vi.mock('@opencut/core/node', async (original) => ({
  ...(await original<typeof import('@opencut/core/node')>()),
  resolveProjectRender: vi.fn(),
}));
let current: DesktopProject;
let session: ExportSession;
let changes: ExportState[];
const summary = {
  width: 640,
  height: 360,
  frameRate: { numerator: 30, denominator: 1 },
  frameCount: 30,
  durationSeconds: 1,
  codec: 'h264' as const,
};
const settings = exportPresets[0]!.settings;
const input = () => ({
  view: current.view,
  projectId: current.project.metadata.id,
  expectedRevision: projectRevision(current.project),
  settings,
});
beforeEach(async () => {
  vi.resetAllMocks();
  current = {
    project: createProject({
      name: 'Snapshot',
      settings: {
        width: 640,
        height: 360,
        frameRate: { numerator: 30, denominator: 1 },
      },
    }),
    path: '/projects/snapshot.json',
    view: 1,
    media: [],
  };
  changes = [];
  session = new ExportSession(
    () => current,
    async () => '/exports/new.mp4',
    (state) => changes.push(state),
  );
  vi.mocked(resolveProjectRender).mockResolvedValue({
    ...summary,
    backgroundColor: '#000000',
    visualClips: [],
    audioClips: [],
  });
  vi.mocked(validateVideoTimeline).mockResolvedValue(summary);
  vi.mocked(renderVideoTimeline).mockResolvedValue({
    ...summary,
    codec: 'h264',
    quality: 'balanced',
    resolution: 'project',
    path: '/exports/new.mp4',
    metadata: {} as never,
  });
  await session.chooseOutput();
});
afterEach(async () => session.dispose());
async function finished() {
  await vi.waitFor(() => expect(session.active).toBe(false));
  return session.current()!;
}
it('captures a committed snapshot and resolved original plan, independent of subsequent edits', async () => {
  let release!: () => void;
  vi.mocked(resolveProjectRender).mockImplementation(async (project, path) => {
    expect(path).toBe('/projects/snapshot.json');
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(project.metadata.name).toBe('Snapshot');
    return {
      ...summary,
      backgroundColor: '#000000',
      visualClips: [
        {
          clipId: 'clip',
          assetId: 'asset',
          path: '/original.mp4',
          timelineStartFrame: 0,
          sourceStartFrame: 0,
          frameCount: 30,
          x: 0,
          y: 0,
          opacity: 1,
          scale: 1,
          fit: 'contain',
        },
      ],
      audioClips: [],
    };
  });
  const started = session.start(input());
  expect(started.status).toBe('validating');
  current.project.metadata.name = 'Edited during export';
  current.project.clips = [
    {
      id: 'later',
      assetId: 'asset',
      trackId: 'track',
      sourceIn: frameTime(0, summary.frameRate),
      sourceOut: frameTime(10, summary.frameRate),
      timelineStart: frameTime(0, summary.frameRate),
    },
  ];
  release();
  expect(await finished()).toMatchObject({
    status: 'succeeded',
    projectName: 'Snapshot',
    revision: 0,
    summary,
  });
  expect(renderVideoTimeline).toHaveBeenCalledWith(
    expect.objectContaining({
      overwrite: false,
      visualClips: [
        expect.objectContaining({ path: '/original.mp4', frameCount: 30 }),
      ],
    }),
  );
  expect(changes.map((state) => state.status)).toEqual([
    'validating',
    'rendering',
    'succeeded',
  ]);
});
it('distinguishes validation failures and recovers on retry', async () => {
  vi.mocked(validateVideoTimeline).mockRejectedValueOnce(
    new Error('Missing media'),
  );
  session.start(input());
  expect(await finished()).toMatchObject({
    status: 'validation_failed',
    error: 'Missing media',
  });
  expect(renderVideoTimeline).not.toHaveBeenCalled();
  session.start(input());
  expect(await finished()).toMatchObject({ status: 'succeeded', error: '' });
});
it('reports execution failures separately and can export again', async () => {
  vi.mocked(renderVideoTimeline).mockRejectedValueOnce(
    new Error('Encoder failed'),
  );
  session.start(input());
  expect(await finished()).toMatchObject({
    status: 'failed',
    error: 'Encoder failed',
  });
  session.start(input());
  expect(await finished()).toMatchObject({ status: 'succeeded' });
});
it('cancels validation, prevents rendering and waits for cleanup before terminal cancellation', async () => {
  vi.mocked(validateVideoTimeline).mockImplementation(async (options) => {
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );
    throw new Error('aborted');
  });
  const started = session.start(input());
  await vi.waitFor(() => expect(validateVideoTimeline).toHaveBeenCalled());
  expect(session.cancel(started.id)?.status).toBe('cancelling');
  expect(await finished()).toMatchObject({ status: 'cancelled', error: '' });
  expect(renderVideoTimeline).not.toHaveBeenCalled();
});
it('cancels rendering, throttles progress and rejects concurrent or stale actions', async () => {
  vi.mocked(renderVideoTimeline).mockImplementation(async (options) => {
    const progress = {
      event: 'progress' as const,
      phase: 'rendering' as const,
      percent: 20,
      processedFrames: 6,
      totalFrames: 30,
      elapsedSeconds: 1,
      remainingSeconds: 4,
    };
    for (let i = 0; i < 100; i++) options.onProgress?.(progress);
    await new Promise<void>((resolve) =>
      options.signal!.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );
    throw new Error('aborted');
  });
  session.start(input());
  await vi.waitFor(() => expect(renderVideoTimeline).toHaveBeenCalled());
  expect(changes.length).toBeLessThan(5);
  expect(() => session.start(input())).toThrow('in progress');
  await expect(session.chooseOutput()).rejects.toThrow('in progress');
  expect(() => session.cancel('stale')).toThrow('changed');
  await session.cancelAndWait();
  expect(session.current()?.status).toBe('cancelled');
});
it('keeps a successful atomic publication when cancellation arrives after publication', async () => {
  vi.mocked(renderVideoTimeline).mockImplementation(async () => {
    session.cancel(session.current()!.id);
    return {
      ...summary,
      codec: 'h264',
      quality: 'balanced',
      resolution: 'project',
      path: '/exports/new.mp4',
      metadata: {} as never,
    };
  });
  session.start(input());
  expect(await finished()).toMatchObject({ status: 'succeeded' });
});
it('rejects path injection, unknown settings and output requests before the native picker', () => {
  expect(() => session.start({ ...input(), output: '/injected.mp4' })).toThrow(
    'Invalid export',
  );
  expect(() =>
    session.start({
      ...input(),
      settings: { ...settings, codec: 'arbitrary' },
    }),
  ).toThrow('Invalid export');
  const fresh = new ExportSession(
    () => current,
    async () => null,
    () => {},
  );
  expect(() => fresh.start(input())).toThrow('Choose an output');
});
it('canceled pickers preserve the previous output grant and do not start jobs', async () => {
  let choice: string | null = '/exports/previous.mp4';
  const picker = new ExportSession(
    () => current,
    async () => choice,
    () => {},
  );
  await picker.chooseOutput();
  choice = null;
  expect(await picker.chooseOutput()).toBeNull();
  expect(picker.current()).toBeNull();
  expect(picker.start(input()).output).toBe('/exports/previous.mp4');
  await picker.cancelAndWait();
});
