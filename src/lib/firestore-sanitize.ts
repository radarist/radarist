/**
 * Remove values that Firestore cannot persist while preserving SDK objects.
 * Undefined object fields are omitted; undefined array entries become null so
 * indexes remain stable.
 */
export function sanitizeForFirestore<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sanitizeForFirestore(item))) as T;
  }

  if (!isPlainRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      sanitized[key] = sanitizeForFirestore(item);
    }
  }
  return sanitized as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
