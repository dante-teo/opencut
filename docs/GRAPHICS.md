# Graphics

Add static SVG and frame-driven React to a `.video.ts` definition with
`kind: 'graphic'`. A graphic is a transparent surface on an ordinary video
track. Place it above or below any other visual track and use the existing
fit, crop, position, scale, rotation, opacity, and outer keyframes.

## Install the optional React browser

React graphics require the pinned Chromium Headless Shell. Install it under
the account that runs the OpenCut CLI or Review app.

```sh
pnpm dlx playwright-core@1.64.1 install --only-shell chromium
opencut doctor --json
```

From a checkout, use `pnpm --filter @opencut/graphics exec playwright-core
install --only-shell chromium` after installing the workspace dependencies.
The `graphics.path` and `graphics.status` fields in `opencut doctor --json`
identify the shell executable and whether OpenCut can access it. If you see
`missing-browser` with a full Chromium build installed, run the shell install
command above. A preview frame also checks that the shell can start with its
platform sandbox. Static SVG and ordinary media render without a browser.

## Author a component

Save this component as `graphics/Headline.tsx`.

```tsx
import { graphicProgress, useGraphicTiming } from '@opencut/graphics/react';

export default function Headline({ title = '项目进度 / Project progress' }) {
  const { frame, durationFrames, height } = useGraphicTiming();
  const opacity =
    graphicProgress(frame, 0, 12) *
    (1 - graphicProgress(frame, durationFrames - 12, durationFrames - 1));
  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        bottom: '8%',
        maxWidth: '80%',
        background: '#102e2ad9',
        padding: '0.6em 0.9em',
        borderRadius: '0.5em',
        fontSize: height * 0.058,
        color: '#fff',
        opacity,
      }}
    >
      {title}
    </div>
  );
}
```

Reference its file path from the definition. Use asset props as defaults and
clip props for a specific placement. The clip replaces matching keys at the
top level, including complete nested objects and arrays.

```ts
import { defineVideo } from '@opencut/sdk';

export default defineVideo({
  version: 2,
  canvas: { width: 640, height: 360, frameRate: 24 },
  assets: {
    headline: {
      kind: 'graphic',
      renderer: 'react',
      path: './graphics/Headline.tsx',
      durationFrames: 120,
      props: { title: '项目进度 / Project progress' },
    },
  },
  tracks: [
    {
      type: 'video',
      clips: [
        {
          asset: 'headline',
          at: 24,
          sourceIn: 6,
          sourceOut: 120,
          props: { title: '研究结果 / Research results' },
        },
      ],
    },
  ],
});
```

Omit `width` or `height` to use the corresponding project canvas dimension.
The component always lays out at its logical size. The existing preview size
and output resolution controls scale the complete composition. Explicit
version 1 definitions accept the original media kinds. A definition with
graphics uses version 2 when `version` is omitted.

Animated graphics require `durationFrames` and an exclusive `sourceOut`.
At the placement above, timeline frame 24 samples source frame 6. Trimming
or splitting preserves the source offset and duration. Rational speed uses
the ordinary timeline mapping, then floors to an integer source frame.
Slow playback can repeat samples and fast playback can skip them. An output
FPS override resamples the finished composition. Outer visual keyframes
remain clip-local. Use opacity keyframes or component animation for graphics
entrances and exits.

## Runtime API and assets

For editor type checking with the published CLI package installed locally,
use `@dantea/opencut/graphics/react` and `@dantea/opencut/graphics/templates`.
Both paths use the same renderer and bundled React instance.

- `useGraphicFrame()` returns the source frame as an integer.
- `useGraphicTiming()` returns the frame, full source frame count, rational
  `frameRate`, source-local `seconds`, and logical `width` and `height`.
- `graphicProgress(frame, start, end)` returns eased 0–1 progress.
- Declare named files with `resources: { logo: 'media/logo.png', rows:
'graphics/rows.json' }`. Resolve those paths from the definition.
  `useGraphicResource('logo')` returns an image or font data URL.
  `useGraphicData('rows')` decodes declared JSON.
