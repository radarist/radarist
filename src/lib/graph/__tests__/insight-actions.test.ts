/**
 * @file insight-actions.test.ts
 * @description Pin the briefing-insight action URL contract.
 *
 * Phase 0 step 0.4 of the 2026-05-13 briefing-pipeline cleanup plan: this
 * helper is the single source of truth for "what URL / label does an
 * insight's primary CTA target?" Tests here lock down:
 *
 *   - All known entity types map to their `/library/<plural>?sheet=<id>`
 *     URL (or a domain-specific URL for signal).
 *   - Plural collection-name forms (`'technologies'`, `'companies'`, …)
 *     resolve to the same URL as their singular siblings — the safety
 *     net for the Firestore-fallback gap-finder until step 0.5 fixes the
 *     write-side mismatch.
 *   - Unknown types return `actionUrl: null` (NOT the old `'/library'`
 *     home-page fallback) so the UI can hide the CTA cleanly.
 */

import { getInsightAction, normaliseEntityType, displayInsightTitle } from '../insight-actions';

describe('normaliseEntityType', () => {
  it('maps plural collection names to singular entity types', () => {
    expect(normaliseEntityType('companies')).toBe('company');
    expect(normaliseEntityType('technologies')).toBe('technology');
    expect(normaliseEntityType('use-cases')).toBe('useCase');
    expect(normaliseEntityType('useCases')).toBe('useCase');
    expect(normaliseEntityType('strategies')).toBe('strategy');
    expect(normaliseEntityType('prototypes')).toBe('prototype');
    expect(normaliseEntityType('initiatives')).toBe('initiative');
    expect(normaliseEntityType('org-units')).toBe('orgUnit');
    expect(normaliseEntityType('orgUnits')).toBe('orgUnit');
    expect(normaliseEntityType('painPoints')).toBe('painPoint');
    expect(normaliseEntityType('signals')).toBe('signal');
  });

  it('passes through canonical singular forms unchanged', () => {
    for (const type of [
      'company',
      'technology',
      'useCase',
      'strategy',
      'prototype',
      'initiative',
      'orgUnit',
      'painPoint',
      'signal',
    ]) {
      expect(normaliseEntityType(type)).toBe(type);
    }
  });

  it('returns empty string for null/undefined input', () => {
    expect(normaliseEntityType(null)).toBe('');
    expect(normaliseEntityType(undefined)).toBe('');
    expect(normaliseEntityType('')).toBe('');
  });

  it('passes through unknown types unchanged (caller decides what to do)', () => {
    expect(normaliseEntityType('wat')).toBe('wat');
    expect(normaliseEntityType('Document')).toBe('Document');
  });
});

