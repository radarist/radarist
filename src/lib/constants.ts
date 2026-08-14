import type { QuadrantConfig, Quadrant, Status } from './types';

/**
 * Minimum allowed quadrants on any radar.
 */
export const MIN_QUADRANTS = 1;

/**
 * Maximum allowed quadrants on any radar.
 */
export const MAX_QUADRANTS = 8;

/**
 * The default quadrants for the radar.
 * These represent the four main areas of technology categorization.
 */
export const DEFAULT_QUADRANTS: Quadrant[] = ['Techniques', 'Tools', 'Platforms', 'Languages & Frameworks'];

/**
 * Generate a deterministic stable identifier from a quadrant display name.
 * Same input always produces the same id, which makes the migration script
 * idempotent and lets the reverse adapter / reconcile path preserve references
 * across renames that happen to match an existing slug.
 *
 * Examples:
 *   defaultQuadrantIdFromName("Languages & Frameworks", 3) → "q_languages_frameworks"
 *   defaultQuadrantIdFromName("AI/ML", 0)                  → "q_ai_ml"
 *   defaultQuadrantIdFromName("   ", 2)                    → "q_2" (fallback on empty slug)
 */
export function defaultQuadrantIdFromName(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return slug ? `q_${slug}` : `q_${index}`;
}

/**
 * Build the canonical default `QuadrantConfig[]` for a newly-created radar.
 * Uses `DEFAULT_QUADRANTS` as the source of display names and `defaultQuadrantIdFromName`
 * as the id generator — so two freshly-created radars get the same stable ids and the
 * migration script is idempotent against existing default radars.
 */
export function buildDefaultQuadrantConfigs(): QuadrantConfig[] {
  return DEFAULT_QUADRANTS.map((name, i) => ({
    id: defaultQuadrantIdFromName(name, i),
    name,
    order: i,
  }));
}

/**
 * Available ring systems for categorization.
 * - `Standard`: The classic Tech Radar rings (Adopt, Trial, Assess, Hold).
 * - `TRL`: Technology Readiness Levels (TRL 1-9).
 * - `Time-to-Impact`: Horizon-based rings (H1: 0-6mo, H2: 6-18mo, H3: 18+mo).
 * @phase Phase 2 Task 2.3.2
 */
export const RING_SYSTEMS = {
  Standard: ['Adopt', 'Trial', 'Assess', 'Hold'],
  TRL: ['TRL 9', 'TRL 8', 'TRL 7', 'TRL 6', 'TRL 5', 'TRL 4', 'TRL 3', 'TRL 2', 'TRL 1'],
  'Time-to-Impact': ['H1 (0-6mo)', 'H2 (6-18mo)', 'H3 (18+mo)'],
} as const;

/**
 * The default ring system used by the application (Standard).
 * Kept for backward compatibility.
 */
export const RINGS = RING_SYSTEMS['Standard'];

/**
 * Possible statuses for a technology item.
 * Represents the current trend or state of the technology.
 * - Trending: Growing in adoption/interest
 * - Stable: Mature and consistent
 * - Fading: Declining in relevance
 * - New: Recently added to radar
 * - Warning: Potential issues identified
 */
export const STATUSES: Status[] = ['Trending', 'Stable', 'Fading', 'New', 'Warning'];

/**
 * The default cost value assigned to a prototype.
 * Used for budget or effort estimation.
 */
export const DEFAULT_COST_TO_PROTOTYPE = 50;

/**
 * Mapping of ring names to their corresponding CSS color classes.
 * Covers Standard, TRL, and Time-to-Impact ring systems.
 * Provides text and fill colors.
 */
export const RING_COLORS: Record<string, string> = {
  // Standard
  Adopt: 'text-[#10b981] fill-[#10b981]', // Green
  Trial: 'text-[#0ea5e9] fill-[#0ea5e9]', // Blue
  Assess: 'text-[#eab308] fill-[#eab308]', // Yellow
  Hold: 'text-[#ef4444] fill-[#ef4444]', // Red

  // TRL (Gradient from Green to Red/Orange)
  'TRL 9': 'text-[#10b981] fill-[#10b981]', // Proven (Green)
  'TRL 8': 'text-[#34d399] fill-[#34d399]',
  'TRL 7': 'text-[#6ee7b7] fill-[#6ee7b7]',
  'TRL 6': 'text-[#0ea5e9] fill-[#0ea5e9]', // Prototype (Blue)
  'TRL 5': 'text-[#38bdf8] fill-[#38bdf8]',
  'TRL 4': 'text-[#7dd3fc] fill-[#7dd3fc]',
  'TRL 3': 'text-[#eab308] fill-[#eab308]', // Experimental (Yellow)
  'TRL 2': 'text-[#facc15] fill-[#facc15]',
  'TRL 1': 'text-[#ef4444] fill-[#ef4444]', // Basic Principle (Red)

  // Time-to-Impact (Phase 2 Task 2.3.2)
  'H1 (0-6mo)': 'text-[#10b981] fill-[#10b981]', // Near-term: Green (urgent/actionable)
  'H2 (6-18mo)': 'text-[#0ea5e9] fill-[#0ea5e9]', // Mid-term: Blue (planning phase)
  'H3 (18+mo)': 'text-[#a855f7] fill-[#a855f7]', // Long-term: Purple (future-oriented)
};

/**
 * The maximum radius of a blip on the radar, expressed as a percentage of the radar radius.
 */
export const MAX_BLIP_RADIUS = 100; // Percentage of radar radius
