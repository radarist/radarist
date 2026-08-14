/**
 * @file entity-chip-classes.ts
 * @description Guarded ENTITY_COLORS lookup for entity "chip" classes
 * (bg + text + border) — the canonical fallback shared by RelationsTab's
 * relation cards, the Graph Insights panel, and LinkedEntitiesCard's
 * icon chips.
 *
 * Lives in `src/lib` (not `src/components/sheets/tabs`, where it started)
 * because it's a cross-feature primitive, not a sheet-tab-specific one —
 * moved here so `LinkedEntitiesCard` (src/components/impulse/) could
 * consolidate onto the same guard instead of re-deriving its own
 * bg-muted/text-muted-foreground fallback (Task 20 review finding #2).
 *
 * P-C5: entity icon chips must use the canonical ENTITY_COLORS/entityIcon
 * palette (src/lib/entity-colors.ts, src/lib/entity-icons.ts) — a locally
 * forked map (technology=purple, useCase=green, …) previously drifted from
 * canon (technology=emerald, useCase=yellow, …), rendering every non-company
 * relation as a fixed violet/blue regardless of actual entity type.
 *
 * Guarded lookup: non-canonical types reach here in practice — the 'unknown'
 * sentinel minted by graph/traversal.ts's explainConnection path badges, and
 * lowercased graph labels ('claim', 'evidence', 'assertion', …) surfaced via
 * graphNodeToConnection in the 2-hop Graph Insights panel. An unguarded
 * ENTITY_COLORS[type] throws on those, and EntitySheetShell's single
 * ErrorBoundary blanks the entire drawer body. Mirrors entityIcon's `?? Target`
 * fallback in src/lib/entity-icons.ts.
 */
import { ENTITY_COLORS, type EntityColor } from '@/lib/entity-colors';
import type { EntityType } from '@/lib/types';

/**
 * The one guarded ENTITY_COLORS lookup every chip consumer must route
 * through — non-canonical `type` values fall back to the document palette
 * instead of throwing. `entityChipClasses` below and any caller that needs
 * the individual `bg`/`text`/`border` classes (rather than the combined
 * string) should call this directly instead of re-deriving their own guard.
 */
export function resolveEntityChipColor(type: EntityType): EntityColor {
  return ENTITY_COLORS[type] ?? ENTITY_COLORS.document;
}

export function entityChipClasses(type: EntityType): string {
  const c = resolveEntityChipColor(type);
  return `${c.bg} ${c.text} ${c.border}`;
}
