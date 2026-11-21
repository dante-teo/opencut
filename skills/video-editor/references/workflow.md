# Definition workflow

Copy the bundled [opening card](../../../examples/video/opening-card.video.ts)
into a writable project as `edit.video.ts`. It is a complete definition with
an animated title and a timed Chinese caption. It requires no outside media.

```sh
opencut validate edit.video.ts --json
opencut preview frame edit.video.ts --frame 18 --output draft.png
opencut preview clip edit.video.ts --from 0 --to 48 --output draft.mp4
```

Open `draft.png` in an image viewer and play `draft.mp4`. Change the
title and cue timing in `edit.video.ts`, then generate a new preview.
Each command uses the saved definition. Use new output paths for revisions.

```sh
opencut preview contact-sheet edit.video.ts --from 0 --to 48 --count 4 --output revised.png
opencut render edit.video.ts --output final.mp4 --picture-cache ./render-cache --json > final.render.json
opencut preview contact-sheet final.mp4 --render-report final.render.json --around captions,picture --output final-qa.png
opencut probe final.mp4 --json
```

Review `final-qa.png` with its `final-qa.png.json` manifest. The render report
ties the requested boundary samples to the bytes of `final.mp4`. Add
`cuts` to `--around` for edits between clips, and use `--from` and `--to`
to narrow a range with more than 16 unique samples.

For footage with cuts, declare each source under `assets` and lay clips
back to back on a video track. Use `sourceIn` and exclusive `sourceOut` to
select the source range, and `at` to position it. Add overlays on higher
tracks and music on an audio track. Set clip fades and volume as needed.
Place captions in `subtitles.cues` using rational timeline seconds.
Use `grade` on footage and `keyframes` on visual clips. The
[definition guide](../../../docs/VIDEO_DEFINITIONS.md#author-a-definition)
lists the fields and timing units.

Review the last frame before each cut, the first frame of the next shot,
and the first and last frames of every caption. Check that glyphs, line
breaks, fades and motion read clearly at delivery size. For AI, use a
`--quality quality` preview to inspect the offline processor and compare
nearby frames with the source. For 4K, sample fine detail and motion at full
resolution. Play the final MP4 with audio and verify its cadence, duration
and streams before delivering it.
