import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  createProject,
  deserializeProject,
  frameTime,
  getProjectInfo,
  serializeProject,
  validateProject,
} from '@opencut/core';
import { resolveMediaReference } from '@opencut/core/node';

it('exposes the built headless project API and optional Node adapter', () => {
  const project = createProject({ name: 'Built package' });
  expect(getProjectInfo(project)).toEqual({
    schemaVersion: 1,
    metadata: project.metadata,
    settings: project.settings,
    statistics: { assets: 0, tracks: 0, clips: 0 },
  });
  const info = getProjectInfo(project);
  info.metadata.name = 'Independent copy';
  expect(project.metadata.name).toBe('Built package');
  expect(() =>
    getProjectInfo({ ...project, settings: { ...project.settings, width: 0 } }),
  ).toThrow('/settings/width');
  expect(deserializeProject(serializeProject(project))).toEqual(project);
  expect(frameTime(30, { numerator: 30000, denominator: 1001 })).toEqual({
    numerator: 1001,
    denominator: 1000,
  });
  expect(
    resolveMediaReference(
      { type: 'relative', path: 'media/camera.mp4' },
      '/bundle/project.json',
    ),
  ).toBe('/bundle/media/camera.mp4');
});

it('keeps the documented version 1 example valid and lossless', async () => {
  const documentation = await readFile(
    new URL('../../docs/PROJECT_FORMAT.md', import.meta.url),
    'utf8',
  );
  const json = /```json\n([\s\S]*?)\n```/.exec(documentation)?.[1];
  expect(json).toBeDefined();
  const project = deserializeProject(json!);
  expect(validateProject(project).success).toBe(true);
  expect(project.assets).toHaveLength(2);
  expect(project.tracks.map((track) => track.type)).toEqual(['video', 'audio']);
  expect(project.clips).toHaveLength(2);
  expect(deserializeProject(serializeProject(project))).toEqual(
    JSON.parse(json!),
  );
});
