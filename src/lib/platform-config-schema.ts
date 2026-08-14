/**
 * Pure platform-configuration types and validation shared by browser and
 * server runtimes. Keep Firebase imports out of this module.
 */

export const MIN_ARCHIVE_RETENTION_DAYS = 7;
export const MAX_ARCHIVE_RETENTION_DAYS = 365;
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;

const MIN_AUTO_ARCHIVE_REJECTED_DAYS = 0;
const MAX_AUTO_ARCHIVE_REJECTED_DAYS = 365;
const DEFAULT_AUTO_ARCHIVE_REJECTED_DAYS = 30;

export interface PlatformConfig {
  /** How long to keep archived signals before permanent deletion (days). */
  archiveRetentionDays: number;
  /**
   * Legacy reserved value. No current runtime job auto-archives rejected
   * signals, so this value is deliberately not exposed as a working setting.
   */
  autoArchiveRejectedDays: number;
  /** Last updated timestamp. */
  updatedAt: number;
  /** Who last updated the config. */
  updatedBy?: string;
}

export type PlatformConfigUpdates = Partial<
  Pick<PlatformConfig, 'archiveRetentionDays' | 'autoArchiveRejectedDays'>
>;

export function createDefaultPlatformConfig(): PlatformConfig {
  return {
    archiveRetentionDays: DEFAULT_ARCHIVE_RETENTION_DAYS,
    autoArchiveRejectedDays: DEFAULT_AUTO_ARCHIVE_REJECTED_DAYS,
    updatedAt: Date.now(),
  };
}

export function isValidArchiveRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ARCHIVE_RETENTION_DAYS &&
    value <= MAX_ARCHIVE_RETENTION_DAYS
  );
}

function isValidAutoArchiveRejectedDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_AUTO_ARCHIVE_REJECTED_DAYS &&
    value <= MAX_AUTO_ARCHIVE_REJECTED_DAYS
  );
}

/** Reject unsafe writes before either Firebase SDK is called. */
export function validatePlatformConfigUpdates(updates: PlatformConfigUpdates): void {
  if ('archiveRetentionDays' in updates && !isValidArchiveRetentionDays(updates.archiveRetentionDays)) {
    throw new RangeError(
      `archiveRetentionDays must be a whole number between ${MIN_ARCHIVE_RETENTION_DAYS} and ${MAX_ARCHIVE_RETENTION_DAYS}`
    );
  }

  if ('autoArchiveRejectedDays' in updates && !isValidAutoArchiveRejectedDays(updates.autoArchiveRejectedDays)) {
    throw new RangeError(
      `autoArchiveRejectedDays must be a whole number between ${MIN_AUTO_ARCHIVE_REJECTED_DAYS} and ${MAX_AUTO_ARCHIVE_REJECTED_DAYS}`
    );
  }
}

/**
 * Normalize untrusted persisted data field-by-field. An invalid retention
 * value must never reach the destructive cleanup worker.
 */
export function normalizePlatformConfig(value: unknown): PlatformConfig {
  const defaults = createDefaultPlatformConfig();
  if (typeof value !== 'object' || value === null) return defaults;

  const data = value as Record<string, unknown>;
  return {
    archiveRetentionDays: isValidArchiveRetentionDays(data.archiveRetentionDays)
      ? data.archiveRetentionDays
      : defaults.archiveRetentionDays,
    autoArchiveRejectedDays: isValidAutoArchiveRejectedDays(data.autoArchiveRejectedDays)
      ? data.autoArchiveRejectedDays
      : defaults.autoArchiveRejectedDays,
    updatedAt:
      typeof data.updatedAt === 'number' && Number.isInteger(data.updatedAt) && data.updatedAt >= 0
        ? data.updatedAt
        : defaults.updatedAt,
    ...(typeof data.updatedBy === 'string' && data.updatedBy.length > 0 ? { updatedBy: data.updatedBy } : {}),
  };
}
