# Headless capabilities

| Capability                                         | CLI                                                      | TypeScript SDK                                            |
| -------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Compile and validate                               | `validate`                                               | `compileVideo`                                            |
| Check required or advisory layout assertions       | `validate`, `render`                                     | `inspectVideoLayout`                                      |
| Inspect timeline and cue timing                    | `inspect`, `timeline inspect`                            | `previewVideo().inspect()`, `.inspectFrame()`             |
| Review a definition frame, range, or contact sheet | `preview frame`, `preview clip`, `preview contact-sheet` | `previewVideo().frame()`, `.clip()`, `.contactSheet()`    |
| Review decoded MP4 frames and boundaries           | `preview contact-sheet EXPORT.mp4`                       |                                                           |
| Verify export timing, picture and audio packets    | `verify export`                                          |                                                           |
| Check the reported video frame rate                | `probe --expect-fps`                                     | `probeMedia` for stream metadata                          |
| Inventory dependencies and artifacts               | `inspect dependencies`                                   |                                                           |
| Rebuild on source changes                          | `preview DEFINITION --watch`                             | `watchVideo`                                              |
| Compile and render with parameters                 | `validate --params`, `render --params`                   | `compileVideo`, `renderVideo` with `params`               |
| Render a batch of variants                         | `batch`                                                  | `batchRenderVideo`                                        |
| Inspect build recovery                             | `build inspect`                                          | `inspectVideoBuild`                                       |
| Diagnose a source change                           | `SOURCE_CHANGED` in JSON stderr                          | `findSourceChange`                                        |
| Plan cache reuse and estimate scratch space        | `render plan`                                            | `planVideoRender`                                         |
| Package and verify local dependencies              | `package`, `package verify`                              | `packageVideo`, `verifyVideoPackage`                      |
| Export MP4                                         | `render`                                                 | `renderVideo`, `renderCompiledVideo`                      |
| Reuse rendered picture                             | `render --picture-cache`                                 | `pictureCacheDirectory` in render options                 |
| Reuse encoded picture for an audio revision        | `render --picture-version`                               | `pictureVersion` in render options                        |
| Work with subtitles                                | `subtitles export`                                       | `parseSubtitles`, `readSubtitleFile`, `writeSubtitleFile` |
| Build narration clips and cues together            | Author with the SDK in a definition                      | `buildNarration`                                          |
| Inspect and extract source media                   | `probe`, `extract-frame`                                 | `probeMedia`, `extractFrame`                              |
| Separate dialogue                                  | `separate-dialogue`                                      | `separateDialogue`                                        |
| Find and download licensed media                   | `online search`, `online download`                       | `OnlineMediaLibrary`                                      |

The [definition format](VIDEO_DEFINITIONS.md) describes shared render
features. The [CLI overview](CLI.md) describes prerequisites and commands.
