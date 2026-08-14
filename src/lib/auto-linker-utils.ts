/**
 * @file auto-linker-utils.ts
 * @description Client-side utility functions for auto-linker
 *
 * These functions are separated from the main auto-linker.ts because
 * they need to run on the client and don't need server actions.
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import type { EntitySnapshot, EntityType, RelationType } from "@/lib/types";

/**
 * Represents a suggested relation with a matched entity
 */
export interface SuggestedRelation {
  /** The type of entity being linked to */
  entityType: EntityType;
  /** The entity ID */
  entityId: string;
  /** The entity name */
  entityName: string;
  /** Optional entity description */
  entityDescription?: string;
  /** Suggested relation type */
  relationType: RelationType;
  /** Confidence score 0-100 */
  confidence: number;
  /** Context from the source text (used as evidence snippet) */
  context?: string;
  /** AI reasoning summary for the suggestion (Phase 4) */
  reasoningSummary?: string;
}

/**
 * Creates an EntitySnapshot from a suggested relation
 * Used when creating a relation from a suggestion
 */
export function createSnapshotFromSuggestion(suggestion: SuggestedRelation): EntitySnapshot {
  return {
    type: suggestion.entityType,
    id: suggestion.entityId,
    name: suggestion.entityName,
    description: suggestion.entityDescription,
    snapshotAt: Date.now(),
  };
}
