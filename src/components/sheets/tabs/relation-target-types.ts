/**
 * @file components/sheets/tabs/relation-target-types.ts
 * @description UX-054 — the one list of entity types the relation UI advertises
 * as valid link targets.
 *
 * Offering a type in the picker is a promise that choosing it creates a
 * relation. That promise was previously made in three places that could drift:
 * `RelationPicker`'s default `entityTypes`, `RelationsTab`'s type filter, and
 * whatever `switch` each page's `handleAddRelation` happened to implement. The
 * Use Case page advertised nine types and resolved six, so Pain Point, Org Unit,
 * and Initiative Adds closed without writing anything.
 *
 * Every advertised type here must be resolvable by BOTH snapshot resolvers —
 * `buildEntitySnapshot` (server, behind `POST /api/relations/from-ids`) and
 * `buildTargetSnapshot` (client). `relation-target-types.contract.test.ts`
 * reads both resolvers and fails if this list outgrows either.
 *
 * `document` and `radarPlacement` are deliberately absent: they are not
 * user-linkable entities in this UI. Adding one means teaching the resolvers
 * first.
 */

import type { EntityType } from '@/lib/types';

// `as const satisfies` rather than a widened `readonly EntityType[]`: each entry
// is still checked against EntityType, but the literal tuple type is preserved
// so the label map below is exhaustive over exactly these types — adding one
// here without a label is a compile error.
export const RELATION_TARGET_ENTITY_TYPES = [
  'company',
  'technology',
  'useCase',
  'prototype',
  'strategy',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
] as const satisfies readonly EntityType[];

export type RelationTargetEntityType = (typeof RELATION_TARGET_ENTITY_TYPES)[number];

/** Whether a type may be offered as a relation target. */
export function isRelationTargetEntityType(type: EntityType): type is RelationTargetEntityType {
  return (RELATION_TARGET_ENTITY_TYPES as readonly EntityType[]).includes(type);
}

/** Plural labels for the relation type filter. */
export const RELATION_TARGET_TYPE_LABELS: Record<RelationTargetEntityType, string> = {
  company: 'Companies',
  technology: 'Technologies',
  useCase: 'Use Cases',
  prototype: 'Prototypes',
  strategy: 'Strategies',
  signal: 'Signals',
  orgUnit: 'Org Units',
  initiative: 'Initiatives',
  painPoint: 'Pain Points',
};
