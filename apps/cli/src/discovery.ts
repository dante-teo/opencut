import { animatedProperties, visualRanges } from '@opencut/shared';
import { desktopControlJsonSchema } from '@opencut/core/node';
import {
  editTransactionJsonSchema,
  getApplicationInfo,
  inspectionJsonSchemas,
} from '@opencut/core';

type Option = {
  type: 'boolean' | 'string';
  description: string;
  enum?: readonly string[];
  unit?: string;
  minimum?: number;
  maximum?: number;
};
const options: Record<string, Option> = {
  help: { type: 'boolean', description: 'Show command help.' },
  json: {
    type: 'boolean',
    description: 'Structured stdout and structured errors on stderr.',
  },
  kind: {
    type: 'string',
    description: 'Video transition kind.',
    enum: ['cross-dissolve', 'fade-in', 'fade-out'],
  },
  'from-clip': {
    type: 'string',
    description: 'Outgoing clip ID. Required for cross-dissolve only.',
  },
  name: { type: 'string', description: 'Nonblank project or track name.' },
  project: { type: 'string', description: 'Project file to open or create.' },
  create: {
    type: 'string',
    description:
      'Create a project with this name at a new path. Incompatible with --expected-revision.',
  },
  width: {
    type: 'string',
    description: 'Positive integer canvas/output width.',
    unit: 'pixels',
  },
  height: {
    type: 'string',
    description: 'Positive integer canvas/output height.',
    unit: 'pixels',
  },
  fps: {
    type: 'string',
    description: 'Project: positive integer or n/d. Compose: integer 1–60.',
    unit: 'frames/second',
  },
  output: {
    type: 'string',
    description: 'Explicit destination path in an existing writable directory.',
  },
  quality: {
    type: 'string',
    description: 'Encoding quality.',
    enum: ['draft', 'balanced', 'high'],
  },
  codec: {
    type: 'string',
    description: 'MP4 video codec.',
    enum: ['h264', 'hevc'],
  },
  'video-bitrate': {
    type: 'string',
    description: 'Target video bitrate instead of CRF.',
    minimum: 100,
    maximum: 100000,
    unit: 'kb/s',
  },
  'audio-bitrate': {
    type: 'string',
    description: 'Target AAC bitrate.',
    minimum: 32,
    maximum: 320,
    unit: 'kb/s',
  },
  'audio-rate': {
    type: 'string',
    description: 'AAC sample rate.',
    enum: ['44100', '48000'],
    unit: 'Hz',
  },
  'audio-channels': {
    type: 'string',
    description: 'Mono or stereo.',
    enum: ['1', '2'],
  },
  resolution: {
    type: 'string',
    description:
      'Scale finished canvas, preserving aspect/orientation; may upscale.',
    enum: ['project', '720p', '1080p'],
  },
  'no-subtitles': {
    type: 'boolean',
    description: 'Leave the subtitle track out of the video.',
  },
  overwrite: {
    type: 'boolean',
    description:
      'Atomically replace a regular export; never replace project/source media.',
  },
  'dry-run': {
    type: 'boolean',
    description: 'Validate mutation without saving.',
  },
  'expected-revision': {
    type: 'string',
    description: 'Reject stale mutations.',
    minimum: 0,
    unit: 'revision',
  },
  type: {
    type: 'string',
    description: 'Track media type.',
    enum: ['video', 'audio'],
  },
  track: { type: 'string', description: 'Stable destination track ID.' },
  at: {
    type: 'string',
    description: 'Absolute timeline position; split is absolute too.',
    unit: 'project-frame',
    minimum: 0,
  },
  frames: {
    type: 'string',
    description: 'Positive duration in project frames.',
    minimum: 1,
    unit: 'project-frame',
  },
  in: {
    type: 'string',
    description: 'Inclusive source boundary on the project grid.',
    unit: 'project-frame',
    minimum: 0,
  },
  out: {
    type: 'string',
    description: 'Exclusive source boundary on the project grid.',
    unit: 'project-frame',
    minimum: 0,
  },
  frame: {
    type: 'string',
    description:
      'Exact zero-based project-frame index. Inspect permits end/after; preview must be inside.',
    unit: 'project-frame',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  },
  from: {
    type: 'string',
    description: 'Inclusive timeline range start.',
    unit: 'project-frame',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  },
  to: {
    type: 'string',
    description: 'Exclusive timeline range end.',
    unit: 'project-frame',
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  },
  count: {
    type: 'string',
    description:
      'Uniform samples including first/last included frame; cannot exceed range length.',
    minimum: 1,
    maximum: 16,
  },
  columns: {
    type: 'string',
    description: 'Contact-sheet columns; cannot exceed sample count.',
    minimum: 1,
    maximum: 16,
  },
  size: {
    type: 'string',
    description:
      'Integer maximum finished-canvas side, no upscaling; sheets cap at 640.',
    unit: 'pixels',
    minimum: 64,
    maximum: 1920,
  },
  timestamp: {
    type: 'string',
    description:
      'Nonnegative decimal seconds relative to source start, for source-only extraction/cache.',
    unit: 'seconds',
    minimum: 0,
  },
  volume: {
    type: 'string',
    description: 'Linear amplitude gain for a clip or track.',
    minimum: 0,
    maximum: 1,
  },
  muted: {
    type: 'string',
    description: 'Mute without changing gain.',
    enum: ['true', 'false'],
  },
  speed: {
    type: 'string',
    description: 'Constant playback multiplier as a decimal or ratio.',
    minimum: 0.25,
    maximum: 4,
  },
  'in-time': {
    type: 'string',
    description:
      'Exact source in time in seconds, as a decimal, timestamp or ratio. Alternative to --in.',
    unit: 'seconds',
    minimum: 0,
  },
  'out-time': {
    type: 'string',
    description:
      'Exact exclusive source out time in seconds, as a decimal, timestamp or ratio. Alternative to --out.',
    unit: 'seconds',
    minimum: 0,
  },
  'fade-in': {
    type: 'string',
    description: 'Linear fade-in duration in project frames; zero clears it.',
    unit: 'project frames',
    minimum: 0,
  },
  'fade-out': {
    type: 'string',
    description: 'Linear fade-out duration in project frames; zero clears it.',
    unit: 'project frames',
    minimum: 0,
  },
  x: {
    type: 'string',
    description: 'Signed offset from centered fitted rectangle; use --x=-20.',
    unit: 'pixels',
    minimum: visualRanges.x[0],
    maximum: visualRanges.x[1],
  },
  y: {
    type: 'string',
    description: 'Signed offset from centered fitted rectangle; use --y=-20.',
    unit: 'pixels',
    minimum: visualRanges.y[0],
    maximum: visualRanges.y[1],
  },
  scale: {
    type: 'string',
    description: 'Scale the canvas-fitting rectangle.',
    minimum: visualRanges.scale[0],
    maximum: visualRanges.scale[1],
  },
  rotation: {
    type: 'string',
    description: 'Clockwise degrees around the fitted layer center.',
    minimum: visualRanges.rotation[0],
    maximum: visualRanges.rotation[1],
  },
  opacity: {
    type: 'string',
    description: 'Multiply source alpha; does not mute audio.',
    minimum: visualRanges.opacity[0],
    maximum: visualRanges.opacity[1],
  },
  fit: {
    type: 'string',
    description: 'Aspect-fitting rule.',
    enum: ['contain', 'cover', 'stretch'],
  },
  'background-color': {
    type: 'string',
    description: '#RRGGBB, #RRGGBBAA or transparent.',
  },
  music: {
    type: 'string',
    description: 'Background audio path, looped to fit composition.',
  },
  'clip-volume': {
    type: 'string',
    description: 'Compose original audio linear gain.',
    minimum: 0,
    maximum: 1,
  },
  'music-volume': {
    type: 'string',
    description: 'Compose background audio linear gain.',
    minimum: 0,
    maximum: 1,
  },
  directory: {
    type: 'string',
    description:
      'Cache directory (default OPENCUT_MEDIA_CACHE or ~/.cache/opencut/media-v1).',
  },
  'disk-mib': {
    type: 'string',
    description: 'Cache disk limit; must resolve to an integer byte count.',
    unit: 'MiB',
    minimum: 1,
    maximum: 1048576,
  },
  'memory-mib': {
    type: 'string',
    description:
      'Encoded PNG memory cache limit; must resolve to an integer byte count.',
    unit: 'MiB',
    minimum: 1,
    maximum: 1024,
  },
  regenerate: { type: 'boolean', description: 'Regenerate a preview proxy.' },
};
const edit = ['dry-run', 'expected-revision'];
const visual = [...animatedProperties, 'fit'];
const trackAudio = ['volume', 'muted'];
const audio = [...trackAudio, 'fade-in', 'fade-out'];
type Definition = {
  name: string;
  description: string;
  args: string[];
  options: string[];
  required?: string[];
  defaults?: Record<string, unknown>;
  tools?: string[];
  mutates?: boolean;
  jsonl?: boolean;
};
const definitions: Definition[] = [
  {
    name: 'help',
    description:
      'Discover commands, arguments, constraints, capability status and output schemas.',
    args: ['command?'],
    options: [],
  },
  {
    name: 'run',
    description:
      'Execute a trusted local TypeScript default export. Pass script arguments after --.',
    args: ['script-file'],
    options: ['project', 'create', ...edit],
    required: ['project'],
    tools: ['Node.js with native TypeScript type stripping'],
    mutates: true,
  },
  {
    name: 'project create',
    description: 'Create a new version 1 project.',
    args: ['project-file'],
    options: ['name', 'width', 'height', 'fps'],
    required: ['name'],
    defaults: { width: 1920, height: 1080, fps: '30/1' },
    mutates: true,
  },
  {
    name: 'project info',
    description:
      'Read settings, metadata and collection counts, including offline projects.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'project inspect',
    description:
      'Read full revision-tagged content and duration, excluding undo snapshots; works offline.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'project validate',
    description:
      'Validate project data and source readability (no decoding); invalid report exits 1.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'project render',
    description:
      'Render the composited timeline with mixed audio to H.264 or HEVC with AAC in MP4.',
    args: ['project-file'],
    options: [
      'output',
      'quality',
      'resolution',
      'overwrite',
      'no-subtitles',
      'width',
      'height',
      'fps',
      'codec',
      'video-bitrate',
      'audio-bitrate',
      'audio-rate',
      'audio-channels',
    ],
    required: ['output'],
    defaults: { quality: 'balanced', resolution: 'project', overwrite: false },
    tools: ['ffmpeg', 'ffprobe'],
    jsonl: true,
  },
  {
    name: 'project freeze',
    description:
      'Write a still PNG and insert a freeze frame at an exact project frame.',
    args: ['project-file', 'clip-id'],
    options: ['at', 'frames', 'output', 'expected-revision'],
    required: ['at', 'frames', 'output'],
    tools: ['ffmpeg', 'ffprobe'],
    mutates: true,
  },
  {
    name: 'project cache-preview',
    description: 'Render or reuse a verified full-timeline preview.',
    args: ['project-file'],
    options: ['size'],
    tools: ['ffmpeg', 'ffprobe'],
  },
  {
    name: 'desktop control',
    description:
      'Control playback, viewer, selection and online media in a running desktop project.',
    args: ['project-file', 'request.json'],
    options: [],
  },
  {
    name: 'project snapshot',
    description: 'Save a named copy of the current revision.',
    args: ['project-file'],
    options: ['output'],
    required: ['output'],
  },
  {
    name: 'project package',
    description: 'Copy the project and the media referenced by its history.',
    args: ['project-file'],
    options: ['output'],
    required: ['output'],
  },
  {
    name: 'subtitle import',
    description: 'Append SRT or WebVTT cues as one undoable subtitle edit.',
    args: ['project-file', 'file'],
    options: edit,
    mutates: true,
  },
  {
    name: 'subtitle list',
    description: 'Read the shared style and exact subtitle cue intervals.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'subtitle export',
    description:
      'Write a new UTF-8 SRT or WebVTT sidecar with text and timing.',
    args: ['project-file'],
    options: ['output'],
    required: ['output'],
  },
  {
    name: 'media import',
    description:
      'Import a source reference and probed metadata; preserve original file.',
    args: ['project-file', 'file'],
    options: edit,
    tools: ['ffprobe'],
    mutates: true,
  },
  {
    name: 'media list',
    description: 'Read stored assets, availability and referencing clip IDs.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'media info',
    description: 'Read one asset, availability and references.',
    args: ['project-file', 'asset-id'],
    options: [],
  },
  {
    name: 'media remove',
    description: 'Remove an unreferenced asset entry; preserve original file.',
    args: ['project-file', 'asset-id'],
    options: edit,
    mutates: true,
  },
  {
    name: 'media relink',
    description:
      'Reprobe a replacement source and retain the existing asset and clip IDs.',
    args: ['project-file', 'asset-id', 'file'],
    options: edit,
    tools: ['ffprobe'],
    mutates: true,
  },
  {
    name: 'media import-font',
    description: 'Embed a TTF or OTF font in a title or subtitle cue.',
    args: ['project-file', 'clip-id', 'file'],
    options: edit,
    mutates: true,
  },
  {
    name: 'media separate-dialogue',
    description:
      'Write dialogue and residual background WAV files with local Bandit v2 inference.',
    args: ['project-file', 'asset-id'],
    options: ['output'],
    required: ['output'],
    tools: [
      'ffmpeg',
      'ffprobe',
      'Python with ELUATE and the Bandit v2 multilingual checkpoint',
    ],
  },
  {
    name: 'timeline list',
    description:
      'Read ordered tracks, clips and transitions with exact rational timing.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'timeline inspect',
    description:
      'Evaluate active layers (bottom to top), audio candidates/gains, gaps and exact source times.',
    args: ['project-file'],
    options: ['frame'],
    required: ['frame'],
  },
  {
    name: 'track add',
    description: 'Append a video/audio track.',
    args: ['project-file'],
    options: ['type', 'name', ...edit],
    required: ['type', 'name'],
    mutates: true,
  },
  {
    name: 'track audio',
    description: 'Set track volume and/or mute; requires at least one.',
    args: ['project-file', 'track-id'],
    options: [...trackAudio, ...edit],
    mutates: true,
  },
  {
    name: 'track remove',
    description: 'Remove an empty track.',
    args: ['project-file', 'track-id'],
    options: edit,
    mutates: true,
  },
  {
    name: 'clip add',
    description:
      'Add an explicit source range; same-track overlap is rejected.',
    args: ['project-file', 'asset-id'],
    options: ['track', 'at', 'in', 'out', ...audio, ...visual, ...edit],
    required: ['track', 'at', 'in', 'out'],
    mutates: true,
  },
  {
    name: 'clip move',
    description:
      'Move clip preserving source range; requires at least one of track/at.',
    args: ['project-file', 'clip-id'],
    options: ['track', 'at', ...edit],
    mutates: true,
  },
  {
    name: 'clip trim',
    description:
      'Change source boundaries keeping timeline start fixed; requires in or out.',
    args: ['project-file', 'clip-id'],
    options: ['in', 'out', 'in-time', 'out-time', ...edit],
    mutates: true,
  },
  {
    name: 'clip speed',
    description:
      'Set constant playback speed without moving the clip or changing source bounds.',
    args: ['project-file', 'clip-id'],
    options: ['speed', ...edit],
    required: ['speed'],
    mutates: true,
  },
  {
    name: 'clip split',
    description: 'Split at an absolute interior timeline frame.',
    args: ['project-file', 'clip-id'],
    options: ['at', ...edit],
    required: ['at'],
    mutates: true,
  },
  {
    name: 'transition add',
    description: 'Add a cross-dissolve or canvas fade to a video clip.',
    args: ['project-file', 'clip-id'],
    options: ['kind', 'frames', 'from-clip', ...edit],
    required: ['kind', 'frames'],
    mutates: true,
  },
  {
    name: 'transition set',
    description: 'Set a video transition duration in project frames.',
    args: ['project-file', 'transition-id'],
    options: ['frames', ...edit],
    required: ['frames'],
    mutates: true,
  },
  {
    name: 'transition remove',
    description: 'Remove a video transition.',
    args: ['project-file', 'transition-id'],
    options: edit,
    mutates: true,
  },
  {
    name: 'clip remove',
    description: 'Remove a clip.',
    args: ['project-file', 'clip-id'],
    options: edit,
    mutates: true,
  },
  {
    name: 'clip audio',
    description:
      'Set clip volume, mute and/or fade durations; requires at least one.',
    args: ['project-file', 'clip-id'],
    options: [...audio, ...edit],
    mutates: true,
  },
  {
    name: 'clip visual',
    description: 'Set visual properties; requires at least one.',
    args: ['project-file', 'clip-id'],
    options: [...visual, ...edit],
    mutates: true,
  },
  {
    name: 'canvas set',
    description: 'Set dimensions/background; requires at least one.',
    args: ['project-file'],
    options: ['width', 'height', 'background-color', ...edit],
    mutates: true,
  },
  {
    name: 'edit apply',
    description:
      'Apply atomic batch JSON with required expectedRevision and operations (optional label), including text and subtitle operations.',
    args: ['project-file', 'batch.json'],
    options: edit,
    mutates: true,
  },
  ...['undo', 'redo'].map((action): Definition => ({
    name: `edit ${action}`,
    description: `Restore ${action} history with an increasing revision.`,
    args: ['project-file'],
    options: edit,
    mutates: true,
  })),
  {
    name: 'edit history',
    description: 'Read revision and persistent undo/redo entries.',
    args: ['project-file'],
    options: [],
  },
  {
    name: 'preview frame',
    description:
      'Export lossless PNG from fully composited timeline; canvas alpha flattens over black.',
    args: ['project-file'],
    options: ['frame', 'output', 'size'],
    required: ['frame', 'output'],
    defaults: { size: 'project' },
    tools: ['ffmpeg', 'ffprobe'],
  },
  {
    name: 'preview contact-sheet',
    description:
      'Create a labeled PNG grid of uniformly sampled composited frames; 1–16 samples.',
    args: ['project-file'],
    options: ['from', 'to', 'count', 'columns', 'size', 'output'],
    required: ['output'],
    defaults: {
      from: 0,
      to: 'timeline end',
      count: 'min(8, range frames)',
      columns: 'min(4, count)',
      size: 320,
    },
    tools: ['ffmpeg', 'ffprobe', 'system sans-serif font'],
  },
  {
    name: 'preview clip',
    description:
      'Render a range, at most 30 seconds, with synchronized mixed audio to H.264/AAC MP4.',
    args: ['project-file'],
    options: ['from', 'to', 'size', 'quality', 'output'],
    required: ['from', 'to', 'output'],
    defaults: { size: 640, quality: 'draft' },
    tools: ['ffmpeg', 'ffprobe'],
  },
  {
    name: 'probe',
    description: 'Probe local media metadata.',
    args: ['file'],
    options: [],
    tools: ['ffprobe'],
  },
  {
    name: 'extract-frame',
    description:
      'Extract a source-only PNG; use preview frame for edited timeline.',
    args: ['file'],
    options: ['timestamp', 'output'],
    required: ['timestamp', 'output'],
    tools: ['ffmpeg', 'ffprobe'],
  },
  {
    name: 'compose',
    description:
      'Concatenate 2–16 video files (max 600s) with looped background music to H.264/AAC.',
    args: ['file', 'file', 'more-files...'],
    options: [
      'music',
      'output',
      'width',
      'height',
      'fps',
      'clip-volume',
      'music-volume',
    ],
    required: ['music', 'output'],
    defaults: {
      width: 1280,
      height: 720,
      fps: '30',
      'clip-volume': 1,
      'music-volume': 0.25,
    },
    tools: ['ffmpeg', 'ffprobe'],
  },
  ...['status', 'cleanup', 'clear'].map((action): Definition => ({
    name: `cache ${action}`,
    description: `${action} owned disposable cache entries.`,
    args: [],
    options: ['directory'],
  })),
  {
    name: 'cache configure',
    description: 'Configure bounded cache storage.',
    args: [],
    options: ['directory', 'disk-mib', 'memory-mib'],
    required: ['disk-mib', 'memory-mib'],
  },
  {
    name: 'cache proxy',
    description: 'Generate a preview-only source proxy.',
    args: ['source'],
    options: ['directory', 'regenerate'],
    tools: ['ffmpeg', 'ffprobe'],
    jsonl: true,
  },
  {
    name: 'cache frame',
    description: 'Return a bounded source-only PNG data URL.',
    args: ['source'],
    options: ['directory', 'timestamp'],
    required: ['timestamp'],
    tools: ['ffmpeg', 'ffprobe'],
  },
];

