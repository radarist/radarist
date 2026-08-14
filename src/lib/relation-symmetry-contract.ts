import type { RelationType } from '@/lib/types/relations';

/**
 * Direction-insensitive relation vocabulary shared by discovery, proposals,
 * duplicate prevention, lock keys, and repair. Keep this module dependency
 * free because relation persistence also ships in the browser bundle.
 */
export const SYMMETRIC_RELATION_TYPES = [
  'partner',
  'competitor',
  'competes_with',
  'integrates_with',
  'alternative_to',
  'related_to',
  'parallels',
  'complements',
  'conflicts_with',
] as const satisfies readonly RelationType[];

const SYMMETRIC_RELATION_TYPE_SET: ReadonlySet<RelationType> = new Set(
  SYMMETRIC_RELATION_TYPES
);

export function isSymmetricRelationType(relationType: RelationType): boolean {
  return SYMMETRIC_RELATION_TYPE_SET.has(relationType);
}
