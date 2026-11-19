# Professional Dialogue Mix

Enable the mixer by adding `professionalMix` to a `.video.ts` definition. Assign `audioRole: 'dialogue'` to spoken tracks and `audioRole: 'music'` to music tracks. Audio and video tracks both support roles. Unassigned tracks and tracks marked `other` retain their original mix routing. Authored mute, gain, fades, effects and playback speed still apply.

**Natural Cinematic Dialogue** uses lighter cleanup and dynamics processing suitable for interviews and narrative work. **Clear Professional Voiceover** uses stronger cleanup, presence, consistency and music ducking.

In OpenCut Review, select **Create dialogue mix** to choose dialogue recordings,
optional music and an optional picture. The import writes a new definition
that references your original files. Open **Professional Dialogue Mix** to
adjust routing and settings, then select **Apply to preview**.

**Compare before** targets the last applied mix’s measured loudness when
playing the original mix and honors the delivery true-peak ceiling.
**Compare after** returns to the applied mix. Both preserve your draft edits. **Export MP4** renders the
applied mix even while **Compare before** is playing.

Switch off **Enable mix** and apply to bypass processing. **Reset to definition**
restores the settings from the authored file. **Save mix settings** writes the
current draft to JSON. Use **Load mix settings** followed by **Apply to preview**
to use it in OpenCut Review, or pass the JSON to the CLI or SDK.

## Definition

```ts
import { defineVideo } from '@dantea/opencut/sdk';

export default defineVideo({
  canvas: { width: 1920, height: 1080, frameRate: 30, durationFrames: 300 },
  assets: {
    spoken: { path: 'voice.wav', kind: 'audio' },
    score: { path: 'music.flac', kind: 'audio' },
  },
  tracks: [
    {
      id: 'speech',
      type: 'audio',
      audioRole: 'dialogue',
      clips: [{ id: 'voice-take', asset: 'spoken', at: 30, sourceOut: 210 }],
    },
    {
      id: 'music',
      type: 'audio',
      audioRole: 'music',
      volume: 0.5,
      clips: [{ asset: 'score', at: 0, sourceOut: 300 }],
    },
  ],
  professionalMix: {
    preset: 'natural-cinematic',
    cleanup: 0.45,
    clarity: 0.35,
    ducking: { depthDb: 12, attackMs: 180, holdMs: 300, releaseMs: 700 },
    delivery: { preset: 'broadcast' },
  },
});
```

## Advanced settings

