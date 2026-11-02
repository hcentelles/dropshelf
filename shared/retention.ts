export const DAY_MS = 24 * 60 * 60_000;
export const DEFAULT_FILE_RETENTION_DAYS = 30;
export const DEFAULT_TRASH_RETENTION_DAYS = 7;
export const EXTENDED_RETENTION_DAYS = 30;

export type RetentionMode = '30-days' | 'permanent';

export interface RetentionPolicy { fileDays: number; trashDays: number }

export function parseRetentionDays(value: unknown, name: string): number {
  const days = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 0 || days > 36500) {
    throw new Error(`${name} must be a whole number from 0 to 36500 days. Use 0 to disable this step.`);
  }
  return days;
}

export function retentionPolicy(env: { FILE_RETENTION_DAYS?: string; TRASH_RETENTION_DAYS?: string }): RetentionPolicy {
  // An older instance must opt in through its deployment settings.
  return {
    fileDays: parseRetentionDays(env.FILE_RETENTION_DAYS ?? 0, 'FILE_RETENTION_DAYS'),
    trashDays: parseRetentionDays(env.TRASH_RETENTION_DAYS ?? 0, 'TRASH_RETENTION_DAYS'),
  };
}
