/**
 * @file entity-colors.ts
 * @description Canonical single source of truth for entity colors.
 *
 * Replaces 9+ independently-maintained (and contradictory) inline `ENTITY_COLORS`
 * literals across graph/relations/scouting/documents/dashboard/sheets. Import from
 * here everywhere; never re-declare an entity-color map in a component.
 *
 * Canonical palette shared by every entity visualization:
 *   company=blue · technology=emerald · useCase=yellow · prototype=teal* · strategy=purple · signal=orange
 *
 * (*prototype was reassigned green→teal so it stays perceptually separable from
 * technology's emerald at graph-node scale — see review finding #7.)
 *
 * `hex` is for canvas / SVG graph fills (those contexts can't use CSS classes).
 * `text`/`bg`/`border` are theme-aware Tailwind classes (light steps darker for WCAG AA,
 * dark steps lighter). These class strings are scanned by Tailwind because
 * `./src/lib/**` is in the `content` globs (see tailwind.config.ts).
 */
import type { EntityType } from '@/lib/types';

export interface EntityColor {
  /** Raw hex for canvas / SVG graph fills. */
  hex: string;
  /** AA-tuned foreground text class (light: -600/-700, dark: -400). */
  text: string;
  /** Subtle tinted background for chips/badges. */
  bg: string;
  /** Subtle border tint. */
  border: string;
}

