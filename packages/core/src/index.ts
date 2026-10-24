/** Application identity only; no editing model exists in T01. */
export interface ApplicationInfo {
  readonly name: string;
  readonly version: string;
}

export function getApplicationInfo(): ApplicationInfo {
  return { name: 'OpenCut', version: '0.1.0' };
}
