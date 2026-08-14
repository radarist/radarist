/**
 * @file src/lib/migration/index.ts
 * @description Technology Decoupling Migration Module Exports
 *
 * Provides ID resolution and migration utilities for the Phase 3 migration
 * from RadarEntry (radarId:entryId) to Technology + RadarPlacement model.
 */

// ID Resolution Service
export {
  IDResolver,
  idResolver,
  resolveTechnologyId,
  resolveTechIdFromParts,
  needsResolution,
  safeResolve,
  safeBatchResolve,
  saveMapping,
  saveMappingsBatch,
  getMappingByTechnologyId,
} from './id-resolver';

export type { IDMapping, ResolutionResult, ResolutionStats } from './id-resolver';
