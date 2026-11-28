import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  fileFingerprintSchema,
  inspectOutputFingerprint,
  matchesFingerprint,
} from './video-integrity.js';

const reportSchema = z.object({
  path: z.string().min(1),
  frameCount: z.int().positive(),
  definitionPath: z.string().min(1).optional(),
  metadata: z.object({ path: z.string() }).optional(),
  preflight: z.object({ event: z.string() }).optional(),
  verification: z.object({ completeDecode: z.boolean() }).optional(),
  outputFingerprint: z.unknown().optional(),
});

export async function readDeliveryReport(
  file: string,
  definition: string,
  signal?: AbortSignal,
) {
  const reportPath = resolve(file);
  const text = await readFile(reportPath, { encoding: 'utf8', signal });
  const unsupported = () =>
    Object.assign(
      new Error(
        `'${reportPath}' is not a supported OpenCut delivery report. Use the JSON from a completed render, remix or picture revision.`,
      ),
      { code: 'UNSUPPORTED_RENDER_REPORT' },
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw unsupported();
  }
  const { data: report } = reportSchema.safeParse(raw);
  if (
    !report ||
    (report.metadata
      ? report.metadata.path !== report.path
      : report.preflight?.event !== 'picture-revision-preflight' ||
        report.verification?.completeDecode !== true)
  )
    throw unsupported();

  const fromReport = (path: string) => resolve(dirname(reportPath), path);
  if (report.definitionPath) {
    const recorded = fromReport(report.definitionPath);
    if ((await realpath(recorded).catch(() => recorded)) !== definition)
      throw Object.assign(
        new Error(
          `Render report belongs to '${recorded}'. Inspect that timeline or supply a report for '${definition}'.`,
        ),
        {
          code: 'RENDER_REPORT_TIMELINE_MISMATCH',
        },
      );
  }
  const output = fromReport(report.path);
  const delivery = { reportPath, output };
  const expected = fileFingerprintSchema.safeParse(report.outputFingerprint);
  if (!expected.success)
    return {
      ...delivery,
      reason: 'missing-or-invalid-fingerprint',
    } as const;
  const actual = await inspectOutputFingerprint(output, signal);
  return {
    ...delivery,
    reason: !actual
      ? 'missing-or-unreadable-output'
      : matchesFingerprint(actual, expected.data)
        ? undefined
        : 'fingerprint-mismatch',
  } as const;
}
