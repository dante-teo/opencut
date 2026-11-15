# Headless capabilities

| Capability                              | CLI                                                      | TypeScript SDK                                            |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Compile and validate                    | `validate`                                               | `compileVideo`                                            |
| Inspect timeline and cue timing         | `inspect`, `timeline inspect`                            | `previewVideo().inspect()`, `.inspectFrame()`             |
| Review a frame, range, or contact sheet | `preview frame`, `preview clip`, `preview contact-sheet` | `previewVideo().frame()`, `.clip()`, `.contactSheet()`    |
| Rebuild on source changes               | `preview DEFINITION --watch`                             | `watchVideo`                                              |
| Compile and render with parameters      | `validate --params`, `render --params`                   | `compileVideo`, `renderVideo` with `params`               |
| Render a batch of variants              | `batch`                                                  | `batchRenderVideo`                                        |
| Export MP4                              | `render`                                                 | `renderVideo`, `renderCompiledVideo`                      |
| Work with subtitles                     | `subtitles export`                                       | `parseSubtitles`, `readSubtitleFile`, `writeSubtitleFile` |
| Inspect and extract source media        | `probe`, `extract-frame`                                 | `probeMedia`, `extractFrame`                              |
| Separate dialogue                       | `separate-dialogue`                                      | `separateDialogue`                                        |
| Find and download licensed media        | `online search`, `online download`                       | `OnlineMediaLibrary`                                      |

The [definition format](VIDEO_DEFINITIONS.md) describes shared render
features. The [CLI overview](CLI.md) describes prerequisites and commands.
