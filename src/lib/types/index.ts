// ============================================================================
// BARREL RE-EXPORT — src/lib/types/index.ts
// ============================================================================
// Re-exports all domain modules so that `import { X } from '@/lib/types'`
// continues to work unchanged for all 144+ consumer files.
//
// Domain modules:
//   common.ts   — Shared foundational types (BaseEntity, EntityType, SLO, etc.)
//   radar.ts    — Radar visualization, entries, placements, quadrant/ring helpers
//   entities.ts — Core entity interfaces (Technology, Company, Signal, etc.)
//   relations.ts — Relations, proposed relations, evidence, linker metrics
//   agents.ts   — Agent types, custom agents, runs, episodes, system config

export * from './common';
export * from './research';
export * from './radar';
export * from './entities';
export * from './relations';
export * from './agents';
