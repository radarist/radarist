/**
 * @file technology-reference-cleanup.ts
 * @description Shared plan for removing reverse references before Technology deletion.
 *
 * This module is intentionally Firebase-free so the client and Admin SDK
 * cascades execute the same indexed queries without crossing runtime boundaries.
 */

import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';

/** Leave headroom below Firestore's 500-write batch limit. */
export const TECHNOLOGY_REFERENCE_CLEANUP_BATCH_SIZE = 450;

export interface TechnologyReferenceCleanupTarget {
  readonly collection: string;
  readonly field: 'linkedTechnologies' | 'radarTechnologyIds' | 'linkedTechnologyIds';
}

/**
 * Every array field that can retain a Technology ID after its source is gone.
 * Each field supports a single-field `array-contains` query without a composite
 * index, allowing both cascades to process bounded, retry-safe chunks.
 */
export const TECHNOLOGY_REFERENCE_CLEANUP_TARGETS: readonly TechnologyReferenceCleanupTarget[] = [
  {
    collection: ENTITY_COLLECTIONS.prototype,
    field: 'linkedTechnologies',
  },
  {
    collection: ENTITY_COLLECTIONS.useCase,
    field: 'radarTechnologyIds',
  },
  {
    collection: ENTITY_COLLECTIONS.painPoint,
    field: 'linkedTechnologyIds',
  },
];
