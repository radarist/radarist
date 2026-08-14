/**
 * @file lib/technology-service.ts
 * @description Barrel re-export for the decoupled Technology service modules.
 *
 * This file re-exports all technology service functionality from its domain modules:
 * - technology-core.ts — CRUD, utilities, bulk operations, query helpers, linking
 * - technology-research.ts — TRL/TimeToImpact sync to radar placements
 *
 * All consumer imports remain unchanged.
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

export * from './technology-core';
export * from './technology-research';
