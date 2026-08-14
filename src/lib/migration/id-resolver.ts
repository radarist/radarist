/**
 * @file src/lib/migration/id-resolver.ts
 * @description ID Resolution Service for Technology Decoupling Migration
 *
 * Phase 3 Task 3.2.2: Bridge old composite IDs (radarId:entryId) to new Technology IDs
 *
 * This service provides runtime resolution of legacy composite IDs to the new
 * Technology ID format during the migration transition period.
 *
 * Features:
 * - Load mappings from Firestore or JSON file
 * - In-memory caching for performance
 * - Fallback for unmapped IDs
 * - Logging for resolution failures
 * - Batch resolution for multiple IDs
 *
 * @usage
 * ```typescript
 * import { idResolver } from '@/lib/migration/id-resolver';
 *
 * // Resolve single ID
 * const techId = idResolver.resolveTechnologyId('nutrition-bu', 42);
 *
 * // Batch resolve
 * const resolved = await idResolver.batchResolve(['nutrition-bu:42', 'tech-bu:15']);
 * ```
 *
 * @author Radarist Team
 * @created 2026-01-10
 */

import { collection, doc, getDocs, setDoc, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';

const log = createLogger('migration/id-resolver');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Mapping from old composite ID to new Technology ID
 */
export interface IDMapping {
  /** Old format: "radarId:entryId" */
  oldId: string;
  /** Old format parsed: radarId component */
  radarId: string;
  /** Old format parsed: entryId component */
  entryId: number;
  /** New format: "tech-xxxxx-xxxx" */
  newTechnologyId: string;
  /** Optional: Placement ID if specific to a radar */
  placementId?: string;
  /** Technology name for reference */
  name: string;
  /** When the mapping was created */
  createdAt: number;
}

/**
 * Resolution result
 */
export interface ResolutionResult {
  /** Whether the ID was resolved */
  resolved: boolean;
  /** The resolved Technology ID (or original if new format) */
  technologyId: string | null;
  /** The placement ID if available */
  placementId?: string | null;
  /** The original input ID */
  originalId: string;
  /** Resolution method used */
  method: 'mapping' | 'passthrough' | 'fallback' | 'failed';
}

/**
 * Stats for monitoring resolution performance
 */
export interface ResolutionStats {
  totalResolutions: number;
  mappingHits: number;
  passthroughHits: number;
  fallbackHits: number;
  failures: number;
  cacheSize: number;
}

// ============================================================================
// ID RESOLVER CLASS
// ============================================================================

export class IDResolver {
  private mappings: Map<string, IDMapping> = new Map();
  private reverseMap: Map<string, string> = new Map(); // technologyId -> oldId
  private initialized = false;
  private stats: ResolutionStats = {
    totalResolutions: 0,
    mappingHits: 0,
    passthroughHits: 0,
    fallbackHits: 0,
    failures: 0,
    cacheSize: 0,
  };

  /**
   * Initialize the resolver by loading mappings from Firestore
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const snapshot = await getDocs(collection(db, 'migrationMappings'));

      snapshot.forEach((doc) => {
        const data = doc.data() as IDMapping;
        const key = `${data.radarId}:${data.entryId}`;
        this.mappings.set(key, data);
        this.reverseMap.set(data.newTechnologyId, key);
      });

      this.stats.cacheSize = this.mappings.size;
      this.initialized = true;

      log.info('Initialized ID resolver', { mappingCount: this.mappings.size });
    } catch (error) {
      log.error('Failed to load mappings', error instanceof Error ? error : undefined);
      // Don't throw - allow app to work without mappings
      this.initialized = true;
    }
  }

  /**
   * Load mappings from a JSON file (for scripts/testing)
   */
  loadFromJSON(mappings: IDMapping[]): void {
    this.mappings.clear();
    this.reverseMap.clear();

    for (const mapping of mappings) {
      const key = `${mapping.radarId}:${mapping.entryId}`;
      this.mappings.set(key, mapping);
      this.reverseMap.set(mapping.newTechnologyId, key);
    }

    this.stats.cacheSize = this.mappings.size;
    this.initialized = true;

    log.info('Loaded mappings from JSON', { mappingCount: this.mappings.size });
  }

  /**
   * Check if an ID is in the old composite format (radarId:entryId)
   */
  isCompositeId(id: string): boolean {
    // Old format: "radarId:entryId" where entryId is a number
    const parts = id.split(':');
    if (parts.length !== 2) return false;

    const [, entryIdStr] = parts;
    const entryId = parseInt(entryIdStr, 10);

    return !isNaN(entryId) && entryId > 0;
  }

  /**
   * Check if an ID is in the new Technology ID format
   */
  isNewFormat(id: string): boolean {
    return id.startsWith('tech-') || id.startsWith('technology-');
  }

  /**
   * Resolve an ID to the new Technology ID format
   */
  resolve(id: string): ResolutionResult {
    this.stats.totalResolutions++;

    // Already new format - passthrough
    if (this.isNewFormat(id)) {
      this.stats.passthroughHits++;
      return {
        resolved: true,
        technologyId: id,
        placementId: null,
        originalId: id,
        method: 'passthrough',
      };
    }

    // Try to parse as composite ID
    if (this.isCompositeId(id)) {
      const mapping = this.mappings.get(id);

      if (mapping) {
        this.stats.mappingHits++;
        return {
          resolved: true,
          technologyId: mapping.newTechnologyId,
          placementId: mapping.placementId || null,
          originalId: id,
          method: 'mapping',
        };
      }
    }

    // Fallback: Check if this might be a new ID without prefix
    // (for backward compatibility with manually created IDs)
    if (id.length > 20 && !id.includes(':')) {
      this.stats.fallbackHits++;
      return {
        resolved: true,
        technologyId: id,
        placementId: null,
        originalId: id,
        method: 'fallback',
      };
    }

    // Failed to resolve
    this.stats.failures++;
    log.warn('Failed to resolve ID', { id });

    return {
      resolved: false,
      technologyId: null,
      placementId: null,
      originalId: id,
      method: 'failed',
    };
  }

  /**
   * Resolve radarId + entryId to Technology ID
   */
  resolveTechnologyId(radarId: string, entryId: number): string | null {
    const key = `${radarId}:${entryId}`;
    const result = this.resolve(key);
    return result.resolved ? result.technologyId : null;
  }

  /**
   * Resolve radarId + entryId to Placement ID
   */
  resolvePlacementId(radarId: string, entryId: number): string | null {
    const key = `${radarId}:${entryId}`;
    const mapping = this.mappings.get(key);
    return mapping?.placementId || null;
  }

  /**
   * Get the full mapping for a composite ID
   */
  getMapping(radarId: string, entryId: number): IDMapping | null {
    const key = `${radarId}:${entryId}`;
    return this.mappings.get(key) || null;
  }

  /**
   * Reverse lookup: Get old ID from new Technology ID
   */
  getOldId(technologyId: string): string | null {
    return this.reverseMap.get(technologyId) || null;
  }

  /**
   * Batch resolve multiple IDs
   */
  batchResolve(ids: string[]): Map<string, ResolutionResult> {
    const results = new Map<string, ResolutionResult>();

    for (const id of ids) {
      results.set(id, this.resolve(id));
    }

    return results;
  }

  /**
   * Resolve an array of IDs and return just the Technology IDs
   */
  resolveArray(ids: string[]): string[] {
    return ids
      .map((id) => this.resolve(id))
      .filter((r) => r.resolved)
      .map((r) => r.technologyId!);
  }

  /**
   * Get resolution statistics
   */
  getStats(): ResolutionStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalResolutions: 0,
      mappingHits: 0,
      passthroughHits: 0,
      fallbackHits: 0,
      failures: 0,
      cacheSize: this.mappings.size,
    };
  }

  /**
   * Check if resolver is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get count of loaded mappings
   */
  getMappingCount(): number {
    return this.mappings.size;
  }

  /**
   * Clear all mappings (for testing)
   */
  clear(): void {
    this.mappings.clear();
    this.reverseMap.clear();
    this.initialized = false;
    this.resetStats();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

/** Global ID resolver instance */
export const idResolver = new IDResolver();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Resolve a technology ID (convenience function)
 * Uses the global resolver instance
 */
export function resolveTechnologyId(id: string): string | null {
  const result = idResolver.resolve(id);
  return result.resolved ? result.technologyId : null;
}

/**
 * Resolve technology ID from composite parts
 */
export function resolveTechIdFromParts(radarId: string, entryId: number): string | null {
  return idResolver.resolveTechnologyId(radarId, entryId);
}

/**
 * Check if an ID needs resolution (is in old format)
 */
export function needsResolution(id: string): boolean {
  return idResolver.isCompositeId(id) && !idResolver.isNewFormat(id);
}

/**
 * Safe resolve - returns original ID if resolution fails
 */
export function safeResolve(id: string): string {
  const result = idResolver.resolve(id);
  return result.technologyId || id;
}

/**
 * Batch safe resolve
 */
export function safeBatchResolve(ids: string[]): string[] {
  return ids.map(safeResolve);
}

// ============================================================================
// FIRESTORE MAPPING MANAGEMENT
// ============================================================================

/**
 * Save a new ID mapping to Firestore
 */
export async function saveMapping(mapping: IDMapping): Promise<void> {
  const docId = `${mapping.radarId}_${mapping.entryId}`;
  // Uses setDoc directly (not entity-factory) — migration tooling record, not a user-facing entity.
  await setDoc(doc(db, 'migrationMappings', docId), mapping);

  // Update local cache
  const key = `${mapping.radarId}:${mapping.entryId}`;
  idResolver['mappings'].set(key, mapping);
  idResolver['reverseMap'].set(mapping.newTechnologyId, key);
}

/**
 * Save multiple mappings in batch
 */
export async function saveMappingsBatch(mappings: IDMapping[]): Promise<void> {
  // Import batch writing
  const { writeBatch } = await import('firebase/firestore');
  const batch = writeBatch(db);

  for (const mapping of mappings) {
    const docId = `${mapping.radarId}_${mapping.entryId}`;
    batch.set(doc(db, 'migrationMappings', docId), mapping);

    // Update local cache
    const key = `${mapping.radarId}:${mapping.entryId}`;
    idResolver['mappings'].set(key, mapping);
    idResolver['reverseMap'].set(mapping.newTechnologyId, key);
  }

  await batch.commit();
}

/**
 * Get mapping by Technology ID from Firestore
 */
export async function getMappingByTechnologyId(technologyId: string): Promise<IDMapping | null> {
  // First check local cache
  const oldId = idResolver.getOldId(technologyId);
  if (oldId) {
    const [radarId, entryIdStr] = oldId.split(':');
    return idResolver.getMapping(radarId, parseInt(entryIdStr, 10));
  }

  // Query Firestore
  const q = query(collection(db, 'migrationMappings'), where('newTechnologyId', '==', technologyId));

  const snapshot = await getDocs(q);

  if (snapshot.empty) return null;

  return snapshot.docs[0].data() as IDMapping;
}