- TSX and JSX can import browser-compatible JS, TS, JSON, CSS, local images,
  SVG image resources, and TTF, OTF, WOFF and WOFF2 fonts. Relative imports and
  CSS URLs resolve from their importing module. Use CSS `@font-face` to pick
  a custom font. OpenCut provides a bundled Simplified Chinese fallback.
- Frame-driven JSX, CSS values, and inline SVG attributes determine the
  picture. Keep the output a pure function of props, resources and
  source-local timing. Use an explicit seed for pseudo-random effects.
  CSS animations and transitions are disabled. Timers, animated media,
  effects that change the picture after capture, and mutable global state
  are outside this contract.

React captures the committed tree and waits for fonts and image decoding.
Components run in an ephemeral offline Chromium context with a restricted
resource origin and no Node or Electron bridge. Compile and render graphics
from sources you trust. Errors from a component or its imported modules
include the original TSX or TS filename, line and column when a frame
location is available. Source maps travel with offline bundles.

## Anime.js motion graphics

Use the existing React asset with `animation: { version: 1 }` to opt into
the host-controlled Anime.js 4.5.0 runtime. This surface uses the project
frame rate, whole-frame clip boundaries, a finite source duration, and normal
playback speed. Its first valid source frame is 0 and its last is
`durationFrames - 1`. At project frame `f`, an active clip samples
`sourceIn + f - at`. Trimming narrows that range and splitting preserves the
source frame sequence. Both edits keep the clip's position, scale, rotation,
and opacity keyframe motion over the frames they retain. This includes springs
that overshoot a property limit and settle back into range.

A split must leave every attached transition whole. If a fade-in occupies
frames 0 through 7, split at frame 8 or later inside the clip. Exact subframe
sampling, motion blur, and retiming are unavailable in this mode.

Declare exposed inputs with `animation.parameters: { title: 'string' }`.
Supported types are `string`, `number`, `boolean`, and `json`. Set a default
in asset `props` for each declared key. Clip `props` overrides validate against
the same declaration, and unknown keys fail validation. React receives the
resolved values as component props. Use `animation.seed` for `useGraphicRandom()`,
which returns a 0–1 value keyed by a stable string. Declare local resources
through `resources`. Declared fonts are loaded before animation under the
family `OpenCut Resource <id>`.

```tsx
import { useRef } from 'react';
import { stagger } from 'animejs';
import { useGraphicTimeline } from '@opencut/graphics/anime';

export default function Headline({ title }: { title: string }) {
  const root = useRef<HTMLDivElement>(null);
  useGraphicTimeline(root, (timeline) => {
    timeline.add(
      '.word',
      {
        translateY: [42, 0],
        opacity: [0, 1],
        delay: stagger(110),
        duration: 640,
        ease: 'out(3)',
      },
      0,
    );
  });
  return (
    <div ref={root}>
      {title.split(' ').map((word, i) => (
        <span
          className="word"
          key={i}
          style={{ display: 'inline-block', marginRight: 12 }}
        >
          {word}
        </span>
      ))}
    </div>
  );
}
```

The published authoring path is `@dantea/opencut/graphics/anime`. The compiler
supplies its pinned `animejs`, React, and OpenCut SDK modules. Composition
source and local imports stay within the definition directory. OpenCut bundles
them without running project build configuration or package scripts. The
graphics package contains the Anime.js license, with the full notice also
included in OpenCut distributions and Anime.js project bundles.

Build timelines synchronously after commit and use scoped selectors or
element references. React owns the baseline markup. Let Anime.js own the
properties it animates after mount. The host samples the timeline using
`seek(sourceTimeMs, true)` after the DOM and resources are ready. Every
sample starts from a fresh React tree and timeline baseline inside a
reused browser surface. A build callback can return a cleanup function,
and OpenCut reverts its Anime.js scope when the sample unmounts.
`useGraphicSvgId()` returns a unique fragment ID for SVG masks, clip paths,
filters and gradients.

