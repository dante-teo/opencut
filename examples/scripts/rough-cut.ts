import type { OpenCutScript } from '@opencut/sdk';

const roughCut: OpenCutScript = async ({ project, args }) => {
  if (!args.length)
    throw new Error(
      'Pass one or more video paths after --, each at least one second long at 30 fps.',
    );
  project.apply(
    { type: 'canvas.set', width: 640, height: 360 },
    { type: 'track.add', id: 'rough', name: 'Rough cut', mediaType: 'video' },
  );
  for (const [index, source] of args.entries()) {
    const { asset } = await project.importMedia(source);
    project.apply({
      type: 'clip.add',
      id: `shot-${index + 1}`,
      assetId: asset.id,
      trackId: 'rough',
      at: index * 30,
      in: 0,
      out: 30,
    });
  }
  return { shots: project.inspect().clips.length };
};

export default roughCut;
