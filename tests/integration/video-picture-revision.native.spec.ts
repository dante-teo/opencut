import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureDirectory } from '../fixture-paths.js';
import { runTool } from '../../scripts/fixture-lib.js';

const entry = fileURLToPath(
  new URL('../../apps/cli/dist/index.js', import.meta.url),
);
const large = process.env.OPENCUT_HAT_FIXTURE_4K === '1';
const width = large ? 2160 : 108;
const height = large ? 3840 : 192;
const span = (startFrame: number, endFrame: number) => ({
  startFrame,
  endFrame,
});

test(
  'locate, compare, replace and splice the take at 9.2 seconds',
  { timeout: 900_000 },
  async () => {
    await mkdir(fixtureDirectory, { recursive: true });
    const directory = await mkdtemp(join(fixtureDirectory, 'hat-revision-'));
    const path = (file: string) => join(directory, file);
    const cache = path('recipes');
    function opencut(args: string[], status = 0, readOnly = false) {
      const nodeArgs = [entry, ...args, '--json'];
      const result =
        readOnly && process.platform === 'darwin'
          ? spawnSync(
              '/usr/bin/sandbox-exec',
              [
                '-p',
                '(version 1)(allow default)(deny file-write*)',
                process.execPath,
                ...nodeArgs,
              ],
              { encoding: 'utf8', timeout: 600_000 },
            )
          : spawnSync(process.execPath, nodeArgs, {
              encoding: 'utf8',
              timeout: 600_000,
            });
      assert.equal(
        result.status,
        status,
        result.error?.message || result.stderr || result.stdout,
      );
      return JSON.parse(
        result.stdout || result.stderr.trim().split('\n').at(-1)!,
      );
    }
    function ffmpeg(...args: string[]) {
      runTool('ffmpeg', ['-v', 'error', '-nostdin', '-n', ...args]);
    }
    const draft = (name: string, definition: unknown) =>
      writeFile(
        path(name),
        'export default ' + JSON.stringify(definition) + ';\n',
      );
    try {
      const dimensions = large ? '540x960' : '108x192';
      for (const [name, source] of [
        ['plate', `testsrc2=s=${dimensions}:r=60:d=30`],
        ['soft', `smptebars=s=${dimensions}:r=30:d=4,gblur=sigma=4`],
        ['sharp', `smptebars=s=${dimensions}:r=60:d=4`],
      ])
        ffmpeg(
          '-f',
          'lavfi',
          '-i',
          source!,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-threads',
          '2',
          path(name + '.mp4'),
        );
      ffmpeg('-f', 'lavfi', '-i', 'sine=f=375:r=48000:d=30', path('music.wav'));
      ffmpeg(
        '-i',
        path('sharp.mp4'),
        '-f',
        'lavfi',
        '-i',
        'sine=f=120:r=48000:d=4',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        path('sharp-audio.mp4'),
      );

      await writeFile(
        path('Spark.tsx'),
        'export default () => <svg width="108" height="192"><circle cx="30" cy="30" r="10" fill="red" /></svg>;\n',
      );
      const definition = {
        canvas: { width, height, frameRate: 60, durationFrames: 1730 },
        assets: {
          plate: { kind: 'video', path: 'plate.mp4' },
          soft: {
            kind: 'video',
            path: 'soft.mp4',
            recipe: [
              { type: 'interpolateFrames', numerator: 60, quality: 'fast' },
            ],
          },
          sharp: { kind: 'video', path: 'sharp-audio.mp4' },
          music: { kind: 'audio', path: 'music.wav' },
          sparkle: {
            kind: 'graphic',
            renderer: 'react',
            path: 'Spark.tsx',
            durationFrames: 24,
            width: 108,
            height: 192,
          },
        },
        tracks: [
          {
            id: 'shots',
            type: 'video',
            clips: [
              { id: 'opening', asset: 'plate', at: 0, sourceOut: 552 },
              {
                id: 'hat',
                asset: 'soft',
                at: 552,
                sourceIn: 75,
                sourceOut: 155,
                visual: {
                  fit: 'cover',
                  crop: { left: 0.02, right: 0.02, top: 0, bottom: 0 },
                },
              },
              {
                id: 'closing',
                asset: 'plate',
                at: 632,
                sourceIn: 632,
                sourceOut: 1730,
              },
            ],
          },
          {
            id: 'overlay',
            type: 'video',
            clips: [{ id: 'spark', asset: 'sparkle', at: 90, sourceOut: 24 }],
          },
          {
            id: 'soundtrack',
            type: 'audio',
            audioRole: 'music',
            clips: [{ id: 'bed', asset: 'music', at: 12, sourceOut: 1718 }],
          },
        ],
        subtitles: {
          style: { fontSize: 14 },
          cues: [
            {
              id: 'note',
              start: { numerator: 6, denominator: 1 },
              end: { numerator: 7, denominator: 1 },
              text: 'Original caption',
            },
            {
              id: 'other-caption',
              start: { numerator: 2, denominator: 1 },
              end: { numerator: 3, denominator: 1 },
              text: 'Unedited caption',
            },
          ],
        },
      };
      const baseline = path('baseline.video.ts');
      const revised = path('revised.video.ts');
      const mp4 = path('baseline.mp4');
      const report = path('baseline.render.json');
      await draft('baseline.video.ts', definition);
      const inspect = [
        'timeline',
        'inspect',
        baseline,
        '--timestamp',
        '9.2',
        '--recipe-cache',
        cache,
      ];
      const metadata = opencut([...inspect, '--metadata-only'], 0, true);
      assert.equal(metadata.frame, 552);
      assert.equal(metadata.mode, 'metadata-only');
      assert.equal(metadata.visualClips[0].assetId, 'soft');
      assert.deepEqual(metadata.visualClips[0].sourceTime, {
        numerator: 5,
        denominator: 4,
      });
      assert.deepEqual(
        await readdir(directory),
        [
          'Spark.tsx',
          'baseline.video.ts',
          'music.wav',
          'plate.mp4',
          'sharp-audio.mp4',
          'sharp.mp4',
          'soft.mp4',
        ].sort(),
      );
      if (process.platform === 'darwin') {
        const denied = opencut(inspect, 1, true);
        assert.match(denied.error.message, /--metadata-only/);
        assert.ok(denied.error.message.includes(cache), denied.error.message);
        assert.match(denied.error.message, /soft/);
      }
      const exact = opencut(inspect);
      assert.equal(exact.mode, 'resolved');
      assert.equal(exact.visualClips[0].source.originalPath, path('soft.mp4'));
      assert.equal(
        exact.visualClips[0].source.steps[0].parameters.type,
        'interpolateFrames',
      );

      const renderArgs = [
        '--recipe-cache',
        cache,
        '--codec',
        'hevc',
        '--quality',
        'fast',
        '--keyframe-interval',
        '12',
        '--revision-evidence',
      ];
      const started = performance.now();
      const original = opencut([
        'render',
        baseline,
        '--output',
        mp4,
        ...renderArgs,
      ]);
      const baselineSeconds = (performance.now() - started) / 1000;
      assert.equal(original.frameCount, 1730);
      await writeFile(report, JSON.stringify(original));
      const review = opencut([
        'review',
        mp4,
        '--source-comparison',
        '--definition',
        baseline,
        '--timestamp',
        '9.2',
        '--source-clip',
        'hat',
        '--render-report',
        report,
        '--recipe-cache',
        cache,
        '--output',
        path('source-review'),
      ]);
      assert.equal(review.mapping.status, 'verified');
      assert.equal(review.sources.original.video.frameRate, 30);
      assert.equal(review.sources.processed.video.frameRate, 60);
      assert.equal(review.assetId, 'soft');
      assert.match(
        await readFile(path('source-review/index.html'), 'utf8'),
        /Delivered picture/,
      );

      if (!large) {
        const mapping = path('source-mapping.json');
        await writeFile(
          mapping,
          JSON.stringify({
            clipId: 'hat',
            projectStartFrame: 552,
            deliveryStartFrame: 552,
          }),
        );
        const args = [
          'review',
          mp4,
          '--source-comparison',
          '--definition',
          baseline,
          '--timestamp',
          '9.2',
          '--recipe-cache',
          cache,
          '--output',
          path('manual-review'),
        ];
        assert.match(opencut(args, 1).error.message, /--source-mapping/);
        assert.equal(
          opencut([...args, '--source-mapping', mapping]).mapping.status,
          'unverified',
        );
      }

      const patch = async (
        asset: string,
        sourceIn: number,
        output?: string,
        status = 0,
        audio?: 'mute',
      ) => {
        const file = path('take-patch.json');
        await writeFile(
          file,
          JSON.stringify({
            operations: [
              {
                operation: 'replace-source',
                id: 'hat',
                asset,
                sourceIn,
                ...(audio && { audio }),
              },
            ],
          }),
        );
        return opencut(
          [
            'timeline',
            'patch',
            baseline,
            '--edit',
            file,
            ...(output ? ['--output', output] : ['--dry-run']),
          ],
          status,
        );
      };
      assert.match(
        (await patch('missing', 75, undefined, 1)).error.message,
        /declared timed video asset/,
      );
      assert.match(
        (await patch('sharp', 230, undefined, 1, 'mute')).error.message,
        /duration/,
      );
      assert.match(
        (await patch('sharp', 90, undefined, 1)).error.message,
        /embedded audio/,
      );
      const edit = await patch('sharp', 90, revised, 0, 'mute');
      assert.deepEqual(edit.operations[0].after, span(552, 632));
      assert.equal(edit.operations[0].replacement.embeddedAudio, 'mute');
      assert.equal(edit.duration.deltaFrames, 0);
      const revise = (file: string, output: string, renderReport = report) => [
        'render',
        file,
        '--picture-from',
        mp4,
        '--render-report',
        renderReport,
        '--output',
        output,
        '--recipe-cache',
        cache,
      ];
      const delivery = path('revised.mp4');
      const preflight = opencut(
        [...revise(revised, delivery), '--preflight'],
        0,
        true,
      );
      assert.equal(preflight.status, 'eligible');
      assert.deepEqual(preflight.changedRanges, [span(552, 632)]);
      assert.deepEqual(preflight.encodeRanges, [
        { ...span(552, 636), action: 'encode' },
      ]);
      if (!large) {
        const chained = path('replace-then-trim.json');
        await writeFile(
          chained,
          JSON.stringify({
            operations: [
              {
                operation: 'replace-source',
                id: 'hat',
                asset: 'plate',
                sourceIn: 220,
              },
              {
                operation: 'trim',
                id: 'hat',
                sourceOut: 320,
                placement: 'ripple',
              },
            ],
          }),
        );
        const dryRun = opencut([
          'timeline',
          'patch',
          baseline,
          '--edit',
          chained,
          '--dry-run',
        ]);
        assert.deepEqual(dryRun.operations[1].source.after, span(220, 320));
        assert.equal(dryRun.operations[1].source.availableThroughFrame, 1800);
        assert.equal(dryRun.duration.deltaFrames, 20);
      }
      const shotStarted = performance.now();
      const result = opencut(revise(revised, delivery));
      const shotSeconds = (performance.now() - shotStarted) / 1000;
      assert.equal(result.frameCount, 1730);
      assert.equal(result.verification.audioIdentity.passed, true);
      assert.deepEqual(result.verification.joins, [552, 636]);
      assert.deepEqual(
        result.verification.joinSamples.map(
          ({ frame }: { frame: number }) => frame,
        ),
        [551, 552, 635, 636],
      );
      assert.equal(result.verification.completeDecode, true);
      const crop = opencut([
        'preview',
        'contact-sheet',
        delivery,
        '--frames',
        '551,552,592,631,635,636',
        '--output',
        path('joins.png'),
      ]);
      assert.equal(crop.samples.length, 6);
      if (!large) {
        const deliveryReport = path('revised.render.json');
        await writeFile(deliveryReport, JSON.stringify(result));
        const sheet = opencut([
          'preview',
          'contact-sheet',
          delivery,
          '--render-report',
          deliveryReport,
          '--around',
          'cuts,captions,picture',
          '--from',
          '350',
          '--to',
          '645',
          '--output',
          path('report-sheet.png'),
        ]);
        const samples = new Map<number, string[]>(
          sheet.samples.map(
            ({
              frame,
              requests,
            }: {
              frame: number;
              requests: { reason: string }[];
            }) => [frame, requests.map(({ reason }) => reason)],
          ),
        );
        assert.ok(samples.get(360)?.includes('caption-start'));
        assert.ok(samples.get(552)?.includes('cut'));
        assert.ok(samples.get(636)?.includes('picture-boundary'));
      }

      function decoded(file: string, frames: number[]) {
        return runTool('ffmpeg', [
          '-v',
          'error',
          '-i',
          file,
          '-an',
          '-vf',
          'select=' +
            frames.map((frame) => `eq(n\\,${frame})`).join('+') +
            ',scale=108:192',
          '-fps_mode',
          'passthrough',
          '-f',
          'framemd5',
          '-',
        ])
          .split('\n')
          .filter((line) => line && !line.startsWith('#'))
          .map((line) => line.split(',').at(-1)!.trim());
      }
      const changedSamples = [552, 592, 631];
      const previous = decoded(mp4, changedSamples);
      const next = decoded(delivery, changedSamples);
      assert.equal(next.length, 3);
      assert.ok(next.every((hash, i) => hash !== previous[i]));
      assert.deepEqual(decoded(delivery, [551, 636]), decoded(mp4, [551, 636]));

      const caption = path('caption.video.ts');
      const captionEdit = path('caption-patch.json');
      await writeFile(
        captionEdit,
        JSON.stringify({
          operations: [
            { operation: 'caption', id: 'note', text: 'Corrected caption' },
          ],
        }),
      );
      opencut([
        'timeline',
        'patch',
        baseline,
        '--edit',
        captionEdit,
        '--output',
        caption,
      ]);
      const captionStarted = performance.now();
      const captionResult = opencut(revise(caption, path('caption.mp4')));
      const captionSeconds = (performance.now() - captionStarted) / 1000;
      assert.deepEqual(captionResult.preflight.changedRanges, [span(360, 420)]);
      assert.equal(captionResult.verification.audioIdentity.passed, true);
      if (!large) {
        const stale = structuredClone(original);
        const layer = stale.revisionEvidence.timeline.picture.find(
          ({ id }: { id: string }) => id === 'other-caption',
        );
        assert.match(layer.rasterKey, /^[0-9a-f]{64}$/);
        // Simulate a different font fallback for an otherwise unchanged cue.
        layer.rasterKey = (layer.rasterKey[0] === '0' ? '1' : '0').repeat(64);
        const staleReport = path('different-font.render.json');
        await writeFile(staleReport, JSON.stringify(stale));
        const fontPreflight = opencut([
          ...revise(caption, path('font.mp4'), staleReport),
          '--preflight',
        ]);
        assert.deepEqual(fontPreflight.changedRanges, [
          span(120, 180),
          span(360, 420),
        ]);
        assert.ok(
          fontPreflight.encodeRanges.some(
            ({
              startFrame,
              endFrame,
            }: {
              startFrame: number;
              endFrame: number;
            }) => startFrame <= 120 && endFrame >= 180,
          ),
        );

        const mixDefinition = structuredClone(definition);
        const audio = mixDefinition.tracks.find(
          ({ id }) => id === 'soundtrack',
        )!;
        Object.assign(audio.clips[0]!, { volume: 0.5 });
        await draft('audio.video.ts', mixDefinition);
        const changedMix = opencut(
          revise(path('audio.video.ts'), path('audio.mp4')),
        );
        assert.equal(changedMix.preflight.audio, 'render');
        assert.equal(changedMix.preflight.framesToEncode, 0);
        assert.equal(changedMix.verification.completeDecode, true);
      }
      const blockedReport = path('incompatible.render.json');
      await writeFile(
        blockedReport,
        JSON.stringify({
          ...original,
          revisionEvidence: {
            ...original.revisionEvidence,
            settings: {
              ...original.revisionEvidence.settings,
              encoder: 'software',
              keyframeInterval: 240,
            },
          },
        }),
      );
      const rejectedAt = performance.now();
      const blocked = opencut(
        [...revise(revised, path('unsafe.mp4'), blockedReport), '--preflight'],
        1,
      );
      const blockedSeconds = (performance.now() - rejectedAt) / 1000;
      assert.equal(blocked.status, 'blocked');
      assert.match(blocked.reasons.join(' '), /settings|encoder/);
      console.log(
        JSON.stringify({
          dimensions: [width, height],
          baselineSeconds,
          revisions: [result, captionResult].map(
            ({ seconds, preflight }, i) => ({
              seconds: [shotSeconds, captionSeconds][i],
              renderSeconds: seconds,
              encoded: preflight.framesToEncode,
              reusedBytes: preflight.reusedBytes,
            }),
          ),
          blocked: { seconds: blockedSeconds, encoded: 0, reusedBytes: 0 },
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
