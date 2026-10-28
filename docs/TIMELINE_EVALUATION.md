# Timeline evaluation (T23)

`@opencut/core` exports `evaluateTimeline(project, rationalTime)` and
`evaluateTimelineFrame(project, frameIndex)`. Both return JSON-compatible derived
intent from the existing project model and validate the project, including history.
They perform no I/O, decoding, edits, caching or playback. Call them on the current
T22 session snapshot; they do not acquire writer ownership or read disk themselves.
No new CLI command or project schema is introduced.

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

| Field              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `time`, `duration` | Requested time and greatest clip end, in rational seconds.                 |
| `boundary`         | `inside` before duration, `end` exactly at duration, `after` beyond it.    |
| `activeClips`      | All clips containing the query, in track order.                            |
| `visualClips`      | Active video-track clips, including images and zero-opacity clips.         |
| `audioClips`       | Active clips with present or unknown audio, including muted clips.         |
| `mixingSources`    | Audio candidates whose effective volume is greater than zero.              |
| `gap`, `visualGap` | No active clips, or no active opacity-positive visual clips, respectively. |
| `backgroundColor`  | Stored canvas background, defaulting to `#000000`.                         |

Each `EvaluatedTimelineClip` retains the stored clip fields and adds `duration`,
`timelineEnd`, `trackIndex`, `trackType`, `kind`, `sourceTime`, `visible`,
`audioPresence` and `effectiveVolume`. Its visual properties, volume and mute have
explicit defaults. `kind` identifies the evaluated role: a video asset used on an
audio track is reported as audio. The types are exported from `@opencut/core`.
These results are derived values, not project fields to save back into the JSON.
Mutating a returned clip does not modify the input project.

For example, a clip at timeline second 2 with source range `[5, 7)` is active at
second 2 with source time 5 and at second 3 with source time 6. At second 4 it is
inactive. A following clip starting at second 4 alone owns that shared boundary.

## Time and ordering

A clip occupies `[timelineStart, timelineStart + sourceOut - sourceIn)`.
Its source time is `sourceIn + time - timelineStart`, at unit speed. Source out is
exclusive. Trim leaves timeline start fixed; split assigns the boundary solely to
the right clip; moving preserves source points. Same-track overlaps remain invalid;
cross-track overlaps are evaluated together. Results follow track array order then
exact timeline start. `trackIndex` includes audio and empty tracks; later video
tracks are above earlier ones. No priority depends on clip array order.

Times use existing safe-integer rationals and bigint intermediate arithmetic.
Frame queries multiply the absolute frame index by the project frame period;
there is no floating-point accumulation or conversion through source FPS. Mixed
source rates do not change source-time mapping. This is a request for a media
instant, not a decoded source-frame index; VFR sampling remains a decoder concern.
Negative/invalid times and unsafe arithmetic throw instead of clamping or rounding.
Exact subframe queries are supported.

Duration is the greatest clip end, including muted, transparent and audio-only
clips. The boundary is `inside`, `end`, or `after`; empty projects end at zero.
There are no active clips at or after the end. `gap` means no active clips;
`visualGap` means no opacity-positive visual clips. Audio tails therefore retain
the project background. These flags also hold outside the project; inspect
`boundary` to distinguish an interior gap from completion.

## Visual and audio intent

Visual defaults are centered pixel offsets x/y 0, scale/opacity 1 and contain fit.
The existing renderer defines fitting, source alpha and canvas clipping. `visible`
means a video-track clip has positive opacity; it does not test offscreen geometry,
occlusion, missing media or decoded alpha. Transparent clips remain in visualClips.
Image metadata identifies stills; absent metadata conservatively means video.
Stills retain their logical source time/range for trim/split consistency; decoders
hold the still image regardless of that time. The project model has no stored visibility flag.

Volume defaults to 1, mute to false. Effective volume is zero for mute or known
absent audio. Opacity does not mute audio. `audioPresence` uses saved metadata;
missing metadata means unknown, even when mediaTypes only lists video (legacy
video assets can carry original audio). `audioClips` includes present/unknown
sources, including muted sources; `mixingSources` further excludes zero effective
gain. Audio-track entries retain trackType so consumers can require a stream.
Unknown sources are candidates, not a guarantee of audible media. Metadata can be
stale: adapters must probe actual streams. The evaluator does not normalize gains,
limit samples, account for stream delays or claim that candidate-free audio is the
only possible silence. Existing export sums gains and applies its safety limiter.

## Export integration and limits

Point evaluation and `planProjectRender` share resolved clip ranges, ordering and
property defaults. Export still probes all referenced streams, including optional
video audio, and keeps existing integer project-grid, dimensions, duration and
clip-count limits. Evaluation itself has none of those export-specific limits.
Off-grid source/timeline boundaries evaluate exactly but still fail export rather
than round. Existing FFmpeg project-rate sampling before trimming, still looping,
stream origins and 48 kHz sample rounding are unchanged. No intentional export
semantic change is introduced.

`evaluateTimeline` and `evaluateTimelineFrame` validate and resolve a fresh snapshot
on each call. `createTimelineEvaluator(project)` instead validates/resolves once
and returns a timestamp-query function with identical results. It binary-searches
nonoverlapping clips per track and returns detached values. Recreate it after
edits; mutating the original project or an earlier result does not update it.
`resolveTimeline(project)` also exposes validated ordered clip ranges/defaults
without a point query for adapters that need lookahead.

The desktop [T24 playback adapter](TIMELINE_PLAYBACK.md) uses this prepared
T23 evaluator as its authoritative mapping. Decoding, clock and audio routing
stay in desktop; evaluation itself remains headless and does no I/O or playback.
