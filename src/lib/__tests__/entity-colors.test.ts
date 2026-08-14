import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  ENTITY_COLORS,
  NEUTRAL_HEX,
  RELATION_COLORS,
  entityColorHex,
  entityTextClass,
  isMappedEntityLabel,
  isMappedRelationType,
  relationColorHex,
} from '../entity-colors';
import type { EntityType } from '@/lib/types';

const ALL_TYPES: EntityType[] = [
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'document',
  'orgUnit',
  'initiative',
  'painPoint',
  'radarPlacement',
];

describe('entity-colors (canonical single source)', () => {
  it('defines a color for every EntityType', () => {
    for (const t of ALL_TYPES) {
      expect(ENTITY_COLORS[t]).toBeDefined();
      expect(ENTITY_COLORS[t].hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(ENTITY_COLORS[t].text).toContain('dark:');
    }
  });

  it('matches the documented convention (company=blue, technology=emerald, signal=orange)', () => {
    expect(ENTITY_COLORS.company.hex).toBe('#3b82f6');
    expect(ENTITY_COLORS.technology.hex).toBe('#10b981');
    expect(ENTITY_COLORS.signal.hex).toBe('#f97316');
  });

  it('reassigns prototype to teal so it stays distinct from technology emerald', () => {
    expect(ENTITY_COLORS.prototype.hex).toBe('#14b8a6');
    expect(ENTITY_COLORS.prototype.hex).not.toBe(ENTITY_COLORS.technology.hex);
  });

  it('normalizes PascalCase graph labels to the right hex', () => {
    expect(entityColorHex('Company')).toBe('#3b82f6');
    expect(entityColorHex('Technology')).toBe('#10b981');
    expect(entityColorHex('UseCase')).toBe('#eab308');
    expect(entityColorHex('RadarPlacement')).toBe('#94a3b8');
  });

  it('accepts lowercase EntityType keys directly', () => {
    expect(entityColorHex('company')).toBe('#3b82f6');
    expect(entityColorHex('orgUnit')).toBe('#6366f1');
  });

  it('preserves graph-meta node colors (Claim/Evidence) so the graph does not regress', () => {
    expect(entityColorHex('Claim')).toBe('#06b6d4');
    expect(entityColorHex('Evidence')).toBe('#84cc16');
  });

  it('falls back to neutral gray for unknown labels', () => {
    expect(entityColorHex('SomethingUnknown')).toBe(NEUTRAL_HEX);
  });

  it('exposes an AA-tuned text class per type', () => {
    expect(entityTextClass('company')).toBe('text-blue-600 dark:text-blue-400');
  });
});

describe('GRAPH-073 graph-only labels and predicates', () => {
  it('maps the graph-only node labels that previously fell through to one gray', () => {
    // 97 of 107 nodes resolved to the fallback on the measured baseline because
    // these labels were simply absent from the map.
    for (const label of ['Chunk', 'Assertion', 'Entity', 'Evidence', 'Concept', 'Radar']) {
      expect({ label, mapped: isMappedEntityLabel(label) }).toEqual({ label, mapped: true });
      expect(entityColorHex(label)).not.toBe(NEUTRAL_HEX);
    }
  });

  it('maps the predicates that made ALL 100 measured edges render one color', () => {
    for (const type of ['CONTAINS', 'MENTIONS', 'SUPPORTED_BY', 'ASSERTED_BY']) {
      expect({ type, mapped: isMappedRelationType(type) }).toEqual({ type, mapped: true });
      expect(relationColorHex(type)).not.toBe(NEUTRAL_HEX);
    }
  });

  it('keeps the reserved fallback distinct from every mapped value', () => {
    // An unmapped type has to read as a gap. Sharing a hex with `radarPlacement`
    // or `document` is exactly the "merges into the gray mass" failure.
    const mapped = [...Object.values(ENTITY_COLORS).map((color) => color.hex), ...Object.values(RELATION_COLORS)];
    expect(mapped).not.toContain(NEUTRAL_HEX);
    expect(entityColorHex('SomeUnmappedLabel')).toBe(NEUTRAL_HEX);
    expect(relationColorHex('SOME_UNMAPPED_PREDICATE')).toBe(NEUTRAL_HEX);
    expect(isMappedEntityLabel('SomeUnmappedLabel')).toBe(false);
    expect(isMappedRelationType('SOME_UNMAPPED_PREDICATE')).toBe(false);
  });

  it('adds entries only — the established business entity colors are untouched', () => {
    // Lists, badges, chips and the radar all read this map; this row must not
    // restyle them.
    expect({
      company: ENTITY_COLORS.company.hex,
      technology: ENTITY_COLORS.technology.hex,
      useCase: ENTITY_COLORS.useCase.hex,
      prototype: ENTITY_COLORS.prototype.hex,
      strategy: ENTITY_COLORS.strategy.hex,
      signal: ENTITY_COLORS.signal.hex,
      document: ENTITY_COLORS.document.hex,
      orgUnit: ENTITY_COLORS.orgUnit.hex,
      initiative: ENTITY_COLORS.initiative.hex,
      painPoint: ENTITY_COLORS.painPoint.hex,
      radarPlacement: ENTITY_COLORS.radarPlacement.hex,
    }).toEqual({
      company: '#3b82f6',
      technology: '#10b981',
      useCase: '#eab308',
      prototype: '#14b8a6',
      strategy: '#a855f7',
      signal: '#f97316',
      document: '#64748b',
      orgUnit: '#6366f1',
      initiative: '#ec4899',
      painPoint: '#ef4444',
      radarPlacement: '#94a3b8',
    });
  });

  it('keeps the curated business predicate colors unchanged', () => {
    expect(relationColorHex('USES')).toBe('#3b82f6');
    expect(relationColorHex('ENABLES')).toBe('#10b981');
    expect(relationColorHex('DOCUMENTED_BY')).toBe('#64748b');
  });
});

// ---------------------------------------------------------------------------
// Repository regression: no component may re-declare an entity-color map.
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve(__dirname, '..', '..');
const CANONICAL_MODULE = resolve(SRC_ROOT, 'lib', 'entity-colors.ts');

/**
 * Keys that identify a map as an ENTITY-color map specifically, rather than an
 * unrelated palette (a chart series ramp, a status tint, a brand swatch list).
 * Both the lowercase `EntityType` keys and their PascalCase graph labels count.
 */
const ENTITY_COLOR_KEYS = [
  'company',
  'technology',
  'useCase',
  'prototype',
  'strategy',
  'signal',
  'document',
  'orgUnit',
  'initiative',
  'painPoint',
  'radarPlacement',
  'Company',
  'Technology',
  'UseCase',
  'Prototype',
  'Strategy',
  'Signal',
  'Document',
  'OrgUnit',
  'Initiative',
  'PainPoint',
  'RadarPlacement',
  'Entity',
  'Claim',
  'Evidence',
  'Assertion',
  'Chunk',
  'Concept',
  'Radar',
];

/**
 * Matches `Company: '#3b82f6'` and its quoted-key form. Deliberately requires a
 * LITERAL hex value, so a map DERIVED from the canonical palette (as
 * `EntityRelationshipPanel` and `ContextualGraph` legitimately do via
 * `Object.fromEntries`) is not flagged — those cannot drift.
 */
const ENTITY_HEX_ASSIGNMENT = new RegExp(
  `['"\`]?(${ENTITY_COLOR_KEYS.join('|')})['"\`]?\\s*:\\s*['"\`]#[0-9a-fA-F]{3,8}['"\`]`,
  'g'
);

/** Three distinct entity keys with literal hexes is a color MAP, not a coincidence. */
const DUPLICATE_MAP_THRESHOLD = 3;

function collectSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe('GRAPH-073 canonical color map is the only entity-color map', () => {
  it('finds no component-local entity-color map anywhere under src/', () => {
    // Nine independently-maintained inline `ENTITY_COLORS` literals once caused
    // the Company blue/green inversion; `GraphOverviewPanel` had quietly grown a
    // tenth and it had already drifted. The canonical palette forbids this —
    // this test is what makes the prohibition enforceable rather than advisory.
    const offenders = collectSourceFiles(SRC_ROOT)
      .filter((path) => resolve(path) !== CANONICAL_MODULE)
      .map((path) => {
        const keys = new Set([...readFileSync(path, 'utf8').matchAll(ENTITY_HEX_ASSIGNMENT)].map((match) => match[1]));
        return { file: relative(SRC_ROOT, path), keys: [...keys].sort() };
      })
      .filter((candidate) => candidate.keys.length >= DUPLICATE_MAP_THRESHOLD);

    expect(offenders).toEqual([]);
  });

  it('would still catch a re-introduced duplicate map', () => {
    // Non-vacuity: prove the detector fires on the literal that was just deleted.
    const reintroduced = `const ENTITY_COLORS = { Company: '#3b82f6', Technology: '#10b981', Signal: '#f97316' };`;
    const keys = new Set([...reintroduced.matchAll(ENTITY_HEX_ASSIGNMENT)].map((match) => match[1]));
    expect(keys.size).toBeGreaterThanOrEqual(DUPLICATE_MAP_THRESHOLD);

    // …and does NOT fire on a map derived from the canonical palette.
    const derived = `const ENTITY_COLORS = Object.fromEntries(keys.map((k) => [k, PALETTE[k].hex]));`;
    expect([...derived.matchAll(ENTITY_HEX_ASSIGNMENT)]).toHaveLength(0);
  });

  it('scans a non-trivial number of source files', () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(200);
  });
});