Use timelines, keyframes, easing and springs, stagger, and `svg` helpers
for stroke drawing, motion paths and compatible SVG morph targets. Supply
explicit from/to values or a stable authored baseline. Author morph shapes
with corresponding commands and points and check intermediate frames.
Build all necessary DOM before the timeline runs. Callback side effects,
playback loops, timers, WAAPI, autonomous CSS transitions and animations,
wall-clock values, user input and network data are outside the deterministic
contract. Use ordinary OpenCut tracks for audio and video.

The desktop editor opens the definition and automatically refreshes changed
sources. Use **Refresh source** to request a rebuild immediately. Expand
**Motion graphics** to import a TSX component or place a registered composition
on a new video track. Select a motion clip in the timeline to edit its frame
range and parameters, duplicate it at a new position, or split at the playhead.
If the playhead would divide a transition, **Split at frame** is disabled.
Move to the transition's edge or beyond it.

Edits save and open a new resolved `.video.ts` beside the original. The copy
captures the selected variant and continues to use the same component sources
and local assets. Closing the definition cancels a pending motion edit. If
the source refreshes during **Save As**, retry the edit from the rebuilt preview.

In the import dialog, use `options.parameters` and `props` in the settings JSON
to expose fields, and `resources` for local file aliases.

The [Tideline example](../examples/motion/tideline/tideline.video.ts) is a
13-second 1080p30 project with transparent Anime.js layers, an ordinary SVG
underlay, and audio cues on an OpenCut track. It includes compatible path
morphs, staggered and clipped type, a drawn stroke, motion paths and layered
transitions. Its [asset credits](../examples/motion/tideline/ASSETS.md) travel
with the example.

```sh
opencut validate examples/motion/tideline/tideline.video.ts --json
opencut preview frame examples/motion/tideline/tideline.video.ts --frame 154 --quality quality --output tideline-frame.png
opencut render examples/motion/tideline/tideline.video.ts --quality quality --output Tideline.mp4
opencut package examples/motion/tideline/tideline.video.ts --resource ASSETS.md --output tideline-bundle
opencut package verify tideline-bundle
```

## Static SVG

Use `{ kind: 'graphic', renderer: 'svg', path: './graphics/Mark.svg' }`
and a video clip with `duration` or explicit source points. Static artwork
holds its image throughout the placement. Supply a `viewBox` or positive
pixel dimensions. OpenCut supports basic geometry and paths, transforms,
strokes, local gradients, simple masks and clip paths, and `text` and `tspan`
elements with SVG font, positioning and alignment attributes. Text defaults
to bundled OpenCut Sans and OpenCut Emoji. The SVG worker sees only those
fonts and the font aliases declared on the asset. To use a local font,
declare `fonts: { Brand: './fonts/Brand.ttf' }` and set
`font-family="Brand"` in the SVG. Each TTF or OTF is limited to 2 MiB and
captured with the source for rendering and packaging.

Use the React renderer for embedded raster images, stylesheets, or
frame-driven SVG. Static SVG rejects external references, including
document-level `<?xml-stylesheet …?>` instructions. It also rejects XML
entity declarations, scripts, event handlers, animation, filters, and HTML.

## Templates

Reference a wrapper in [examples/graphics](../examples/graphics) or
make the built-in template the default export of your own TSX file.

```tsx
import { BarChart as Chart } from '@opencut/graphics/templates';

export { Chart as default };
```

A direct re-export from the template package or `export default Chart` also
works.

| Template        | Props                                                         |
| --------------- | ------------------------------------------------------------- |
| `LowerThird`    | `name`, `role`, optional captured `portrait` URL              |
| `StatisticCard` | `label`, `value`, `unit`, `detail`                            |
| `BarChart`      | `title`, `data` as up to six `{ label, value }` rows, `empty` |
| `Callout`       | `label`, normalized target `x` and `y`                        |
| `SectionCard`   | `heading`, multiline `body`                                   |

