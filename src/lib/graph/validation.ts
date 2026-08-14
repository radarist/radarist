/**
 * Cypher interpolation guards.
 *
 * Centralizes the whitelists (relation types, labels, ORDER BY columns) and
 * coercions (limit, depth) used at every site in the graph layer that must
 * interpolate caller-controlled strings into Cypher (Cypher's parameter
 * binding cannot stand in for relation types, labels, or path quantifiers).
 *
 * The single source of truth for the relation-type vocabulary is
 * `relation-registry.ts` (`RELATION_TYPES_LOWER` / `RELATION_TYPES_UPPER`),
 * which itself derives from `RelationType` in `src/lib/types/relations.ts`
 * via a compile-time `_Exhaustive` check.
 */

import { z } from 'zod';
import type { RelationType } from '@/lib/types/relations';
import { RELATION_TYPES_LOWER, RELATION_TYPES_UPPER } from './relation-registry';

/** Lowercase form (Firestore canonical). */
export const relationTypeLowerSchema = z.enum(RELATION_TYPES_LOWER);

/**
 * Either lowercase OR UPPER_SNAKE form. Cypher edges are stored upper case
 * in Neo4j, so any string accepted by this schema is safe to interpolate
 * inside a relation-type slot.
 *
 * Note: we deliberately do NOT silently `.toUpperCase()` here — that would
 * corrupt callers expecting lowercase to round-trip.
 */
export const relationTypeCypherSchema = z
  .string()
  .refine((v) => RELATION_TYPES_LOWER.includes(v as RelationType) || RELATION_TYPES_UPPER.includes(v), {
    message: 'Invalid relation type',
  });

/**
 * LIMIT clause coercion. Coerces strings (`"10"`) to numbers; floors floats
 * (matching prior Math.floor behavior); rejects NaN / Infinity / oversize.
 * Malicious strings like `"10; DROP"` coerce to NaN and fail `.finite()`.
 */
export const limitSchema = z.coerce
  .number()
  .finite()
  .min(1)
  .max(1000)
  .transform((n) => Math.floor(n));

/** Path-length quantifier coercion. Same posture as limitSchema. */
export const depthSchema = z.coerce
  .number()
  .finite()
  .min(1)
  .max(10)
  .transform((n) => Math.floor(n));

/** Closed set of ORDER BY columns supported by `cypher-templates.buildFilteredQuery`. */
export const orderBySchema = z.enum(['n.name', 'n.createdAt', 'n.updatedAt', 'r.confidence', 'r.t_observed']);

/** Node label syntactic check (Cypher identifier shape). */
export const labelSchema = z.string().regex(/^[A-Z][A-Za-z0-9_]*$/);

/**
 * Typed error for graph-input validation failures. Lets callers decide
 * policy (rethrow vs early-return-empty vs log-and-skip) without conflating
 * with arbitrary thrown values from the driver.
 */
export class InvalidGraphInputError extends Error {
  constructor(
    public field: string,
    public value: unknown,
    public override cause: z.ZodError
  ) {
    super(`Invalid ${field}: ${cause.issues.map((i) => i.message).join(', ')}`);
    this.name = 'InvalidGraphInputError';
  }
}