| Field                                         | Behavior                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preset`, `enabled`                           | Choose `natural-cinematic` or `clear-voiceover`. Use `enabled: false` to bypass the mixer and delivery processing.                                                                                                                                            |
| `cleanup`, `warmth`, `clarity`, `consistency` | Intensities from 0 to 1. Cleanup adapts spectral reduction to estimated floor and applies gentle downward expansion. The leveling intensity scales gain corrections in detected phrases.                                                                      |
| `highPassHz`, `eq`, `deEsser`                 | High-pass cutoff in Hz (0–250, 0 disables it), up to eight parametric EQ bands (`frequency`, `q`, `db`), and de-essing intensity (0–1).                                                                                                                       |
| `compressor`                                  | Set `thresholdDb`, `ratio`, `attackMs`, `releaseMs`. A ratio of 1 bypasses compression. Limiting and delivery headroom remain active.                                                                                                                         |
| `dialogueLufs`, `matching`                    | Set the internal phrase target or let the preset choose. `matching.amount` (0–1) scales tonal matching. Set `matching.referenceClip` to the ID of an audible dialogue clip to use its tone and inform the default leveling target.                            |
| `crossfadeMs`                                 | Range 0–250 ms. Adjacent same-track dialogue clips use available source handles for equal-power overlap. OpenCut keeps the incoming dialogue in sync with its picture. When handles are unavailable it uses short edge fades. Authored fades take precedence. |
| `ducking`                                     | `depthDb` (0–36), `attackMs` (20–2000), `holdMs` (0–5000) and `releaseMs` (50–5000). The music bus starts fading ahead of detected speech and stays down through short pauses.                                                                                |
| `ai`, `dereverb`                              | `ai: 'deepfilternet'` selects local speech enhancement in place of spectral noise reduction. `dereverb` (0–1) attenuates low-level tails and can reduce light room sound. Strong reflections overlapping speech may remain.                                   |
| `delivery`                                    | Choose a delivery preset and optionally override `integratedLufs` (−40 to −8), `truePeakDbtp` (−8 to −0.1) and `loudnessRange` (1–50 LU).                                                                                                                     |
| `automation`                                  | Save or edit the generated `dialogue` and `music` curves.                                                                                                                                                                                                     |

Detection uses short K-weighted energy windows on tracks assigned to dialogue.
A brief phrase that rises clearly above steady room tone can trigger ducking
even when most of the clip is quiet. Overlapping speech from multiple dialogue
tracks contributes to the shared music curve. For whispers or other sounds near
the estimated noise floor, fine-tune the generated curves or author them directly.

The mixer reports `automation.dialogue` by clip ID and `automation.music` for the
whole music bus. Each point is `{ sample, db }` on a 48 kHz clock. Dialogue
samples are relative to the clip’s authored timeline start. Music samples are
relative to the start of the project. Keys interpolate in dB and hold the
closest value outside the key range. Supply a curve to replace automatic
analysis for that clip or bus. Supply `[]` to disable that curve. Omit the entry
to regenerate it. The mixer combines these curves with the original fades and
gain keys.

To reuse the generated curves, copy the report’s `automation` object into
`professionalMix.automation` in the definition or `mix.automation` in a mix
settings file. In OpenCut Review, select **Use analyzed curves** under
**Advanced settings and automation** to copy the curves into the draft.

## Delivery and inspection

| Delivery  | Integrated target | True-peak ceiling | Loudness range target |
| --------- | ----------------: | ----------------: | --------------------: |
| Web       |          −16 LUFS |         −1.5 dBTP |                 12 LU |
| Broadcast |          −23 LUFS |           −1 dBTP |                 15 LU |
| Film      |          −24 LUFS |           −2 dBTP |                 20 LU |

OpenCut measures integrated loudness, loudness range and true peak, applies gain or second-pass dynamic normalization as needed, then checks true peak on decoded AAC. The render report contains the measured input and output, targets, normalization mode and any loudness deviations. Very short or silent mixes may lack a measurable integrated value. The peak ceiling takes precedence when the configured goals compete. Composition and delivery use the same full timeline in preview and export. A range preview trims the normalized audio to the requested interval. AAC output supports mono or stereo, 44.1 or 48 kHz, using FFmpeg’s normal channel conversion for other input layouts.

```sh
opencut mix analyze lesson.video.ts --json
opencut render lesson.video.ts --output lesson.mp4 --json
opencut render lesson.video.ts --output comparison.mp4 --mix-comparison before
opencut preview clip lesson.video.ts --from 30 --to 150 --output preview.mp4
opencut render lesson.video.ts --output revision.mp4 --mix-settings mix.json
```

`mix analyze` reports the same data as `render --json` without composing or encoding picture. `--mix-settings` accepts `{ "mix": { "preset": "natural-cinematic" }, "roles": { "speech": "dialogue" } }`. Set `mix` to `null` to render through the standard audio path. The settings file does not change the source definition. `--mix-comparison before` produces the loudness-matched original mix. The same controls apply to `preview --watch` and `preview clip`.

```ts
import {
  analyzeVideoMix,
  compileVideo,
  renderCompiledVideo,
} from '@dantea/opencut/sdk';

const video = await compileVideo('lesson.video.ts');
const report = await analyzeVideoMix(video);
const rendered = await renderCompiledVideo(video, 'lesson.mp4');
console.log(report.automation, rendered.audioMix?.output);
```

Pass `audioMixEdit` to `compileVideo` or `renderVideo` for the same JSON override. Set `audioComparison: 'before'` on analysis, render or clip preview for A/B playback.

## Local enhancement and caching

The two presets require only OpenCut’s existing FFmpeg installation. To enable [DeepFilterNet](https://github.com/Rikorose/DeepFilterNet), install its native `deep-filter` executable separately. OpenCut uses it on local 48 kHz audio with compensation for its model delay. The executable can be on PATH or set via the absolute `OPENCUT_DEEPFILTER` path. Set `OPENCUT_DEEPFILTER_MODEL` to use a compatible local model archive when the executable lacks a built-in model or when choosing a different one. The mixer runs without network access. An explicitly selected backend that cannot run produces an error so the same settings do not silently render with a different backend.

OpenCut reuses analyzed clip profiles within a process. For persistent AI-enhanced stems, pass `--mix-cache <directory>` to CLI commands or `audioMixCacheDirectory` to SDK analysis, render and video preview. Desktop previews reuse enhanced stems during an open review session. Cached stems contain processed audio. Keep the cache private when working with private recordings and remove it when it is no longer needed.
