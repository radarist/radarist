/**
 * @file entity-chip-classes.test.ts
 * @description Pins the guarded ENTITY_COLORS lookup in entityChipClasses.
 *
 * Regression test for a crash risk: `ENTITY_COLORS[type]` was previously
 * read unguarded. Non-canonical `type` values reach this helper in practice —
 * the 'unknown' sentinel minted by graph/traversal.ts's explainConnection path
 * badges (rendered via the Explain Connection path chips), and lowercased
 * graph labels ('claim', 'evidence', 'assertion', …) surfaced via
 * graphNodeToConnection in the 2-hop Graph Insights panel. An undefined
 * lookup throws `Cannot read properties of undefined`, and
 * EntitySheetShell's single ErrorBoundary blanks the entire drawer body.
 *
 * Moved from src/components/sheets/tabs/__tests__/ to src/lib/__tests__/
 * alongside the module's move to src/lib/entity-chip-classes.ts (Task 20
 * review finding #2 — consolidating onto the one canon-color guard).
 */
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityChipClasses, resolveEntityChipColor } from '../entity-chip-classes';
import type { EntityType } from '@/lib/types';

describe('entityChipClasses', () => {
  it('returns the canonical bg/text/border classes for a known EntityType', () => {
    const classes = entityChipClasses('technology');
    expect(classes).toBe(
      `${ENTITY_COLORS.technology.bg} ${ENTITY_COLORS.technology.text} ${ENTITY_COLORS.technology.border}`
    );
  });

  it('falls back to the document palette (never throws) for the "unknown" sentinel', () => {
    expect(() => entityChipClasses('unknown' as EntityType)).not.toThrow();
    const classes = entityChipClasses('unknown' as EntityType);
    expect(classes).toBe(
      `${ENTITY_COLORS.document.bg} ${ENTITY_COLORS.document.text} ${ENTITY_COLORS.document.border}`
    );
  });

  it('falls back to the document palette (never throws) for lowercased graph labels', () => {
    for (const label of ['claim', 'evidence', 'assertion'] as unknown as EntityType[]) {
      expect(() => entityChipClasses(label)).not.toThrow();
      expect(entityChipClasses(label)).toBe(
        `${ENTITY_COLORS.document.bg} ${ENTITY_COLORS.document.text} ${ENTITY_COLORS.document.border}`
      );
    }
  });
});

describe('resolveEntityChipColor', () => {
  it('returns the raw EntityColor object (not the joined class string) for a known type', () => {
    expect(resolveEntityChipColor('company')).toBe(ENTITY_COLORS.company);
  });

  it('falls back to the document palette for unrecognised types — the guard LinkedEntitiesCard shares', () => {
    expect(resolveEntityChipColor('unknown' as EntityType)).toBe(ENTITY_COLORS.document);
  });
});
