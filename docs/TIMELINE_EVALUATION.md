# Timeline evaluation (T23)

`@opencut/core` exports `evaluateTimeline(project, rationalTime)` and
`evaluateTimelineFrame(project, frameIndex)`. Both return JSON-compatible derived
intent from the existing project model and validate the project, including history.
They perform no I/O, decoding, edits, caching or playback. Call them on the current
T22 session snapshot; they do not acquire writer ownership or read disk themselves.
T23 introduced no CLI command or project schema. T29 exposes these point queries
through `timeline inspect`; see [CLI inspection](CLI.md#agent-discovery-and-visual-inspection-t29).

```ts
import { evaluateTimeline, evaluateTimelineFrame } from '@opencut/core';

// project is a validated project or the current session snapshot.
const atOneSecond = evaluateTimeline(project, { numerator: 1, denominator: 1 });
const evaluation = evaluateTimelineFrame(project, 90);
// evaluation.visualClips: bottom-to-top layers at project frame 90
// evaluation.mixingSources: unmuted, nonzero-gain audio candidates
```

## Result contract

Both APIs return `TimelineEvaluation` and accept offline projects. Frame indices
are nonnegative safe integers on the project frame grid; timestamp queries accept
`RationalTime` in seconds. Neither API clamps a query to the project duration.

| Field              | Meaning                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `time`, `duration` | Requested time and greatest clip or subtitle cue end, in rational seconds.          |
| `boundary`         | `inside` before duration, `end` exactly at duration, `after` beyond it.             |
| `activeClips`      | Clips and derived subtitle layers active at the query, in track order.              |
| `visualClips`      | Ordered picture layers, including transition participants and zero-opacity samples. |
| `audioClips`       | Active clips with present or unknown audio, including muted clips.                  |
| `mixingSources`    | Audio candidates whose effective volume is greater than zero.                       |
| `gap`, `visualGap` | No active clips, or no active opacity-positive visual clips, respectively.          |
| `backgroundColor`  | Stored canvas background, defaulting to `#000000`.                                  |

Each `EvaluatedTimelineClip` retains the stored clip fields and adds `duration`,
`timelineEnd`, `trackIndex`, `trackType`, `kind`, `sourceTime`, `visible`,
`audioPresence` and `effectiveVolume`. Its visual properties, volume and mute have
explicit defaults. `kind` identifies the evaluated role: a video asset used on an
audio track is reported as audio. The types are exported from `@opencut/core`.
Text clips report `kind: "text"`, carry their stored typography and have absent
audio. Their source time expresses elapsed position in a static clip range.
Subtitle cues are derived text layers with `subtitle: true`. Their exact
timeline interval determines visibility, and their source time is always zero.
These results are derived values, not project fields to save back into the JSON.
Mutating a returned clip does not modify the input project.

For example, a clip at timeline second 2 with source range `[5, 7)` is active at
second 2 with source time 5 and at second 3 with source time 6. At second 4 it is
inactive. A following clip starting at second 4 owns that shared boundary in
`activeClips` and any audio result. A cross-dissolve can show both clips in
`visualClips` around the cut.

## Time and ordering

A clip occupies `[timelineStart, timelineStart + (sourceOut - sourceIn) / speed)`.
Its source time is `sourceIn + (time - timelineStart) × speed`. Omitted speed is 1.
The same exact mapping determines split source points and the common source
phase used for export. Sampling rounds to device precision when needed.
Persisted edits retain exact fractions. Source out is exclusive. Trim leaves timeline start fixed; split assigns the boundary solely to
the right clip; moving preserves source points. Same-track overlaps remain invalid;
cross-track overlaps are evaluated together. Results follow track array order then
exact timeline start. `trackIndex` includes audio and empty tracks; later video
tracks are above earlier ones. No priority depends on clip array order.
Nonempty subtitle cues occupy `[start, end)` above the regular video layers.
Overlapping cues stack upward. Lane heights stay fixed within a connected
overlap group, so a tall cue in a separate group leaves the later stack's
positions unchanged.

Times use existing safe-integer rationals and bigint intermediate arithmetic.
Frame queries multiply the absolute frame index by the project frame period;
there is no floating-point accumulation or conversion through source FPS. Mixed
source rates do not change source-time mapping. This is a request for a media
instant, not a decoded source-frame index; VFR sampling remains a decoder concern.
Negative/invalid times and unsafe arithmetic throw instead of clamping or rounding.
Exact subframe queries are supported. Within a transition window, the
evaluator samples the participating picture layers at the start of the
containing project frame. Each sample carries `transitionId` and its weighted
opacity, including zero-opacity endpoints. A cross-dissolve can sample source
handles outside nominal clip ranges. Use `audioClips` or `mixingSources` for
audio. Exact timestamp queries keep subtitle visibility on the cue's stored
interval even when the project contains transitions.

Duration is the greatest end across clips and subtitle cues, including muted,
transparent or audio-only clips and empty cues. The boundary is `inside`,
`end`, or `after`, with a zero duration for empty projects. Exact point
queries return an empty active layer list at and after the end. `gap` means
no active clips, while `visualGap` means no opacity-positive visual clips.
Audio tails therefore retain the project background. Use `boundary` to
distinguish an interior gap from completion.

## Visual and audio intent

Visual defaults are centered pixel offsets x/y 0, scale/opacity 1 and contain fit.
Omitted rotation means 0 degrees. For each keyed channel, the evaluator replaces
the static value with the exact clip-local sample at the query time. `visible`
uses evaluated opacity.
The existing renderer defines fitting, source alpha and canvas clipping. `visible`
means a video-track clip has positive opacity; it does not test offscreen geometry,
occlusion, missing media or decoded alpha. Transparent clips remain in visualClips.
Image metadata identifies stills; absent metadata conservatively means video.
Stills retain their logical source time/range for trim/split consistency; decoders
hold the still image regardless of that time. The project model has no stored visibility flag.

Clip and track volumes default to 1 and mute defaults to false.
`effectiveVolume` is the product of clip gain, track gain and the linear fade
at the queried clip-relative time. It is zero when either level is muted or
audio is known absent. Opacity affects picture independently. `audioPresence` uses saved metadata;
missing metadata means unknown, even when mediaTypes only lists video (legacy
video assets can carry original audio). `audioClips` includes present/unknown
sources, including muted sources; `mixingSources` further excludes zero effective
gain. Audio-track entries retain trackType so consumers can require a stream.
Unknown sources are candidates, not a guarantee of audible media. Metadata can be
stale: adapters must probe actual streams. The evaluator does not normalize gains,
limit samples, account for stream delays or claim that candidate-free audio is the
only possible silence. The standard mix sums gains and applies a safety limiter.
For Professional Dialogue Mix, the mix report includes the generated gain curves.
See [Professional Dialogue Mix](AUDIO_MIX.md).

## Export integration and limits

Point evaluation and `planProjectRender` share resolved clip ranges, ordering and
property defaults. Export still probes all referenced streams, including optional
video audio, and keeps existing integer project-grid, dimensions, duration and
clip-count limits. Evaluation itself has none of those export-specific limits.
Export requires frame-aligned title boundaries. The render plan places
media and subtitle boundaries at the first project tick at or after their
exact stored times. Preview and export sample subtitle visibility and animated transforms at
each project frame's start.

FFmpeg samples video at the project rate and loops still images. Export
uses stream origins and rounds audio boundaries on a 48 kHz grid. Contiguous
pieces of the same source with compatible speed and effects share a tempo pass.
Professional Dialogue Mix cuts the resulting dialogue into clip-local segments
for analysis and enhancement.
See [preview and export consistency](PREVIEW_EXPORT_CONSISTENCY.md).

`evaluateTimeline` and `evaluateTimelineFrame` validate and resolve a fresh snapshot
on each call. `createTimelineEvaluator(project)` instead validates and resolves
once, then returns a timestamp-query function with identical results. Pass
`true` as the second argument to sample subtitle visibility and animated transforms
on the project frame grid. The function binary-searches each nonoverlapping lane
and returns detached values, including stored keyframes. Recreate it after
edits; mutating the original project or an earlier result does not update it.
`resolveTimeline(project)` also exposes validated ordered clip ranges/defaults
without a point query for adapters that need lookahead.

Use `timeline inspect DEFINITION --frame N --json` for frame evaluation in
the CLI. See the [CLI overview](CLI.md) for composited output commands.