export function discovery(scope: string[] = [], help = '') {
  const prefix = scope.join(' ');
  return {
    discoveryVersion: 1,
    application: getApplicationInfo(),
    help,
    commands: definitions
      .filter(
        (command) =>
          !prefix ||
          command.name === prefix ||
          command.name.startsWith(`${prefix} `),
      )
      .map((command) => ({
        name: command.name,
        description: command.description,
        status: 'supported',
        arguments: command.args.map((name) => ({
          name: name.replace(/(?:\?|\.\.\.)$/, ''),
          required: !name.endsWith('?') && !name.endsWith('...'),
          variadic: name.endsWith('...'),
          type: 'string',
        })),
        options: [...command.options, 'json', 'help'].map((name) => ({
          name: `--${name}`,
          ...options[name]!,
          ...(command.name.startsWith('transition ') && name === 'frames'
            ? { minimum: 2 }
            : {}),
          ...(command.name === 'preview contact-sheet' && name === 'size'
            ? { maximum: 640 }
            : {}),
          required: command.required?.includes(name) ?? false,
          ...(command.defaults && name in command.defaults
            ? { default: command.defaults[name] }
            : {}),
        })),
        modifiesProject: command.mutates ?? false,
        prerequisites: command.tools ?? [],
        jsonOutput: command.jsonl ? 'jsonl' : 'document',
        ...(command.name in inspectionJsonSchemas || command.name === 'run'
          ? { resultSchema: command.name }
          : {}),
      })),
    globalOptions: [
      { name: '--help', aliases: ['-h'], type: 'boolean' },
      {
        name: '--version',
        aliases: ['-v'],
        type: 'boolean',
        description: 'Application identity; use alone, optionally with --json.',
      },
      { name: '--json', type: 'boolean' },
    ],
    capabilities: {
      projectInspection: { status: 'supported', offline: true },
      timelineEvaluation: {
        status: 'supported',
        exactProjectFrames: true,
        offline: true,
      },
      visualInspection: {
        status: 'supported',
        headless: true,
        backend: 'shared-export-compositor',
        originalMedia: true,
      },
      audioPreview: { status: 'supported', sampleRate: 48000, channels: 2 },
      scriptingRuntime: {
        status: 'supported',
        command: 'run',
        trustedLocalCode: true,
      },
      sdk: {
        status: 'supported',
        package: '@opencut/sdk',
        activeProjectSessions: true,
      },
      textLayers: {
        status: 'supported',
        operations: [
          'text.add',
          'text.set',
          'clip.move',
          'clip.trim',
          'clip.split',
          'clip.visual',
          'clip.remove',
        ],
        transactionSchema: 'edit apply input',
        sizing: 'project pixels',
        defaultFont: 'Noto Sans SC',
      },
      keyframes: {
        status: 'supported',
        operations: [
          'clip.keyframe.add',
          'clip.keyframe.set',
          'clip.keyframe.remove',
        ],
        transactionSchema: 'edit apply input',
        time: 'clip-local rational seconds',
      },
      subtitles: {
        status: 'supported',
        formats: ['srt', 'vtt'],
        transactionSchema: 'edit apply input',
        burnIn: true,
      },
      mcp: { status: 'unavailable' },
    },
    limits: {
      render: {
        clips: 64,
        timelineSeconds: 600,
        fps: [1, 120],
        evenDimensions: true,
        maxSide: 3840,
        maxPixels: 3840 * 2160,
        requiresVisualClip: true,
        requiresVideoOrImageClip: false,
      },
      previewClipSeconds: 30,
      contactSheetSamples: 16,
      contactSheetTileMaxSide: 640,
    },
    timing: {
      unit: 'project-frame',
      integer: true,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      rangeEnd: 'exclusive',
      sourceMapping: 'exact rational seconds',
      layers: 'bottom to top',
    },
    safety: {
      previewsModifyProject: false,
      previewsModifySources: false,
      previewsOverwrite: false,
      handledFailuresCleanTemporaryFiles: true,
      sigkillCleanup: false,
    },
    limitations: [
      'Preview rendering inherits export frame-alignment, source availability and SDR/color limits (T27).',
      'Frame and contact-sheet PNGs flatten canvas alpha over black.',
      'Preview ranges trim the finished composition; decoding preceding frames may take time.',
      'Audio candidates with unknown metadata are intent, not a guarantee of a decoded stream.',
      'Capability status describes implemented commands; tools/media/fonts are checked at execution.',
    ],
    exitCodes: {
      '0': 'success',
      '1': 'project/media/file/runtime failure',
      '2': 'invalid arguments',
      '130': 'SIGINT cancellation',
      '143': 'SIGTERM cancellation',
    },
    errors: {
      stream: 'stderr',
      schema: 'error',
      progress: 'preview clip progress uses stderr JSONL; stdout is one result',
    },
    schemas: {
      'desktop control input': desktopControlJsonSchema(),
      ...inspectionJsonSchemas,
      'edit apply input': editTransactionJsonSchema(),
      run: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: [
          'scriptVersion',
          'ok',
          'path',
          'projectId',
          'baseRevision',
          'revision',
          'changed',
          'created',
          'dryRun',
          'result',
        ],
        properties: {
          scriptVersion: { const: 1 },
          ok: { const: true },
          path: { type: 'string' },
          projectId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 0 },
          revision: { type: 'integer', minimum: 0 },
          changed: { type: 'boolean' },
          created: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          result: {},
        },
      },
      error: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['ok', 'error'],
        properties: {
          ok: { const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              hint: { type: 'string' },
            },
          },
        },
      },
    },
  };
}
