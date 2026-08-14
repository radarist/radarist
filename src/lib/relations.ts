/**
 * @file relations.ts
 * @description Barrel re-export for Denormalized Relations (v3.0)
 *
 * Split into domain modules:
 * - relations-core.ts     — CRUD, error classes, duplicate/self-reference checks, batch ops
 * - relations-validation.ts — Entity snapshot building, createRelationFromIds, orphan cleanup
 * - relations-queries.ts  — Query by entity/type, AI suggestions, stale detection, filtering
 */

export * from './relations-core';
export * from './relations-validation';
export * from './relations-queries';
