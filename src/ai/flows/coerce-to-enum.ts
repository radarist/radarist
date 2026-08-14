/**
 * @file ai/flows/coerce-to-enum.ts
 * @description AI-028 — formatting-only normalization for model-supplied enum values.
 *
 * Lives outside `research-company-comprehensive.ts` because that module is a
 * `'use server'` Server Actions file, where every export must be an async
 * function. Keeping the helper here makes it directly testable too.
 *
 * @author Radarist Team
 * @created 2026-07-19
 */

/**
 * Normalize the FORMATTING of a model-supplied enum value. Never infer meaning
 * from surrounding prose.
 *
 * This previously fell back to `startsWith` and then to a bare `includes` scan
 * over the whole string, which is the same defect as the deleted regex parser
 * one layer down: `"not yet public"` resolved to `public`, `"publicly available
 * API, bootstrapped"` resolved to `public` rather than `bootstrapped`, and
 * `"seed-stage rumours, unconfirmed"` resolved to `seed`. Those values were then
 * persisted as confident facts.
 *
 * Only formatting differences are reconciled — case, surrounding whitespace, and
 * `-`/space used where the enum uses `_`. Anything else returns `undefined`,
 * which the schema records as absent rather than guessed.
 *
 * @param allowedValues - The enum members to match against.
 * @returns A coercer returning a member, or `undefined` when there is no
 *   formatting-equivalent match.
 */
export const coerceToEnum =
  <T extends string>(allowedValues: readonly T[]) =>
  (val: unknown): T | undefined => {
    if (typeof val !== 'string') return undefined;

    // Collapse separators so "Series B" and "series-b" both reach "series_b",
    // without ever letting extra words in the string select a value.
    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .trim()
        .replace(/[\s-]+/g, '_');

    const candidate = normalize(val);
    return allowedValues.find((allowed) => normalize(allowed) === candidate);
  };