All accept `theme: 'dark' | 'light'` and optional `accent`, `ink` and `paper`
colors. Callouts also accept normalized `anchorX` and `anchorY`, and section
cards accept an optional captured `icon` URL. For direct template entries,
`validate` and `package` check asset defaults and resolved placement props
without launching Chromium. Templates embedded in a custom component
check their props during rendering.

Templates scale with the logical surface and have bilingual defaults. Chart
labels ellipsize in a single line. Other text wraps, with clipping at the
surface edge for very long content.

## Preview, export and transfer

```sh
opencut validate graphics.video.ts --json
opencut preview frame graphics.video.ts --frame 65 --quality quality --output frame.png
opencut preview contact-sheet graphics.video.ts --output sheet.png
opencut preview graphics.video.ts --watch
opencut render graphics.video.ts --picture-cache ./render-cache --output final.mp4
opencut package graphics.video.ts --output ./bundle
opencut package verify ./bundle
```

For the checkout example, use `examples/video/graphics.video.ts` as the
definition and `--root examples` when packaging. OpenCut reuses a browser
within each render and bounds the source-frame memory cache. The existing
picture cache also stores verified graphic PNG samples, up to 256 MiB of
new samples per render. Source reuse depends on code, resources, props,
duration, rate, size, and the renderer. The cache directory can be shared
between exports. Preview and desktop review use the same frame renderer as
export. Compare equivalent quality and size settings to separate animation
timing from normal MP4 compression differences.

A version 2 package includes editable local sources and a captured executable
React bundle. It renders without the original npm dependency graph once the
matching Chromium Headless Shell and OpenCut runtime are installed. Use the
package manifest's `graphics` map to look up a bundle by asset ID. Add any
required project attribution and font notices with `--resource`. OpenCut carries
the license files of bundled Node dependencies in `graphics/notices.txt`
when available.
Verification checks inventory and hashes without executing the bundle.
Preview and export render the captured bundle in Chromium. Use packages
from sources you trust.

## Declarative scenes

Use a version 3 definition and a graphic asset with `renderer: 'scene'`.
Set `scene: { version: 1, units: 'px', children: [...] }`. Use
`defineGraphicScene` for contextual types.

- Children paint from first to last. Nested groups have their own opacity,
  transforms, clipping and time. Coordinates start at the logical surface's
  upper-left corner. A group's `origin` sets its transform pivot.
- Supported nodes are `group`, `rect`, `ellipse`, `path`, `image`,
  `media-frame`, `text` and `audio`. Each node requires a unique stable ID.
  There are at most 512 nodes, 16 levels and 16,384 characters per SVG path.
- Colors are hex RGB or RGBA, with `transparent` available. Supply
  `{ from, to, progress }` for color motion. Rectangles and ellipses also
  accept a linear gradient with ordered stops.
- Attach a rectangular, ellipsoidal, path or gradient mask to a node.
  Coordinates refer to its local logical surface. Fitting, alpha, blur,
  brightness, saturation and drop shadows operate inside that graphic.
  Pixels beyond the logical surface are clipped. Use a visual track group
  for compositing with underlying footage.
- An image or a font refers to a named local file in `resources`. A
  `media-frame` node refers to a name in the graphic's `mediaFrames` map.
  Each entry supplies a video asset ID and optional rational `offset` in
  seconds. OpenCut adds the offset to the graphic source time exactly and
  samples the covering frame from the pinned video. A sample exactly on a
  frame's presentation timestamp selects that frame. Use up to two references
  per graphic. An out-of-range sample reports a rendering error.
