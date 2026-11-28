import { z } from 'zod';
import type { Project } from './project.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
// Both visual group effects use FFmpeg's gblur sigma parameter.
export const maxVisualGroupBlur = 1024;
export const visualGroupsSchema = z
  .array(
    z.strictObject({
      id,
      tracks: z.array(id).min(1).max(8),
      matte: id.optional(),
      x: z.int().min(-32768).max(32768).optional(),
      y: z.int().min(-32768).max(32768).optional(),
      scale: z.number().min(0.1).max(2).optional(),
      rotation: z.number().min(-360).max(360).optional(),
      opacity: z.number().min(0).max(1).optional(),
      blend: z.enum(['normal', 'multiply', 'screen', 'overlay']).optional(),
      clip: z
        .strictObject({
          x: z.int().min(0).max(3840),
          y: z.int().min(0).max(3840),
          width: z.int().min(1).max(3840),
          height: z.int().min(1).max(3840),
        })
        .optional(),
      blur: z.number().min(0).max(maxVisualGroupBlur).optional(),
      backdropBlur: z.number().min(0).max(maxVisualGroupBlur).optional(),
    }),
  )
  .max(8)
  .optional();

export function checkVisualGroups(
  project: Pick<Project, 'visualGroups' | 'tracks' | 'settings'>,
) {
  const ids = new Set<string>();
  const tracks = project.tracks.filter(({ type }) => type === 'video');
  const used = new Set<string>();
  for (const group of project.visualGroups ?? []) {
    const fail = (message: string) => {
      throw new RangeError(`Visual group '${group.id}': ${message}`);
    };
    if (ids.has(group.id)) fail('Duplicate group ID.');
    ids.add(group.id);
    const first = tracks.findIndex(({ id }) => id === group.tracks[0]);
    for (const [i, trackId] of group.tracks.entries()) {
      if (first < 0 || tracks[first + i]?.id !== trackId)
        fail(
          'Tracks must be a contiguous set of visual tracks in bottom-to-top order.',
        );
      if (used.has(trackId)) fail(`Track '${trackId}' is already in a group.`);
      used.add(trackId);
    }
    if (
      group.matte &&
      (group.tracks.length < 2 || !group.tracks.includes(group.matte))
    )
      fail('The matte must be a separate track inside this group.');
    const { clip } = group;
    if (
      clip &&
      (clip.x + clip.width > project.settings.width ||
        clip.y + clip.height > project.settings.height)
    )
      fail(
        'The clipping rectangle must fit inside the logical project canvas.',
      );
  }
}
