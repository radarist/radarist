// Barrel re-export for backward compatibility.
// All types are now organized in src/lib/types/ domain modules:
//   common.ts   — Shared foundational types (BaseEntity, EntityType, SLO, etc.)
//   radar.ts    — Radar visualization, entries, placements, quadrant/ring helpers
//   entities.ts — Core entity interfaces (Technology, Company, Signal, etc.)
//   relations.ts — Relations, proposed relations, evidence, linker metrics
//   agents.ts   — Agent types, custom agents, runs, episodes, system config
export * from './types/index';
