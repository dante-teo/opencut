import type { OpenCutScript } from '@opencut/sdk';

const review: OpenCutScript = async ({ project, args, dryRun }) => {
  const [frame, png, mp4] = args;
  if (!frame || !/^\d+$/.test(frame) || !png || !mp4)
    throw new Error(
      'Pass a project frame, new .png path and new .mp4 path after --.',
    );
  const index = Number(frame);
  const timeline = project.inspectTimeline(index);
  if (dryRun) return { timeline };
  const preview = await project.previewFrame(index, png, { maxDimension: 320 });
  const video = await project.render(mp4, { quality: 'balanced' });
  return { timeline, preview, video };
};

export default review;
