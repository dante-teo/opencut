import { z } from 'zod';
import {
  renderCodecs,
  renderQualities,
  renderResolutions,
  type RenderProgress,
  type VideoTimelineResult,
} from '@opencut/media';

export const MAX_ATTEMPTS = 3;
const integer = z.int().positive();
export const jobLimitsSchema = z.strictObject({
  concurrency: integer.max(8),
  cpuSecondsPerJob: integer.max(86_400),
  memoryMiB: integer.max(1_048_576),
  scratchMiB: integer.max(16_777_216),
});
export type JobLimits = z.infer<typeof jobLimitsSchema>;
export const defaultJobLimits: Readonly<JobLimits> = {
  concurrency: 1,
  cpuSecondsPerJob: 1800,
  memoryMiB: 4096,
  scratchMiB: 32768,
};

const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) =>
    [...value].every((character) => character.charCodeAt(0) >= 32),
  );
const size = z.strictObject({
  width: integer.max(3840),
  height: integer.max(3840),
});
const rate = z.strictObject({
  numerator: integer.max(2147483647),
  denominator: integer.max(2147483647),
});
const renderParameters = z.strictObject({
  quality: z.enum(renderQualities).default('balanced'),
  resolution: z.enum(renderResolutions).default('project'),
  codec: z.enum(renderCodecs).default('h264'),
  burnSubtitles: z.boolean().default(true),
  outputSize: size.optional(),
  outputFrameRate: rate.optional(),
  videoBitrateKbps: integer.min(100).max(100000).optional(),
  audioBitrateKbps: integer.min(32).max(320).optional(),
  audioSampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(),
  audioChannels: z.union([z.literal(1), z.literal(2)]).optional(),
});
export const localJobRequest = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('render'),
    projectPath: localPath,
    expectedRevision: z.int().nonnegative().optional(),
    parameters: renderParameters.prefault({}),
  }),
]);
export type LocalJobRequest = z.input<typeof localJobRequest>;
export const jobStates = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type JobState = (typeof jobStates)[number];

export function isActiveJob(state: JobState) {
  return state === 'queued' || state === 'running';
}
export type JobProgress =
  RenderProgress | { phase: 'preparing' | 'publishing'; percent: null };
export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
}
export interface JobLog {
  sequence: number;
  attempt: number;
  at: string;
  level: 'info' | 'error';
  code: string;
  message: string;
}
export interface JobResources {
  cpuSeconds: number;
  memoryBytes: number;
  scratchBytes: number;
}
export interface JobToolIdentity {
  path: string;
  stamp: string;
  version: string;
}
export interface JobBackend {
  renderer: string;
  ffmpeg: JobToolIdentity;
  ffprobe: JobToolIdentity;
}
export interface JobInputs {
  type: 'render';
  projectPath: string;
  revision: number;
  snapshotHash: string;
  parameters: z.output<typeof renderParameters>;
  backend: JobBackend;
  sources: { path: string; realPath: string; stamp: string }[];
}
export interface JobStatus {
  id: string;
  idempotencyKey: string;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  inputs: JobInputs;
  progress: JobProgress | null;
  resources: JobResources | null;
  result: VideoTimelineResult | null;
  error: JobFailure | null;
  workerPid: number | null;
}
export interface JobDetails extends JobStatus {
  logs: JobLog[];
}
export class JobError extends Error implements JobFailure {
  override name = 'JobError';
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
