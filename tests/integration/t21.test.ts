import { describe, expect, it } from 'vitest';
import {
  deserializeProject,
  planProjectRender,
  serializeProject,
} from '@opencut/core';
import { auditProjects } from '../../scripts/t21-projects.js';

describe('T21 representative project contracts', () => {
  it('round trips deterministic portable projects and compiles every case', () => {
    const first = auditProjects();
    expect(first).toEqual(auditProjects());
    for (const project of Object.values(first)) {
      expect(deserializeProject(serializeProject(project))).toEqual(project);
      expect(
        project.assets.every((asset) => asset.file.type === 'relative'),
      ).toBe(true);
      expect(planProjectRender(project).frameCount).toBeGreaterThan(0);
    }
  });
  it('covers cuts, initial/internal gaps, an audio tail, transforms, mixed rates and six concurrent layers', () => {
    const projects = auditProjects();
    expect(
      projects.cuts!.assets.map((asset) => asset.metadata?.frameRate),
    ).toEqual([30, 25, null, null]);
    expect(projects.overlays!.assets[3]!.metadata?.kind).toBe('image');
    const cuts = planProjectRender(projects.cuts!);
    expect(
      cuts.visualClips.map((c) => [c.timelineStartFrame, c.frameCount]),
    ).toEqual([
      [0, 90],
      [90, 90],
    ]);
    const gaps = planProjectRender(projects.gaps!);
    expect(gaps.visualClips.map((c) => c.timelineStartFrame)).toEqual([
      30, 120,
    ]);
    expect(gaps.frameCount).toBe(240);
    expect(gaps.audioClips.at(-1)?.required).toBe(true);
    expect(planProjectRender(projects.overlays!).visualClips[1]).toMatchObject({
      scale: 0.5,
      opacity: 0.5,
      x: 160,
      y: -80,
    });
    expect(
      planProjectRender(projects.mixing!).audioClips.map((c) => [
        c.volume,
        c.muted,
      ]),
    ).toEqual([
      [0.5, false],
      [1, true],
      [0.25, false],
    ]);
    const stress = planProjectRender(projects.stress!);
    expect(stress.visualClips).toHaveLength(48);
    expect(
      stress.visualClips.filter((c) => c.timelineStartFrame === 0),
    ).toHaveLength(6);
    expect(stress.frameCount).toBe(240);
  });
});
