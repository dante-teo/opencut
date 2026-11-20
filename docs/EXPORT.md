# Export

Render a definition to MP4 with the CLI or SDK. The default uses the
definition's canvas and rate, H.264 video and stereo AAC. The export
dialog in Electron renders the displayed revision at its authored size and
rate. Use the CLI or SDK for the full set of output controls.

```sh
opencut render edit.video.ts --output final.mp4
opencut render edit.video.ts --output portrait.mp4 --width 1080 --height 1920 --fps 30000/1001 --quality maximum
opencut render edit.video.ts --output portrait-4k60.mp4 --width 2880 --height 3840 --fps 60 --codec hevc
```

`opencut render --help` lists the quality, resolution, codec, bitrate, audio
settings, `--no-subtitles`, and `--overwrite` options. A rate override
resamples the completed composition. Clip boundaries and source samples are
first selected on the authored timeline grid. H.264 exports flatten
transparency over black. The renderer supports SDR and does not promise
preservation of arbitrary source color spaces or HDR metadata.

For 3:4 delivery at 2880 × 3840, compose on a 3:4 canvas such as
1080 × 1440. OpenCut scales the finished canvas in the MP4 export and keeps
the composition and audio together. Custom output sizes allow up to
2880 × 3840 total pixels with even sides of at most 3840 pixels. The authored
canvas retains its existing limit. Ordinary output scaling adds no source
detail. Use a per-source `superResolution` recipe for AI enhancement and an
`interpolateFrames` recipe for 30-to-60 fps motion synthesis. Set the authored
timeline to 60 fps to sample those new source frames.

Choose an output path in an existing directory. The renderer stages output
beside the destination and publishes it after encoding and verification. An
existing file is refused unless explicitly authorized with `--overwrite`.
With overwrite enabled, a failed or cancelled render leaves the prior file
in place. Sources are read only. Foreground cancellation uses SIGINT or
SIGTERM in the CLI, or an AbortSignal in the SDK. Forced termination can
leave a staging directory behind.

Probe errors identify the affected file and stage and include the tool's
exit status and diagnostic when available. A missing QuickTime chapter
track is reported as a warning when the probe succeeds and returns usable
stream metadata. The render still verifies decoded media before publication.

Use `opencut subtitles export edit.video.ts --output captions.srt` for a
sidecar. See the [definition format](VIDEO_DEFINITIONS.md) for supported
effects and the [preview comparison](PREVIEW_EXPORT_CONSISTENCY.md) for
sampling and playback limits.

## Professional audio delivery

Mix-enabled definitions measure and normalize the full composition before encoding. OpenCut checks the decoded AAC true peak before publishing the export. See [delivery targets and controls](AUDIO_MIX.md#delivery-and-inspection).
