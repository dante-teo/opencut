import { SourceMap } from 'node:module';
import type { SourceMapPayload } from 'node:module';

const browserFrame =
  /https:\/\/graphics\.opencut\.invalid\/graphic\.js:(\d+):(\d+)/;

export function graphicsDiagnostics(encoded?: string) {
  let map: SourceMap | undefined;
  if (encoded) {
    try {
      map = new SourceMap(JSON.parse(encoded) as SourceMapPayload);
    } catch {
      // Legacy or unreadable debug data still has a generated location.
    }
  }
  return (cause: unknown) => {
    if (!(cause instanceof Error)) return String(cause);
    const message = cause.message.split('\n')[0] ?? cause.name;
    const frames = new Set<string>();
    for (const line of (cause.stack ?? cause.message)
      .split('\n')
      .slice(0, 25)) {
      const match = browserFrame.exec(line);
      if (!match) continue;
      const [, rawLine, rawColumn] = match;
      const location = map?.findOrigin(Number(rawLine), Number(rawColumn));
      if (location && 'fileName' in location)
        frames.add(
          `${location.fileName}:${location.lineNumber}:${location.columnNumber}`,
        );
      else frames.add(`graphic.js:${rawLine}:${rawColumn}`);
      if (frames.size === 4) break;
    }
    return [message, ...[...frames].map((frame) => '  at ' + frame)].join('\n');
  };
}
