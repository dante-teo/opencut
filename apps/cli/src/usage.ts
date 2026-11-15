export class UsageError extends Error {}

export function positiveIntegerOption(key: string, value?: string) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0)
    throw new UsageError(`--${key} must be a positive integer.`);
  return n;
}