- Text takes explicit pixel bounds, size, color, alignment and optional
  font and stroke. Newlines break lines. Use `runs` for styled spans with
  separate font, weight and color. Apply motion to the text box or use a
  plain-text node for kinetic segmentation and timed highlights. Choose `overflow: 'fit'` to measure
  the text after font readiness and shrink down to `minSize`. Use
  `overflow: 'error'` to fail on overflow or `'clip'` to clip to its
  declared box. The default is clipping. `kinetic` animates graphemes, words
  or lines with explicit stagger and duration. `highlight` uses supplied
  character ranges and half-open source-frame intervals. Font choices
  determine glyph coverage. The browser uses the bundled Simplified
  Chinese fallback and the host's available emoji fonts.
- To use a preset, set `scene: { version: 1, units: 'px', preset: { name,
...parameters } }`. The preset lowers into the same node tree.
  `createPresetScene(preset, { width, height })` returns an editable tree.
  The direct `renderer: 'template'` form accepts the existing template name,
  props, duration and resources. Both forms work directly in JSON.

| Scene preset                                               | Required parameters                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `title-sequence`, `lower-third`, `device-card`, `end-card` | `title`, with optional `subtitle`                                     |
| `statistic`                                                | `label`, `value`, with optional `unit`                                |
| `bar-chart`, `line-chart`                                  | `title` and two to eight `rows` of `{ label, value }`                 |
| `callout`                                                  | `label`, normalized target `x` and `y`                                |
| `split-screen`                                             | `first` and `second` image resource names                             |
| `waveform`, `spectrum`                                     | `audioAnalysis` on the asset, with optional preset `title` and `gain` |

