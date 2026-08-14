/**
 * @file signals.ts
 * @description Barrel re-export for backward compatibility.
 *
 * The signals module has been split into domain files:
 * - signals-core.ts — CRUD, filtering, querying, analytics, shared helpers
 * - signals-approval.ts — Approval workflow, archival, signal-to-entity conversion
 * - signals-expansion.ts — Duplicate detection, merging, similarity calculation
 *
 * All existing imports from '@/lib/signals' continue to work unchanged.
 */

// Core CRUD, filtering, querying, analytics
export * from './signals-core';

// Approval workflow, archival, entity conversion
export * from './signals-approval';

// Duplicate detection, merging, expansion
export * from './signals-expansion';
