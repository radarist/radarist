/**
 * @file radars-shared.ts
 * @description Runtime-neutral radar validation and orphan-resolution contracts.
 *
 * Keep this module free of Firebase client/admin imports so the browser and
 * server radar services share the same validation and error identity without
 * crossing runtime boundaries.
 */

import { MAX_QUADRANTS, MIN_QUADRANTS } from '@/lib/constants';
import type { QuadrantConfig } from '@/lib/types';

/** Placements grouped by the removed quadrant they still reference. */
export interface OrphanGroup {
  quadrantId: string;
  quadrantName?: string;
  placements: Array<{ id: string; technologyId: string; ring: string }>;
}

export interface OrphanReport {
  orphans: OrphanGroup[];
  totalPlacements: number;
}

/** Explicit resolutions accepted when a quadrant update would orphan placements. */
export interface UpdateRadarQuadrantsOptions {
  reassignments?: Record<string, string>;
  deleteOrphans?: boolean;
}

/** Optional aggregate statistics returned with a radar. */
export interface RadarStats {
  totalPlacements: number;
  byRing: Record<string, number>;
  byQuadrant: Record<string, { name: string; count: number }>;
}

/** Raised when a quadrant update leaves placements without a valid quadrant. */
export class OrphanedPlacementsError extends Error {
  constructor(public readonly report: OrphanReport) {
    super(`Cannot shrink radar quadrants: ${report.totalPlacements} placement(s) would be orphaned`);
    this.name = 'OrphanedPlacementsError';
  }
}

/** Validate quadrant count, shape, names, and unique identifiers. */
export function validateQuadrantConfigs(configs: QuadrantConfig[]): void {
  if (!Array.isArray(configs)) {
    throw new Error('Quadrants must be an array');
  }
  if (configs.length < MIN_QUADRANTS || configs.length > MAX_QUADRANTS) {
    throw new Error(
      `Quadrants count out of range: expected ${MIN_QUADRANTS}..${MAX_QUADRANTS}, got ${configs.length}`
    );
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    if (!config || typeof config !== 'object') {
      throw new Error(`Quadrant at index ${i} is invalid`);
    }
    if (typeof config.id !== 'string' || config.id.trim().length === 0) {
      throw new Error(`Quadrant at index ${i} is missing an id`);
    }
    if (typeof config.name !== 'string' || config.name.trim().length === 0) {
      throw new Error(`Quadrant at index ${i} has an empty name`);
    }
    if (!Number.isInteger(config.order) || config.order < 0) {
      throw new Error(`Quadrant at index ${i} has an invalid order`);
    }
    if (config.description !== undefined && typeof config.description !== 'string') {
      throw new Error(`Quadrant at index ${i} has an invalid description`);
    }
    if (seenIds.has(config.id)) {
      throw new Error(`Duplicate quadrant id: ${config.id}`);
    }
    seenIds.add(config.id);
  }
}

/**
 * Validate and prepare quadrant configs for a Firestore write.
 *
 * `description` is optional in the domain model, but object construction can
 * still materialize it as an own property whose value is `undefined`.
 * Firestore rejects that nested value even though the field is semantically
 * absent. Omit only that one optional value; invalid required fields and an
 * invalid present description continue to fail validation rather than being
 * silently stripped.
 */
export function prepareQuadrantConfigsForWrite(configs: QuadrantConfig[]): QuadrantConfig[] {
  validateQuadrantConfigs(configs);

  return configs.map((config) => {
    const required: QuadrantConfig = {
      id: config.id,
      name: config.name,
      order: config.order,
    };
    return config.description === undefined ? required : { ...required, description: config.description };
  });
}
