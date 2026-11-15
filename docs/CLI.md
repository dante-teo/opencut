# OpenCut CLI

`opencut --help` lists the primary commands. From a checkout use
`node apps/cli/dist/index.js` after `pnpm build:packages` and
`pnpm --filter @opencut/cli build`. FFmpeg and ffprobe are required for
rendering media. Use `opencut system inspect --json` for hardware diagnostics.

```sh
opencut validate edit.video.ts
opencut inspect edit.video.ts --json
opencut timeline inspect edit.video.ts --frame 60 --json
opencut preview edit.video.ts --watch
opencut preview frame edit.video.ts --frame 60 --output review.png
opencut render edit.video.ts --output final.mp4
opencut subtitles export edit.video.ts --output captions.srt
```

Use `opencut render --help` for quality, resolution, codec, frame rate and
audio settings. Outputs are new files unless a supported render explicitly
requests `--overwrite`. Use `--json` for machine output and SIGINT or SIGTERM
to cancel foreground work. Render runs in the CLI with FFmpeg subprocesses.

Media tools include `probe`, `extract-frame`, and `separate-dialogue` on
source paths. Choose a destination that supports hard links for
`extract-frame` so it can publish the completed PNG atomically. Dialogue
separation requires a separately installed ELUATE model.

`online search` reads a JSON request. `online download` returns the downloaded
file's path and provenance for use in a definition. Cancelling an in-flight
frame extraction or download discards partial output.

See the [definition reference and examples](VIDEO_DEFINITIONS.md).

## Media recipes

```sh
opencut recipes inspect edit.video.ts --json
opencut recipes validate edit.video.ts
opencut render edit.video.ts --recipe-cache ./recipe-cache --recipe-workers 2 --output final.mp4
```

`recipes inspect` and `recipes validate` check source streams and ordered
steps without transcoding. The normal `validate`, `inspect`, and `render`
commands also accept these processing options when compiling referenced
recipes.

| Option                     | Default and scope                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--recipe-cache`           | `$XDG_CACHE_HOME/opencut/recipes-v1`, or `~/.cache/opencut/recipes-v1`. Use a private local directory that supports file locks and atomic rename.     |
| `--recipe-workers`         | 1 active step per invocation, configurable from 1 through 16.                                                                                         |
| `--recipe-temp-bytes`      | 4 GiB for staged media per invocation, split evenly among workers. The OS file limit rounds down and can be stricter on Linux depending on the shell. |
| `--recipe-memory-bytes`    | 1 GiB per FFmpeg process. Bounds individual FFmpeg allocations and terminates workers observed above the RSS limit. RSS is sampled every 50 ms.       |
| `--recipe-buffered-frames` | 32 frames per FFmpeg filter graph.                                                                                                                    |
| `--recipe-max-pixels`      | 8,847,360 pixels per input or output frame.                                                                                                           |
| `--recipe-timeout-ms`      | 1,800,000 milliseconds per FFmpeg step.                                                                                                               |

Processing limits apply to fresh recipe work. Cached media and composition
outputs have their own disk usage. Completed entries stay on disk until
removed. Matching inputs, parameters, and backend versions reuse them.
Stop active builds before clearing the cache directory.

Foreground rendering reports step starts, media time, completions, and cache
hits on stderr. A successful `render --json` includes `recipeProcessing` when
recipes were used. Each entry has `assetId`, a zero-based `step`, a cache
`key`, and a `status` of `completed` or `cache-hit`.

SIGINT and SIGTERM cancel active steps and remove staged media. Each
successfully published step can be reused independently. After an abrupt
exit, rerun the same render command. The retry clears abandoned staging for
the requested step. Unfinished steps encode in fresh attempt directories.

Fresh recipe execution requires macOS or Linux and FFmpeg with
`-filter_buffered_frames` and FFV1 encoding in MOV. Verified on macOS with
FFmpeg and ffprobe 9.0.2. Node versions that mark the built-in SQLite module
experimental may print a warning on stderr when opening the recipe cache.
