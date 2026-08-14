import { RELATION_TYPES_LOWER } from '@/lib/graph/relation-registry';
export {
  isSymmetricRelationType,
  SYMMETRIC_RELATION_TYPES,
} from '@/lib/relation-symmetry-contract';
import type { RelationType } from '@/lib/types/relations';

const CANONICAL_RELATION_TYPES: ReadonlySet<string> = new Set(RELATION_TYPES_LOWER);

export class InvalidRelationTypeError extends Error {
  readonly value: unknown;

  constructor(value: unknown) {
    super(`Invalid relationType: ${typeof value === 'string' ? `"${value}"` : String(value)}`);
    this.name = 'InvalidRelationTypeError';
    this.value = value;
  }
}

export function isCanonicalRelationType(value: unknown): value is RelationType {
  return typeof value === 'string' && CANONICAL_RELATION_TYPES.has(value);
}

/**
 * Runtime guard for JSON, scripts, and untyped callers. TypeScript's
 * RelationType union disappears at runtime and cannot protect Firestore from
 * legacy aliases, typos, or arbitrary strings.
 */
export function assertCanonicalRelationType(value: unknown): asserts value is RelationType {
  if (!isCanonicalRelationType(value)) {
    throw new InvalidRelationTypeError(value);
  }
}

export function parseCanonicalRelationType(value: unknown): RelationType {
  assertCanonicalRelationType(value);
  return value;
}
