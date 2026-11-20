import { z } from 'zod';
import { professionalMixSchema } from './professional-mix.js';
import type { Project } from './project.js';

const trackId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const musicComparisonSchema = z
  .strictObject({
    candidates: z
      .array(
        z.strictObject({
          trackId,
          ducking: professionalMixSchema.shape.ducking,
          previouslyUsedIn: z
            .array(z.string().trim().min(1).max(200))
            .max(20)
            .optional(),
        }),
      )
      .min(2)
      .max(8)
      .refine(
        (candidates) =>
          new Set(candidates.map((item) => item.trackId)).size ===
          candidates.length,
        'Music candidate tracks must be unique.',
      ),
    selected: trackId,
    matchLoudness: z.boolean().optional(),
  })
  .refine(
    ({ candidates, selected }) =>
      candidates.some((candidate) => candidate.trackId === selected),
    'Select a track listed among the music candidates.',
  );

export const musicSelectionSchema = z.strictObject({
  candidate: trackId.optional(),
  matchLoudness: z.boolean().optional(),
});
export type MusicSelection = z.infer<typeof musicSelectionSchema>;

export function describeMusicComparison(project: Project) {
  const { musicComparison } = project;
  if (!musicComparison) return;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const uses = new Map<string, number>();
  for (const { assetId } of project.clips) {
    const asset = assetId && assets.get(assetId);
    if (asset) uses.set(asset.file.path, (uses.get(asset.file.path) ?? 0) + 1);
  }
  return {
    selected: musicComparison.selected,
    matchLoudness: musicComparison.matchLoudness ?? false,
    candidates: musicComparison.candidates.map(
      ({ trackId, previouslyUsedIn }) => {
        const track = project.tracks.find(({ id }) => id === trackId)!;
        const sources = new Map<
          string,
          NonNullable<ReturnType<typeof assets.get>>
        >();
        for (const clip of project.clips) {
          const asset = clip.assetId && assets.get(clip.assetId);
          if (asset && clip.trackId === trackId)
            sources.set(asset.file.path, asset);
        }
        return {
          trackId,
          name: track.name,
          previouslyUsedIn: previouslyUsedIn ?? [],
          sources: [...sources.values()].map(({ name, file, provenance }) => ({
            name,
            path: file.path,
            reusedInProject: (uses.get(file.path) ?? 0) > 1,
            ...(provenance && { provenance }),
          })),
        };
      },
    ),
  };
}
