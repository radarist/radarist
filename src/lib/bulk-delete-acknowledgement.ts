/**
 * Client-safe validation for destructive bulk-delete acknowledgements.
 * Selection may only change after every requested ID has an exact outcome.
 */

export interface BulkDeleteAcknowledgement {
  success: boolean;
  deleted: number;
  failed: string[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseBulkDeleteAcknowledgement<TCountField extends string = never>(
  value: unknown,
  requestedIds: readonly string[],
  requiredCountFields: readonly TCountField[] = []
): BulkDeleteAcknowledgement & Record<TCountField, number> {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid bulk delete acknowledgement');
  }

  const requested = new Set(requestedIds);
  if (
    requested.size !== requestedIds.length ||
    requestedIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    throw new Error('Invalid bulk delete request partition');
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.success !== 'boolean' ||
    !isNonNegativeInteger(candidate.deleted) ||
    !Array.isArray(candidate.failed)
  ) {
    throw new Error('Invalid bulk delete acknowledgement');
  }

  const counts = {} as Record<TCountField, number>;
  for (const field of requiredCountFields) {
    const count = candidate[field];
    if (!isNonNegativeInteger(count)) {
      throw new Error('Invalid bulk delete acknowledgement');
    }
    counts[field] = count;
  }

  const failed = candidate.failed;
  const failedSet = new Set(failed);
  const hasExactPartition =
    failed.every((id): id is string => typeof id === 'string' && requested.has(id)) &&
    failedSet.size === failed.length &&
    candidate.deleted + failed.length === requestedIds.length &&
    candidate.success === (failed.length === 0);

  if (!hasExactPartition) {
    throw new Error('Incomplete bulk delete acknowledgement');
  }

  return {
    success: candidate.success,
    deleted: candidate.deleted,
    failed,
    ...counts,
  };
}
