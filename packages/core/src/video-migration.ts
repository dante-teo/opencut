import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { describeMediaAsset } from './assets.js';
import {
  canonicalProjectFilePath,
  createMediaReference,
  publishNewFile,
  readProjectFile,
  resolveMediaReference,
} from './project-files.js';
import { clipSchema } from './project.js';
import type { Project } from './project.js';
import { planProjectRender } from './render-plan.js';
import type { VideoDefinition } from './video-definition.js';
import {
  compileDefinition,
  probeVideoSource,
  stableId,
} from './video-compiler.js';
import type { VideoSourceProbes } from './video-compiler.js';
import { isVideoDefinitionPath } from './video-files.js';

export class VideoMigrationError extends Error {
  override name = 'VideoMigrationError';
  readonly code = 'VIDEO_MIGRATION_FAILED';
}

const migratedClipFields = clipSchema
  .omit({ trackId: true, timelineStart: true, assetId: true, text: true })
  .strip();

/** Convert the saved snapshot and publish a validated, standalone definition. */
export async function migrateProject(
  source: string,
  output: string,
  { signal }: { signal?: AbortSignal | undefined } = {},
) {
  if (!isVideoDefinitionPath(output))
    throw new VideoMigrationError(
      'Choose a new .video.json or .video.ts output.',
    );
  signal?.throwIfAborted();
  const sourcePath = await canonicalProjectFilePath(resolve(source));
  const path = await canonicalProjectFilePath(resolve(output));
  try {
    const project = await readProjectFile(sourcePath);
    const probes: VideoSourceProbes = new Map();
    const json = JSON.stringify(
      await toDefinition(project, sourcePath, path, probes, signal),
      null,
      2,
    );
    const converted = await compileDefinition(
      path,
      JSON.parse(json) as unknown,
      { signal, probes },
    );
    // Compare the serialized render data so absent and undefined optional
    // properties have the same meaning, as they do in a saved definition.
    const plan = (value: Project) =>
      JSON.parse(JSON.stringify(planProjectRender(value))) as unknown;
    if (!isDeepStrictEqual(plan(project), plan(converted.project)))
      throw new Error(
        'The converted render plan differs from the saved project.',
      );
    await publishNewFile(
      path,
      path.endsWith('.video.ts') ? `export default ${json};\n` : `${json}\n`,
      signal,
    );
    return {
      path,
      sourcePath,
      historyOmitted: project.editing !== undefined,
    };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')
      throw new VideoMigrationError(
        `Refusing to overwrite existing output '${path}'.`,
        { cause },
      );
    throw new VideoMigrationError(
      `Cannot convert '${sourcePath}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function toDefinition(
  project: Project,
  sourcePath: string,
  output: string,
  probes: VideoSourceProbes,
  signal?: AbortSignal,
): Promise<VideoDefinition> {
  const assets: NonNullable<VideoDefinition['assets']> = {};
  for (const { id, file, metadata, ...properties } of project.assets) {
    const original = resolveMediaReference(file, sourcePath);
    const reference = createMediaReference(original, output);
    if (reference.type !== 'relative')
      throw new Error(
        `Asset '${id}' cannot be expressed relative to the output directory. Choose a destination on the same volume and check its path.`,
      );
    const probed = await probeVideoSource(id, original, probes, signal);
    const kind = properties.freezeFrame
      ? 'image'
      : describeMediaAsset(probed).metadata.kind;
    assets[id] = {
      ...properties,
      kind,
      path: reference.path,
      metadata: metadata ?? null,
    };
  }

  const fonts = new Map<string, string>();
  const fontRef = <Style extends { embeddedFont?: string | null | undefined }>(
    style: Style,
  ) => {
    const { embeddedFont, ...properties } = style;
    if (!embeddedFont) return { ...properties, embeddedFont };
    let font = fonts.get(embeddedFont);
    if (!font) {
      font = stableId('font', embeddedFont);
      fonts.set(embeddedFont, font);
    }
    return { ...properties, font };
  };
  const tracks: VideoDefinition['tracks'] = project.tracks.map((track) => {
    const clips = project.clips
      .filter((clip) => clip.trackId === track.id)
      .map((clip) => {
        const { timelineStart: at, assetId, text } = clip;
        const properties = migratedClipFields.parse(clip);
        return text
          ? { ...properties, at, text: fontRef(text) }
          : { ...properties, at, asset: assetId! };
      });
    if (track.type === 'video') return { ...track, type: 'video', clips };
    return {
      ...track,
      type: 'audio',
      clips: clips.map((clip) => {
        if (!('asset' in clip))
          throw new Error(
            `Text clip '${clip.id}' cannot be converted on an audio track.`,
          );
        return clip;
      }),
    };
  });
  const subtitles = project.subtitles && {
    style: fontRef(project.subtitles.style),
    cues: project.subtitles.cues.map(({ style, ...cue }) => ({
      ...cue,
      ...(style && { style: fontRef(style) }),
    })),
  };
  return {
    version: 1,
    ...project.metadata,
    canvas: project.settings,
    assets,
    ...(fonts.size && {
      fonts: Object.fromEntries(
        Array.from(fonts, ([data, id]) => [id, { data }]),
      ),
    }),
    tracks,
    subtitles,
    transitions: project.transitions,
    markers: project.markers,
  };
}