Presets accept `accent`, `ink`, `background`, a resource `font`, and
`revealFrames`. Scene positions and durations use local source frames.
`timing` maps parent to child time using `at`, optional `duration`, `in`,
`speed`, and `cycle`. Shape positions and numeric layout, mask and effect
values can use a channel such as
`{ keys: [{ at: 0, value: 16 }, { at: 24, value: 120 }] }`. The optional
outgoing `easing` can be a named easing, `{ type: 'cubic-bezier', x1, y1,
x2, y2 }`, or `{ type: 'spring', mass, stiffness, damping, duration }`.
Spring duration is in seconds and defines the simulated interval within
the segment. The sampler anchors both endpoints and retains overshoot.
Property limits apply after interpolation. For motion on the whole clip,
see [visual keyframe easing](VIDEO_DEFINITIONS.md#visual-keyframe-easing).

Channel `before` and `after` accept `clamp`, `extend` and `identity`.
`extend` uses the adjacent segment's linear slope. `identity` passes
through the mapped source coordinate. Channels can delay, change speed and
repeat with `cycle: { mode: 'loop' | 'ping-pong', duration }`. Use a path
node's `draw` to reveal a stroke. A node's `follow` accepts a path, progress
and optional orientation along the tangent. The SDK also exports
`interpolate`, `interpolateColor`, `sampleMotion`, `sequenceTime`,
`staggerTime`, `cycleTime` and `seededVariation`.

## Sampling and capture

Scenes, Lottie and Three.js use the exact graphic source clock. A trusted
React asset can opt in with `sampling: 'exact'` and read
`useGraphicExactTiming()`, an exact seconds fraction. Existing
`useGraphicFrame()` and `useGraphicTiming().seconds` keep their floored
project-frame grid values. Export FPS overrides resample the finished
picture. The graphic clock controls only the graphic surface.

Set `motionBlur: { samples: 8, shutterAngle: 180 }` on an exact-sampled
asset to expose distinct times centered around each project frame. Use
2–12 samples, a shutter angle of 1–360 degrees and a logical surface of at
most 2,073,600 pixels. Samples outside the placement or transition window
are discarded and the remaining exposure weights are normalized.
Captured surfaces accumulate in premultiplied linear-light sRGB.
The render stages the combined graphic once and applies the ordinary
outer clip transform. Source media and the outer transform use their
existing frame sampling.

The browser host prepares one bounded surface at a time, seeks at an
explicit sample, waits for readiness associated with the request, and
captures it with transparency. React components can call
`useGraphicReadiness()` and register a promise synchronously from a
layout effect. Resolve it after the work needed for that frame, such as
canvas drawing, completes. The runtime also waits for required fonts and
images. A frame timeout, crash or cancellation closes the owned browser.
Adapters dispose their surface when it is replaced or the render ends.
See [ReadinessDial.tsx](../examples/motion/ReadinessDial.tsx).

## Lottie and Three.js

The optional runtimes are Lottie Web 5.13.0 and Three.js 0.184.0. Use the
matching pinned Chromium installation and check `doctor --json`.
A portable package carries validated inputs and captured executable
bundles, and its notices inventory records bundled dependency terms.

- `renderer: 'lottie'` takes a local `.json` vector animation, up to 4 MiB.
  The supported subset includes 2D shape layers with groups, ellipses,
  rounded rectangles, paths, fills, strokes, transforms and trim paths.
  Expressions, external or embedded image assets, text layers, repeaters,
  masks, mattes, effects, layer parenting, dashed strokes and time-remapping
  are outside this subset. The adapter applies the authored intrinsic
  `fr`, `ip` and `op`, with `outOfRange: 'hold' | 'loop' | 'error'`.
- `renderer: 'three'` takes a `scene: { version: 1, camera, lights, ... }`.
  Use a perspective camera, ambient or directional lights, local box and
  sphere meshes, standard materials, captured textures and animated
  transforms. An optional local `.glb` adds self-contained GLB 2.0 triangle
  geometry and can seek a named animation. GLB files allow up to 16 MiB
  and 200,000 triangles. The adapter rejects GLB extensions, external URIs,
  skins, sparse accessors, morph targets and embedded GLB textures.
  Procedural meshes accept declared local raster textures. The optional
  animation uses its actual duration and explicit `hold`, `loop` or
  `error` behavior. The WebGL2 renderer waits for shader preparation and
  graphics completion before capture and releases its context on disposal.
  The logical surface limit is 2,073,600 pixels.

For compiled assets, `opencut timeline inspect ... --frame N --json`
reports source sample times, dependency key, renderer and logical
dimensions. Declarative text boxes are sampled in their parent scene space.
`opencut doctor --json` lists graphics versions, prerequisites
and limits, with JSON Schemas in the `graphicsSchemas` object.

## Audio-dependent graphics

Declare `audioAnalysis: { version: 1, source: 'mix', window: 2048, hop: 256,
waveform: 128, bins: 48 }` on a scene or trusted React asset. `source: {
track: 'music-track' }` selects a single explicit audio or video track
after its ordinary clip trims, gain, timing and effects. The mixed source
uses the resolved music selection. With Professional Dialogue Mix enabled,
it also uses the export channel count, sample rate, and AAC bitrate.
Analysis uses timeline seconds and measures the resolved signal at 48 kHz.
The renderer samples signed peak waveform buckets, RMS, and linear FFT
magnitudes from centered Hann windows. FFT bin `i` represents
`i × 48000 / window` Hz. Nearby hop results interpolate on the timeline.
Explicit `beats` are increasing rational timeline seconds. A beat is
active for the project frame covering its time.

Scene audio nodes support `waveform`, `spectrum`, `rms` and `beat`.
Trusted React graphics can read `useGraphicAudio()`. Audio flows from the
compiled sources to analysis and then to graphics. An analysis references
an audio track or the mix. Graphic assets supply no audio. The audible mix
remains in the shared media pipeline. Analysis identity includes resolved
inputs, routing, timing, processing and analysis settings. For a mixed source
with Professional Dialogue Mix enabled, changing the export channel count,
sample rate, or AAC bitrate invalidates the analysis and affected picture
cache entries. Beat marker changes invalidate picture samples while retaining
the reusable FFT. OpenCut stores verified analysis features in the recipe
cache for reuse across CLI runs.
