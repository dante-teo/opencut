import { z } from 'zod';
import { snapshotSchema, clipSchema, clipVisualSchema } from './project.js';
import type { Project } from './project.js';
import { projectRevision, projectSnapshot } from './editing.js';
import { evaluateTimelineFrame } from './evaluation.js';
import { listTimeline } from './timeline.js';
import { frameRateSchema, timeSchema } from './time.js';

const natural = z.int().nonnegative();
const version = z.literal(1);
const resolvedClip = clipSchema.extend({
  id: z
    .string()
    .regex(
      /^(?:[A-Za-z0-9][A-Za-z0-9_-]*|word:[A-Za-z0-9][A-Za-z0-9_-]*:\d+)$/,
    ),
  text: clipSchema.shape.text
    .unwrap()
    .extend({
      activeWord: z
        .strictObject({ from: natural, to: natural, phase: z.number() })
        .optional(),
    })
    .optional(),
  trackId: z.string(),
  subtitle: z.literal(true).optional(),
  subtitleCueId: z.string().optional(),
  animationStart: timeSchema.optional(),
  duration: timeSchema,
  timelineEnd: timeSchema,
  trackIndex: natural,
  trackType: z.enum(['video', 'audio']),
  kind: z.enum(['video', 'audio', 'image', 'text']),
  volume: z.number(),
  muted: z.boolean(),
  trackVolume: z.number().optional(),
  trackMuted: z.boolean().optional(),
  visual: z.strictObject({
    crop: clipVisualSchema.shape.crop,
    x: z.number(),
    y: z.number(),
    scale: z.number(),
    opacity: z.number(),
    rotation: z.number().optional(),
    fit: z.enum(['contain', 'cover', 'stretch']),
  }),
  audioPresence: z.enum(['present', 'absent', 'unknown']),
  sourceTime: timeSchema,
  visible: z.boolean(),
  effectiveVolume: z.number(),
});
export const projectInspectionSchema = snapshotSchema.extend({
  inspectionVersion: version,
  path: z.string(),
  revision: natural,
  duration: timeSchema,
});
export const timelineInspectionSchema = z.strictObject({
  inspectionVersion: version,
  path: z.string(),
  projectId: z.string(),
  revision: natural,
  frame: natural,
  frameRate: frameRateSchema,
  time: timeSchema,
  duration: timeSchema,
  boundary: z.enum(['inside', 'end', 'after']),
  activeClips: z.array(resolvedClip),
  visualClips: z.array(resolvedClip),
  audioClips: z.array(resolvedClip),
  mixingSources: z.array(resolvedClip),
  gap: z.boolean(),
  visualGap: z.boolean(),
  backgroundColor: z.string(),
});
const previewBase = z.strictObject({
  inspectionVersion: version,
  path: z.string(),
  projectPath: z.string(),
  projectId: z.string(),
  revision: natural,
  frameRate: frameRateSchema,
  width: z.int().positive(),
  height: z.int().positive(),
});
export const previewFrameSchema = previewBase.extend({
  kind: z.literal('frame'),
  frame: natural,
  time: timeSchema,
});
export const previewClipSchema = previewBase.extend({
  kind: z.literal('clip'),
  startFrame: natural,
  endFrame: natural,
  startTime: timeSchema,
  endTime: timeSchema,
  frameCount: z.int().positive(),
  durationSeconds: z.number().positive(),
  quality: z.enum(['draft', 'balanced', 'high']),
});
export const previewSheetSchema = previewBase.extend({
  kind: z.literal('contact-sheet'),
  startFrame: natural,
  endFrame: natural,
  columns: z.int().positive(),
  rows: z.int().positive(),
  tileWidth: z.int().positive(),
  cellWidth: z.int().positive(),
  tileHeight: z.int().positive(),
  labelHeight: z.int().positive(),
  samples: z.array(
    z.strictObject({
      frame: natural,
      time: timeSchema,
      x: natural,
      y: natural,
    }),
  ),
});
export const inspectionJsonSchemas = {
  'project inspect': z.toJSONSchema(projectInspectionSchema),
  'timeline inspect': z.toJSONSchema(timelineInspectionSchema),
  'preview frame': z.toJSONSchema(previewFrameSchema),
  'preview contact-sheet': z.toJSONSchema(previewSheetSchema),
  'preview clip': z.toJSONSchema(previewClipSchema),
};

/** A detached, revision-tagged content snapshot, without potentially huge undo stacks. */
export function inspectProject(project: Project, path: string) {
  const snapshot = projectSnapshot(project);
  return projectInspectionSchema.parse({
    ...snapshot,
    inspectionVersion: 1,
    path,
    revision: projectRevision(project),
    duration: listTimeline(project).duration,
  });
}

/** Point inspection uses the exact evaluator consumed by the Project viewer. */
export function inspectTimeline(project: Project, path: string, frame: number) {
  return timelineInspectionSchema.parse({
    inspectionVersion: 1,
    path,
    projectId: project.metadata.id,
    revision: projectRevision(project),
    frame,
    frameRate: project.settings.frameRate,
    ...evaluateTimelineFrame(project, frame),
  });
}
