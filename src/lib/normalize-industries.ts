/**
 * @file normalize-industries.ts
 * @description Canonical normalization for the persisted `Company.industry` field.
 *
 * The `Company` type declares `industry: CompanyIndustry[]`, but documents in
 * practice carry mixed shapes: legacy and AI-imported docs store a plain
 * string (e.g. `"energy"`), some docs miss the field entirely, and curated
 * docs store the declared array. Any consumer that calls array methods on
 * `company.industry` MUST go through this helper instead of assuming the
 * declared shape — unguarded `.slice()/.join()/.some()/.filter()` on the
 * string shape is the root cause of the Competitors-tab ErrorBoundary crash.
 *
 * Client-safe, dependency-free.
 */

/**
 * Normalizes any persisted `industry` value to a clean string array.
 *
 * - `string[]`   → trimmed, non-empty string members (non-strings dropped)
 * - `string`     → single-element array (trimmed); `[]` when blank
 * - anything else (`null`, `undefined`, numbers, objects) → `[]`
 *
 * @param value - The raw `industry` value as read from Firestore
 * @returns A safe string array (possibly empty), never `null`/`undefined`
 */
export function normalizeIndustries(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}
