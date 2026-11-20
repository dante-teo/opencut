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