export const ENTITY_COLORS: Record<EntityType, EntityColor> = {
  company: {
    hex: '#3b82f6',
    text: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
  },
  technology: {
    hex: '#10b981',
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
  useCase: {
    hex: '#eab308',
    text: 'text-yellow-700 dark:text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/20',
  },
  prototype: {
    hex: '#14b8a6',
    text: 'text-teal-600 dark:text-teal-400',
    bg: 'bg-teal-500/10',
    border: 'border-teal-500/20',
  },
  strategy: {
    hex: '#a855f7',
    text: 'text-purple-600 dark:text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
  },
  signal: {
    hex: '#f97316',
    text: 'text-orange-600 dark:text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
  },
  document: {
    hex: '#64748b',
    text: 'text-slate-600 dark:text-slate-400',
    bg: 'bg-slate-500/10',
    border: 'border-slate-500/20',
  },
  orgUnit: {
    hex: '#6366f1',
    text: 'text-indigo-600 dark:text-indigo-400',
    bg: 'bg-indigo-500/10',
    border: 'border-indigo-500/20',
  },
  initiative: {
    hex: '#ec4899',
    text: 'text-pink-600 dark:text-pink-400',
    bg: 'bg-pink-500/10',
    border: 'border-pink-500/20',
  },
  painPoint: {
    hex: '#ef4444',
    text: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
  },
  radarPlacement: {
    hex: '#94a3b8',
    text: 'text-slate-500 dark:text-slate-400',
    bg: 'bg-slate-400/10',
    border: 'border-slate-400/20',
  },
};

/**
 * Reserved fallback for a label this module does not map.
 *
 * GRAPH-073 — deliberately a WARM neutral, distinct from every mapped value
 * including the cool blue-greys of `document` (#64748b) and `radarPlacement`
 * (#94a3b8). An unmapped type has to read as a gap, not merge into the grey mass.
 * `isMappedEntityLabel` lets a legend say so explicitly rather than relying on
 * hue alone.
 */
export const NEUTRAL_HEX = '#78716c';

/**
 * Graph-only meta node labels that are NOT user-facing entities but still appear
 * on the graph canvas. Kept here so the graph keeps its existing colors after the
 * 9 inline maps are deleted (zero regression).
 *
 * GRAPH-073 — grouped into LAYERS on purpose. On the measured baseline 97 of 107
 * nodes fell through to one grey, so the channel carried nothing; but 20 mutually
 * distinguishable hues do not exist alongside the 11 entity colours already in
 * use, and a wholesale palette replacement was rejected as over-engineering (it
 * ripples into every list, badge, chip and radar). Labels that belong to the same
 * layer therefore share that layer's colour, which encodes real structure instead
 * of pretending to a precision the palette cannot deliver. The colourblind-safe
 * second channel (an icon inside the node) is recorded as the next pass.
 */
const GRAPH_META_HEX: Record<string, string> = {
  // Generic base label carried by every entity node; only primary when a node has
  // no more specific label. Value unchanged.
  Entity: '#94a3b8',

  // Claim layer — an `Assertion` IS the reified claim; `Claim` is its legacy
  // label, so the two deliberately share a colour. Values unchanged.
  Claim: '#06b6d4',
  Assertion: '#06b6d4',
  Evidence: '#84cc16',

  // Ingestion layer — a `Chunk` is a slice of its parent `Document` (#64748b).
  Chunk: '#0ea5e9',
  Concept: '#d946ef',

  // Radar structure. `RadarPlacement` is a first-class entity type above.
  Radar: '#f43f5e',

  // Temporal / per-user memory.
  Episode: '#8b5cf6',
  Session: '#8b5cf6',
  User: '#8b5cf6',
  UserPreference: '#8b5cf6',
  InterestProfile: '#8b5cf6',

  // Agent activity.
  AgentRun: '#f59e0b',
  AgentObservation: '#f59e0b',
  AgentReflection: '#f59e0b',

  // Derived analysis overlaid on edge traversal.
  CommunityReport: '#22c55e',
  ProactiveInsight: '#22c55e',
  CuriosityGap: '#22c55e',

  // Verification.
  VerificationResult: '#0d9488',
  EdgeVerificationResult: '#0d9488',
};

/**
 * Canonical relationship-type colours. GRAPH-073 — on the measured baseline ALL
 * 100 returned edges resolved to the fallback (`{"#94a3b8": 100}`), so
 * relationship type was encoded in a channel that rendered exactly one grey.
 *
 * The curated business predicates keep their existing values; the additions are
 * the graph-only predicates the workbench can actually surface, coloured to match
 * the node layer they belong to (claim predicates cyan, ingestion sky, memory
 * violet, agent amber) so an edge reads as part of the same structure as the
 * nodes it joins.
 */
export const RELATION_COLORS: Record<string, string> = {
  // Curated business predicates — values unchanged.
  USES: '#3b82f6',
  ENABLES: '#10b981',
  COMPETES_WITH: '#ef4444',
  VENDOR: '#f97316',
  PARTNER: '#22c55e',
  ADDRESSES: '#eab308',
  ALIGNS_WITH: '#a855f7',
  SUPPORTS: '#6366f1',
  OWNED_BY: '#ec4899',
  SPONSORS: '#06b6d4',
  FUNDS: '#84cc16',
  SOLVES: '#14b8a6',
  IMPACTS: '#f43f5e',
  DRIVES: '#8b5cf6',
  DOCUMENTED_BY: '#64748b',

  // Further curated predicates the relation contract can mint.
  IMPLEMENTS: '#0ea5e9',
  REQUIRES: '#d946ef',
  EVALUATES: '#a3e635',
  RELATED_TO: '#a1a1aa',

  // Claim layer (cyan) — the :Assertion reification's structural roles.
  ABOUT: '#06b6d4',
  ABOUT_SUBJECT: '#06b6d4',
  ABOUT_OBJECT: '#06b6d4',
  HAS_PREDICATE: '#06b6d4',
  ASSERTED_BY: '#06b6d4',
  SUPPORTED_BY: '#84cc16',

  // Ingestion layer (sky).
  CONTAINS: '#0ea5e9',
  MENTIONS: '#0891b2',
  HAS_CONCEPT: '#d946ef',

  // Radar structure (rose).
  ON_RADAR: '#f43f5e',
  PLACES: '#f43f5e',

  // Memory (violet) and agent activity (amber).
  EXPLORED: '#8b5cf6',
  EXECUTED_DURING: '#8b5cf6',
  OBSERVES: '#f59e0b',
  DISCOVERED: '#f59e0b',
  VERIFIES: '#0d9488',
};

/**
 * Lighter (≈Tailwind -300) shades for de-emphasised / 2nd-degree graph nodes,
 * keyed by the same EntityType as ENTITY_COLORS.
 */
const HEX_LIGHT: Record<EntityType, string> = {
  company: '#93c5fd',
  technology: '#6ee7b7',
  useCase: '#fde047',
  prototype: '#5eead4',
  strategy: '#d8b4fe',
  signal: '#fdba74',
  document: '#cbd5e1',
  orgUnit: '#a5b4fc',
  initiative: '#f9a8d4',
  painPoint: '#fca5a5',
  radarPlacement: '#cbd5e1',
};

/**
 * Normalize a PascalCase graph label (e.g. "Company", "UseCase", "RadarPlacement")
 * to its lowercase `EntityType` key. Returns undefined for non-entity labels.
 */
function normalizeKey(typeOrLabel: string): EntityType | undefined {
  if (typeOrLabel in ENTITY_COLORS) return typeOrLabel as EntityType;
  const k = typeOrLabel.charAt(0).toLowerCase() + typeOrLabel.slice(1);
  return k in ENTITY_COLORS ? (k as EntityType) : undefined;
}

/**
 * Hex fill for an entity. Accepts an `EntityType` key OR a PascalCase graph label.
 * Falls back to graph-meta colors, then a neutral gray.
 */
export function entityColorHex(typeOrLabel: string): string {
  const key = normalizeKey(typeOrLabel);
  if (key) return ENTITY_COLORS[key].hex;
  return GRAPH_META_HEX[typeOrLabel] ?? NEUTRAL_HEX;
}

/**
 * Whether this module actually maps the label, as opposed to falling through to
 * `NEUTRAL_HEX`. GRAPH-073 — legends call this so an unmapped type is shown as an
 * explicit gap the operator can act on, rather than silently joining the grey
 * mass. Hue alone is not a reliable signal at node scale.
 */
export function isMappedEntityLabel(typeOrLabel: string): boolean {
  return normalizeKey(typeOrLabel) !== undefined || typeOrLabel in GRAPH_META_HEX;
}

/** Canonical edge colour for a relationship type; neutral fallback when unmapped. */
export function relationColorHex(relationType: string): string {
  return RELATION_COLORS[relationType] ?? NEUTRAL_HEX;
}

/** Whether this module actually maps the relationship type. */
export function isMappedRelationType(relationType: string): boolean {
  return relationType in RELATION_COLORS;
}

/** AA-tuned text class for an entity type. */
export function entityTextClass(type: EntityType): string {
  return ENTITY_COLORS[type].text;
}

/** Lighter hex for 2nd-degree / de-emphasised nodes. Accepts EntityType or PascalCase label. */
export function entityColorHexLight(typeOrLabel: string): string {
  const key = normalizeKey(typeOrLabel);
  return key ? HEX_LIGHT[key] : '#cbd5e1';
}
