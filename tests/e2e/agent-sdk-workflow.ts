import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProject, openProject } from '@opencut/sdk';

const file = 'cut.opencut.json';
const editor = await createProject(file, {
  name: 'SDK rough cut',
  settings: {
    width: 160,
    height: 90,
    frameRate: { numerator: 30, denominator: 1 },
  },
});
assert.equal((await editor.save()).revision, 0);
const stale = await openProject(file);
const { project } = editor;
assert.equal(project.inspect().revision, 0);
assert.equal(project.inspect().clips.length, 0);

const camera = (await project.importMedia('media/camera.mp4')).asset.id;
const logo = (await project.importMedia('media/logo.png')).asset.id;
const music = (await project.importMedia('media/music.wav')).asset.id;
project.apply(
  { type: 'track.add', id: 'main', mediaType: 'video', name: 'Camera' },
  { type: 'track.add', id: 'top', mediaType: 'video', name: 'Logo' },
  { type: 'track.add', id: 'bed', mediaType: 'audio', name: 'Music' },
  {
    type: 'clip.add',
    id: 'take',
    trackId: 'main',
    assetId: camera,
    at: 0,
    in: 0,
    out: 75,
  },
  { type: 'clip.trim', id: 'take', in: 15 },
  { type: 'clip.split', id: 'take', at: 30, rightId: 'take-right' },
  {
    type: 'clip.add',
    trackId: 'top',
    assetId: logo,
    at: 15,
    in: 0,
    out: 30,
    visual: { scale: 0.25 },
  },
  {
    type: 'clip.add',
    trackId: 'bed',
    assetId: music,
    at: 0,
    in: 0,
    out: 60,
    volume: 0.25,
  },
);
const planned = project.inspect();
assert.throws(() =>
  project.apply(
    { type: 'clip.audio', id: 'take', muted: true },
    { type: 'clip.split', id: 'take-right', at: 30 },
  ),
);
assert.deepEqual(project.inspect(), planned);
assert.equal(project.inspectTimeline(30).visualClips[0]?.id, 'take-right');

const original = await readFile(file);
assert.equal((await editor.save({ dryRun: true })).revision, 1);
assert.deepEqual(await readFile(file), original);
const sheet = await project.previewContactSheet(
  [14, 15, 29, 30, 44, 45],
  'sheet.png',
  {
    columns: 3,
    maxDimension: 160,
  },
);
assert.equal(sheet.columns, 3);
assert.equal(sheet.rows, 2);
assert.equal((await project.previewFrame(30, 'review.png')).width, 160);
assert.deepEqual(await readFile(file), original);

const saved = await editor.save({ label: 'Trim, split and layer the cut' });
assert.equal(saved.revision, 1);
stale.project.apply({ type: 'canvas.set', backgroundColor: '#123048' });
const committed = await readFile(file);
await assert.rejects(stale.save(), { code: 'REVISION_CONFLICT' });
assert.deepEqual(await readFile(file), committed);

const reopened = await openProject(file, { expectedRevision: saved.revision });
assert.equal(reopened.project.history().undo.length, 1);
assert.equal((await reopened.project.render('final.mp4')).frameCount, 60);
await assert.rejects(
  reopened.project.render('final.mp4'),
  /Refusing to overwrite/,
);
assert.deepEqual(await readFile(file), committed);
