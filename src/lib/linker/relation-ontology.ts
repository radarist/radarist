/**
 * @file relation-ontology.ts
 * @description Relation type validation and canonicalization (Universal Relations Sprint)
 *
 * This module defines which relation types are valid between entity type pairs
 * and ensures relations are stored in canonical direction.
 *
 * **Key Features:**
 * - Validation matrix for all entity type pairs
 * - Canonical direction enforcement
 * - Symmetric relation handling
 * - Runtime validation with helpful error messages
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import type { EntityType, RelationType } from '@/lib/types';
import {
  isSymmetricRelationType,
  SYMMETRIC_RELATION_TYPES,
} from '@/lib/relation-symmetry-contract';

// ============================================================================
// RELATION ONTOLOGY
// ============================================================================

/**
 * Valid relation types for each source → target entity type pair.
 *
 * To read: RELATION_ONTOLOGY[sourceType][targetType] = [valid relation types]
 *
 * Example: RELATION_ONTOLOGY['company']['technology'] = ['vendor', 'user', 'develops']
 * Means: A company can be a vendor of, user of, or developer of a technology.
 */
export const RELATION_ONTOLOGY: Record<EntityType, Partial<Record<EntityType, RelationType[]>>> = {
  // ========== COMPANY Relations ==========
  company: {
    company: ['partner', 'competitor', 'acquired_by', 'invested_in', 'customer_of', 'supplier_of', 'custom'],
    technology: ['uses', 'vendor', 'user', 'invested_in', 'custom'],
    useCase: ['addresses', 'custom'],
    prototype: ['supports', 'custom'],
    strategy: ['aligns_with', 'custom'],
    signal: ['mentions', 'about', 'custom'],
    document: ['about', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['sponsors', 'custom'],
    painPoint: ['experiences', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== TECHNOLOGY Relations ==========
  technology: {
    company: ['vendor', 'user', 'custom'],
    technology: ['uses', 'enables', 'competes_with', 'integrates_with', 'alternative_to', 'built_on', 'custom'],
    useCase: ['enables', 'addresses', 'custom'],
    prototype: ['supports', 'custom'],
    strategy: ['aligns_with', 'custom'],
    signal: ['about', 'custom'],
    document: ['documented_in', 'about', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['invests_in', 'custom'],
    painPoint: ['solves', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== USE CASE Relations ==========
  useCase: {
    company: ['addresses', 'custom'],
    technology: ['requires', 'enables', 'custom'],
    useCase: ['complements', 'custom'],
    prototype: ['demonstrates', 'custom'],
    strategy: ['aligns_with', 'custom'],
    signal: ['informed_by', 'custom'],
    document: ['documented_in', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['custom'],
    painPoint: ['addresses', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== PROTOTYPE Relations ==========
  prototype: {
    company: ['custom'],
    technology: ['uses', 'supports', 'custom'],
    useCase: ['demonstrates', 'custom'],
    prototype: ['custom'],
    strategy: ['aligns_with', 'custom'],
    signal: ['informed_by', 'custom'],
    document: ['documented_in', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['funds', 'custom'],
    painPoint: ['solves', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== STRATEGY Relations ==========
  strategy: {
    company: ['custom'],
    technology: ['aligns_with', 'custom'],
    useCase: ['aligns_with', 'addresses', 'custom'],
    prototype: ['aligns_with', 'custom'],
    strategy: ['conflicts_with', 'custom'],
    signal: ['informed_by', 'custom'],
    document: ['documented_in', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['drives', 'implements', 'custom'],
    painPoint: ['addresses', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== SIGNAL Relations ==========
  signal: {
    company: ['mentions', 'about', 'custom'],
    technology: ['mentions', 'about', 'custom'],
    useCase: ['custom'],
    prototype: ['custom'],
    strategy: ['informed_by', 'custom'],
    signal: ['evidences', 'parallels', 'narrows_to', 'custom'],
    document: ['source', 'custom'],
    orgUnit: ['custom'],
    initiative: ['custom'],
    painPoint: ['reveals', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== DOCUMENT Relations ==========
  document: {
    company: ['about', 'custom'],
    technology: ['about', 'documented_in', 'custom'],
    useCase: ['about', 'custom'],
    prototype: ['about', 'custom'],
    strategy: ['about', 'custom'],
    signal: ['source', 'custom'],
    document: ['references', 'supersedes', 'supplements', 'cites', 'related_to', 'custom'],
    orgUnit: ['owned_by', 'custom'],
    initiative: ['about', 'custom'],
    painPoint: ['about', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== ORG UNIT Relations ==========
  orgUnit: {
    company: ['partner', 'custom'],
    technology: ['uses', 'custom'],
    useCase: ['owned_by', 'custom'],
    prototype: ['owned_by', 'custom'],
    strategy: ['owned_by', 'custom'],
    signal: ['custom'],
    document: ['owned_by', 'custom'],
    orgUnit: ['parent', 'child', 'custom'],
    initiative: ['sponsors', 'custom'],
    painPoint: ['experiences', 'impacts', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== INITIATIVE Relations ==========
  initiative: {
    company: ['engages', 'custom'],
    technology: ['invests_in', 'uses', 'custom'],
    useCase: ['custom'],
    prototype: ['funds', 'custom'],
    strategy: ['implements', 'aligns_with', 'custom'],
    signal: ['custom'],
    document: ['custom'],
    orgUnit: ['sponsors', 'custom'],
    initiative: ['custom'],
    painPoint: ['addresses', 'drives', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== PAIN POINT Relations ==========
  painPoint: {
    company: ['experiences', 'custom'],
    technology: ['solves', 'custom'],
    useCase: ['addresses', 'custom'],
    prototype: ['solves', 'custom'],
    strategy: ['addresses', 'custom'],
    signal: ['reveals', 'custom'],
    document: ['documented_in', 'custom'],
    orgUnit: ['impacts', 'experiences', 'custom'],
    initiative: ['drives', 'custom'],
    painPoint: ['compounds', 'custom'],
    radarPlacement: ['custom'],
  },

  // ========== RADAR PLACEMENT Relations ==========
  radarPlacement: {
    company: ['custom'],
    technology: ['custom'],
    useCase: ['custom'],
    prototype: ['custom'],
    strategy: ['custom'],
    signal: ['custom'],
    document: ['custom'],
    orgUnit: ['custom'],
    initiative: ['custom'],
    painPoint: ['custom'],
    radarPlacement: ['custom'],
  },
};

// ============================================================================
// SYMMETRIC RELATIONS
// ============================================================================

/**
 * Symmetric relation types where direction doesn't matter.
 * A→B implies B→A for these types.
 */
export const SYMMETRIC_RELATIONS: readonly RelationType[] =
  SYMMETRIC_RELATION_TYPES;

/**
 * Checks if a relation type is symmetric.
 */
export function isSymmetricRelation(relationType: RelationType): boolean {
  return isSymmetricRelationType(relationType);
}

// ============================================================================
// CANONICAL DIRECTION
// ============================================================================

/**
 * Canonical direction for relation types.
 * Ensures consistent storage regardless of how the relation was discovered.
 *
 * Format: RelationType → [preferredSourceType, preferredTargetType]
 *
 * If the actual source/target types don't match, the relation should be swapped.
 *
 * NOTE: this is direction metadata, unrelated to the Neo4j predicate
 * mapping — see `src/lib/graph/relation-registry.ts` for that.
 */
export const CANONICAL_DIRECTION: Partial<Record<RelationType, [EntityType, EntityType]>> = {
  // Company-Technology relations
  vendor: ['company', 'technology'], // Company is vendor OF Technology
  user: ['company', 'technology'], // Company uses Technology

  // Technology relations
  // `uses` also supports Company -> Technology in RELATION_ONTOLOGY. This
  // preference applies to the Technology -> Technology variant; pair-specific
  // validation canonicalizes the company variant before this legacy helper.
  uses: ['technology', 'technology'], // Technology A uses Technology B
  enables: ['technology', 'technology'], // Technology A enables Technology B

  // Strategy relations
  aligns_with: ['strategy', 'technology'], // Strategy aligns with Technology

  // Pain Point relations
  solves: ['technology', 'painPoint'], // Technology solves PainPoint
  addresses: ['useCase', 'painPoint'], // UseCase addresses PainPoint
  experiences: ['company', 'painPoint'], // Company experiences PainPoint
  impacts: ['painPoint', 'orgUnit'], // PainPoint impacts OrgUnit
  reveals: ['signal', 'painPoint'], // Signal reveals PainPoint

  // Document relations
  documented_in: ['technology', 'document'], // Technology documented in Document
  source: ['document', 'signal'], // Document is source of Signal
  about: ['document', 'technology'], // Document is about Technology

  // Org Unit relations
  owned_by: ['prototype', 'orgUnit'], // Prototype owned by OrgUnit
  parent: ['orgUnit', 'orgUnit'], // OrgUnit is parent of OrgUnit
  child: ['orgUnit', 'orgUnit'], // OrgUnit is child of OrgUnit

  // Initiative relations
  sponsors: ['orgUnit', 'initiative'], // OrgUnit sponsors Initiative
  funds: ['initiative', 'prototype'], // Initiative funds Prototype
  implements: ['initiative', 'strategy'], // Initiative implements Strategy
  drives: ['painPoint', 'initiative'], // PainPoint drives Initiative
  invests_in: ['initiative', 'technology'], // Initiative invests in Technology

  // Prototype/UseCase relations
  demonstrates: ['prototype', 'useCase'], // Prototype demonstrates UseCase
  requires: ['useCase', 'technology'], // UseCase requires Technology
  supports: ['technology', 'prototype'], // Technology supports Prototype

  // Signal relations
  mentions: ['signal', 'technology'], // Signal mentions Technology
  informed_by: ['strategy', 'signal'], // Strategy informed by Signal

  // Enhanced relations (v2)
  acquired_by: ['company', 'company'], // Company acquired by Company
  invested_in: ['company', 'company'], // Company invested in Company
  integrates_with: ['technology', 'technology'], // Technology integrates with Technology
  alternative_to: ['technology', 'technology'], // Technology is alternative to Technology
  built_on: ['technology', 'technology'], // Technology built on Technology
  customer_of: ['company', 'company'], // Company is customer of Company
  supplier_of: ['company', 'company'], // Company is supplier of Company

  // Document-to-document relations
  references: ['document', 'document'], // Document references another Document
  supersedes: ['document', 'document'], // Document supersedes older Document
  supplements: ['document', 'document'], // Document supplements another Document
  cites: ['document', 'document'], // Document cites another Document

  // 2026-05-13 — new verbs (custom-bucket audit). Directions match
  // the semantic phrasing in the verifier prompt; symmetric verbs
  // (`parallels`, `complements`, `conflicts_with`) are still listed
  // so a single canonical pair-type is enforced, but direction-swap
  // is a no-op via SYMMETRIC_RELATIONS.
  evidences: ['signal', 'signal'], // Concrete-evidence Signal evidences trend-Signal
  parallels: ['signal', 'signal'], // Two peer Signals describing the same phenomenon
  narrows_to: ['signal', 'signal'], // Broader Signal narrows to a specific Signal
  complements: ['useCase', 'useCase'], // Two use cases reinforce each other
  compounds: ['painPoint', 'painPoint'], // PainPoint A intensifies PainPoint B
  conflicts_with: ['strategy', 'strategy'], // Two Strategies in tension
  engages: ['initiative', 'company'], // Initiative engages a Company (vendor/partner)
};

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Result of relation validation.
 */
export interface ValidationResult {
  /** Whether the relation is valid */
  valid: boolean;
  /** Whether source and target should be swapped */
  shouldSwap: boolean;
  /** Error message if invalid */
  error?: string;
  /** Suggested relation types if the given one is invalid */
  suggestions?: RelationType[];
}

/**
 * Validates a relation between two entity types.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @param relationType - Proposed relation type
 * @returns Validation result
 *
 * @example
 * validateRelation('company', 'technology', 'vendor')
 * // { valid: true, shouldSwap: false }
 *
 * validateRelation('technology', 'company', 'vendor')
 * // { valid: true, shouldSwap: true } // Should swap to company → technology
 *
 * validateRelation('company', 'technology', 'parent')
 * // { valid: false, error: "...", suggestions: ['vendor', 'user'] }
 */
export function validateRelation(
  sourceType: EntityType,
  targetType: EntityType,
  relationType: RelationType
): ValidationResult {
  // Get valid types for this entity pair
  const validTypes = RELATION_ONTOLOGY[sourceType]?.[targetType] || [];

  // Check if relation type is valid for this direction
  if (validTypes.includes(relationType)) {
    return { valid: true, shouldSwap: false };
  }

  // Check reverse direction
  const reverseTypes = RELATION_ONTOLOGY[targetType]?.[sourceType] || [];
  if (reverseTypes.includes(relationType)) {
    return { valid: true, shouldSwap: true };
  }

  // Invalid relation
  const allSuggestions = [...validTypes, ...reverseTypes];
  const uniqueSuggestions = [...new Set(allSuggestions)].filter((t) => t !== 'custom');

  return {
    valid: false,
    shouldSwap: false,
    error: `Invalid relation type '${relationType}' between ${sourceType} and ${targetType}`,
    suggestions: uniqueSuggestions.length > 0 ? uniqueSuggestions : undefined,
  };
}

/**
 * Gets all valid relation types for an entity pair.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @returns Array of valid relation types
 */
export function getValidRelationTypes(sourceType: EntityType, targetType: EntityType): RelationType[] {
  const forward = RELATION_ONTOLOGY[sourceType]?.[targetType] || [];
  const reverse = RELATION_ONTOLOGY[targetType]?.[sourceType] || [];

  // Combine and deduplicate
  return [...new Set([...forward, ...reverse])];
}

// ============================================================================
// CANONICALIZATION
// ============================================================================

/**
 * Input for canonicalization (minimal ProposedRelation fields).
 */
interface CanonicalizationInput {
  sourceType: EntityType;
  sourceId: string;
  sourceSnapshot: { type: EntityType; id: string; name: string; [key: string]: unknown };
  targetType: EntityType;
  targetId: string;
  targetSnapshot: { type: EntityType; id: string; name: string; [key: string]: unknown };
  relationType: RelationType;
}

/**
 * Canonicalizes a relation to ensure consistent storage.
 *
 * For relations with defined canonical direction, swaps source/target
 * if necessary. For symmetric relations, sorts by entity ID.
 *
 * @param relation - The relation to canonicalize
 * @returns Canonicalized relation (may have swapped source/target)
 *
 * @example
 * // If we have "technology → company (vendor)", it should be "company → technology (vendor)"
 * canonicalizeRelation({
 *   sourceType: 'technology', sourceId: 'tech-1', ...
 *   targetType: 'company', targetId: 'company-1', ...
 *   relationType: 'vendor'
 * })
 * // Returns relation with source/target swapped
 */
export function canonicalizeRelation<T extends CanonicalizationInput>(relation: T): T {
  const canonical = CANONICAL_DIRECTION[relation.relationType];

  // If no canonical direction defined, check symmetric
  if (!canonical) {
    if (isSymmetricRelation(relation.relationType)) {
      // For symmetric relations, sort by entity ID for consistency
      if (relation.sourceId > relation.targetId) {
        return swapRelation(relation);
      }
    }
    return relation;
  }

  // Check if current direction matches canonical
  const [preferredSource, _preferredTarget] = canonical;

  // If source type doesn't match canonical, swap
  if (relation.sourceType !== preferredSource && relation.targetType === preferredSource) {
    return swapRelation(relation);
  }

  return relation;
}

/**
 * Swaps source and target of a relation.
 */
function swapRelation<T extends CanonicalizationInput>(relation: T): T {
  return {
    ...relation,
    sourceType: relation.targetType,
    sourceId: relation.targetId,
    sourceSnapshot: relation.targetSnapshot,
    targetType: relation.sourceType,
    targetId: relation.sourceId,
    targetSnapshot: relation.sourceSnapshot,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Gets a human-readable description of a relation.
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @param relationType - Relation type
 * @returns Human-readable description
 *
 * @example
 * getRelationDescription('company', 'technology', 'vendor')
 * // "Company is vendor of Technology"
 */
export function getRelationDescription(
  sourceType: EntityType,
  targetType: EntityType,
  relationType: RelationType
): string {
  const descriptions: Partial<Record<RelationType, string>> = {
    uses: `${sourceType} uses ${targetType}`,
    enables: `${sourceType} enables ${targetType}`,
    competes_with: `${sourceType} competes with ${targetType}`,
    vendor: `${sourceType} is vendor of ${targetType}`,
    user: `${sourceType} uses ${targetType}`,
    partner: `${sourceType} partners with ${targetType}`,
    competitor: `${sourceType} competes with ${targetType}`,
    addresses: `${sourceType} addresses ${targetType}`,
    requires: `${sourceType} requires ${targetType}`,
    aligns_with: `${sourceType} aligns with ${targetType}`,
    supports: `${sourceType} supports ${targetType}`,
    owned_by: `${sourceType} is owned by ${targetType}`,
    sponsors: `${sourceType} sponsors ${targetType}`,
    funds: `${sourceType} funds ${targetType}`,
    solves: `${sourceType} solves ${targetType}`,
    impacts: `${sourceType} impacts ${targetType}`,
    drives: `${sourceType} drives ${targetType}`,
    mentions: `${sourceType} mentions ${targetType}`,
    documented_in: `${sourceType} is documented in ${targetType}`,
    source: `${sourceType} is source of ${targetType}`,
    reveals: `${sourceType} reveals ${targetType}`,
    experiences: `${sourceType} experiences ${targetType}`,
    invests_in: `${sourceType} invests in ${targetType}`,
    parent: `${sourceType} is parent of ${targetType}`,
    child: `${sourceType} is child of ${targetType}`,
    demonstrates: `${sourceType} demonstrates ${targetType}`,
    implements: `${sourceType} implements ${targetType}`,
    informed_by: `${sourceType} is informed by ${targetType}`,
    about: `${sourceType} is about ${targetType}`,
    // Enhanced relation descriptions
    acquired_by: `${sourceType} was acquired by ${targetType}`,
    invested_in: `${sourceType} invested in ${targetType}`,
    integrates_with: `${sourceType} integrates with ${targetType}`,
    alternative_to: `${sourceType} is alternative to ${targetType}`,
    built_on: `${sourceType} is built on ${targetType}`,
    customer_of: `${sourceType} is customer of ${targetType}`,
    supplier_of: `${sourceType} is supplier of ${targetType}`,
    // Document-to-document relation descriptions
    references: `${sourceType} references ${targetType}`,
    supersedes: `${sourceType} supersedes ${targetType}`,
    supplements: `${sourceType} supplements ${targetType}`,
    cites: `${sourceType} cites ${targetType}`,
    related_to: `${sourceType} is related to ${targetType}`,
    custom: `${sourceType} relates to ${targetType}`,
  };

  return descriptions[relationType] || `${sourceType} ${relationType} ${targetType}`;
}

/**
 * Gets all entity types that can be related to a given entity type.
 *
 * @param entityType - The entity type to check
 * @returns Array of entity types that can be related
 */
export function getRelatedEntityTypes(entityType: EntityType): EntityType[] {
  const relatedTypes = new Set<EntityType>();

  // Check what this type can be source to
  const asSource = RELATION_ONTOLOGY[entityType];
  if (asSource) {
    Object.keys(asSource).forEach((t) => relatedTypes.add(t as EntityType));
  }

  // Check what can be source to this type
  for (const [sourceType, targets] of Object.entries(RELATION_ONTOLOGY)) {
    if (targets && entityType in targets) {
      relatedTypes.add(sourceType as EntityType);
    }
  }

  return Array.from(relatedTypes);
}