describe('getInsightAction', () => {
  // URLs come from the canonical entity-links map. Each list page's sheet
  // listens to its own param (?company=, ?technology=, …) — the old local
  // `?sheet=` builder produced URLs every page silently ignored.
  it.each([
    ['company', '/library/companies?company=ent-1', 'View company'],
    ['technology', '/library/technologies?technology=ent-1', 'View technology'],
    ['useCase', '/library/use-cases?usecase=ent-1', 'View use case'],
    ['strategy', '/library/strategies?strategy=ent-1', 'View strategy'],
    ['prototype', '/library/prototypes?prototype=ent-1', 'View prototype'],
    ['initiative', '/library/initiatives?initiative=ent-1', 'View initiative'],
    ['orgUnit', '/library/org-units?orgunit=ent-1', 'View org unit'],
    ['painPoint', '/library/pain-points?painpoint=ent-1', 'View pain point'],
    ['document', '/library/documents?document=ent-1', 'View document'],
  ])('maps "%s" to canonical sheet URL %s with label %s', (type, expectedUrl, expectedLabel) => {
    const { actionUrl, actionLabel } = getInsightAction(type, 'ent-1');
    expect(actionUrl).toBe(expectedUrl);
    expect(actionLabel).toBe(expectedLabel);
  });

  it('signal goes to the signals page, not a sheet (signals have a dedicated page)', () => {
    const { actionUrl, actionLabel } = getInsightAction('signal', 'sig-1');
    expect(actionUrl).toBe('/triage/signals');
    expect(actionLabel).toBe('Review signals');
  });

  it('regression: never emits the dead `?sheet=` param no list page listens to', () => {
    for (const type of ['company', 'technology', 'useCase', 'strategy', 'prototype', 'initiative']) {
      expect(getInsightAction(type, 'x').actionUrl).not.toContain('?sheet=');
    }
  });

  it('treats plural forms the same as their singular siblings', () => {
    // The Firestore-fallback gap-finder writes the collection name as
    // entityType. This safety net lets old data still resolve. Step 0.5
    // fixes the write side; this is the read-side guard.
    expect(getInsightAction('technologies', 'tech-1').actionUrl).toBe('/library/technologies?technology=tech-1');
    expect(getInsightAction('companies', 'comp-1').actionUrl).toBe('/library/companies?company=comp-1');
    expect(getInsightAction('strategies', 'strat-1').actionUrl).toBe('/library/strategies?strategy=strat-1');
  });

  it('unknown entity types return null URL so the UI can hide the CTA', () => {
    // Previously this branch returned actionUrl: '/library' — a generic
    // home-page link that wasted user clicks. Null lets the UI hide it.
    expect(getInsightAction('mystery', 'x').actionUrl).toBeNull();
    expect(getInsightAction('Document', 'x').actionUrl).toBeNull();
    expect(getInsightAction(null, 'x').actionUrl).toBeNull();
    expect(getInsightAction(undefined, 'x').actionUrl).toBeNull();
    expect(getInsightAction('', 'x').actionUrl).toBeNull();
  });

  it('always returns a non-empty label, even for unknown types', () => {
    // The UI uses the label for accessibility / aria-label even when it
    // hides the visible button — keep it populated.
    expect(getInsightAction('mystery', 'x').actionLabel).toBe('View entity');
    expect(getInsightAction(null, 'x').actionLabel).toBe('View entity');
  });

  it('regression: never returns "/library" as a fallback', () => {
    // The previous behaviour sent unknown types to the library home page.
    // This is misleading UX, so lock the safer behavior in.
    for (const type of ['mystery', 'unknown', 'Document', null, undefined, '']) {
      expect(getInsightAction(type, 'x').actionUrl).not.toBe('/library');
    }
  });
});

describe('displayInsightTitle', () => {
  it('strips the legacy `<agent> found a link:` prefix', () => {
    // Connection insights written before 2026-05-13 carry the agent
    // attribution inline in the title; the UI now strips it because
    // the Agent column + summary already show the agent.
    expect(displayInsightTitle('sweep-cycle found a link: Flavor Tech Leadership connects to ISARA')).toBe(
      'Flavor Tech Leadership connects to ISARA'
    );
    expect(displayInsightTitle('scout found a link: Quantum Computing connects to IBM')).toBe(
      'Quantum Computing connects to IBM'
    );
    expect(displayInsightTitle('linker found a link: WebAssembly connects to Edge AI')).toBe(
      'WebAssembly connects to Edge AI'
    );
  });

  it('passes through titles that do not carry the legacy prefix', () => {
    expect(displayInsightTitle('Flavor Tech Leadership connects to ISARA')).toBe(
      'Flavor Tech Leadership connects to ISARA'
    );
    expect(displayInsightTitle('Plain title')).toBe('Plain title');
    expect(displayInsightTitle('')).toBe('');
  });

  it('only strips the prefix when followed by `found a link:`', () => {
    // Defensive — a title containing the word "found" elsewhere
    // should NOT be touched.
    expect(displayInsightTitle('Patent application found in archive')).toBe('Patent application found in archive');
    expect(displayInsightTitle('IBM found in quantum patents')).toBe('IBM found in quantum patents');
  });
});
