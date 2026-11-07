import { createProject } from '@opencut/sdk';

const [path, image] = process.argv.slice(2);
if (!path || !image)
  throw new Error('Usage: node title-card.ts <new-project.json> <image>');

const editor = await createProject(path, {
  name: 'Title card',
  settings: {
    width: 640,
    height: 360,
    frameRate: { numerator: 30, denominator: 1 },
  },
});
const { project } = editor;
const { asset } = await project.importMedia(image);
project.apply(
  { type: 'track.add', id: 'titles', name: 'Titles', mediaType: 'video' },
  {
    type: 'clip.add',
    id: 'intro',
    assetId: asset.id,
    trackId: 'titles',
    at: 0,
    in: 0,
    out: 45,
    visual: { fit: 'contain' },
  },
);
console.log(JSON.stringify(await editor.save({ label: 'Build title card' })));
