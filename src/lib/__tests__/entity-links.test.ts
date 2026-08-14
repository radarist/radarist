/**
 * @file entity-links.test.ts
 * @description Pins the canonical entity deep-link contract. The sheet params
 * MUST match the `paramName` each list page passes to
 * `useControlledSheet`/`useSheetUrl` — a generic `?open=` is silently ignored
 * by every list page (the bug that made CommandPalette and AI-chat entity
 * chips land on the list without opening the sheet). Also pins the graph-node
 * → entity resolution used by the graph workbench "View Entity" button: graph
 * node ids are Neo4j elementIds, the Firestore id lives in `properties.id`.
 */

import {
  ENTITY_LIST_PATHS,
  ENTITY_SHEET_PARAMS,
  getEntityTypeFromGraphLabels,
  getEntityUrl,
  resolveGraphNodeEntityId,
} from '../entity-links';

describe('getEntityUrl', () => {
  it.each([
    ['company', 'c-1', '/library/companies?company=c-1'],
    ['prototype', 'p-1', '/library/prototypes?prototype=p-1'],
    ['strategy', 's-1', '/library/strategies?strategy=s-1'],
    ['useCase', 'u-1', '/library/use-cases?usecase=u-1'],
    ['technology', 'tech-1', '/library/technologies?technology=tech-1'],
    ['painPoint', 'pp-1', '/library/pain-points?painpoint=pp-1'],
    ['document', 'doc-1', '/library/documents?document=doc-1'],
    ['orgUnit', 'org-1', '/library/org-units?orgunit=org-1'],
    ['initiative', 'init-1', '/library/initiatives?initiative=init-1'],
  ])('opens the %s sheet with its page-specific param', (type, id, expected) => {
    expect(getEntityUrl(type, id)).toBe(expected);
  });

  it.each([
    ['signal', '/triage/signals'],
    ['radarPlacement', '/radar'],
  ])('links %s to its list page (no URL-driven sheet exists)', (type, expected) => {
    expect(getEntityUrl(type, 'id-1')).toBe(expected);
  });

  it('returns null for unknown entity types', () => {
    expect(getEntityUrl('nonsense', 'x')).toBeNull();
  });

  it('URL-encodes entity ids', () => {
    expect(getEntityUrl('company', 'a b/c')).toBe('/library/companies?company=a%20b%2Fc');
  });

  it('never emits the generic ?open= param no page listens to', () => {
    for (const type of Object.keys(ENTITY_LIST_PATHS)) {
      expect(getEntityUrl(type, 'id-1')).not.toContain('open=');
    }
  });

  it('only declares sheet params for types with a list path', () => {
    for (const type of Object.keys(ENTITY_SHEET_PARAMS)) {
      expect(ENTITY_LIST_PATHS[type]).toBeDefined();
    }
  });

  it('opens the entity sheet for every property-bearing type (signals/radar excluded by design)', () => {
    const sheetTypes = [
      'company',
      'technology',
      'strategy',
      'useCase',
      'prototype',
      'orgUnit',
      'initiative',
      'painPoint',
      'document',
    ];
    for (const type of sheetTypes) {
      expect(ENTITY_SHEET_PARAMS[type]).toBeDefined();
    }
  });
});

describe('getEntityTypeFromGraphLabels', () => {
  it.each([
    [['Entity', 'Company'], 'company'],
    [['Entity', 'Technology'], 'technology'],
    [['Entity', 'UseCase'], 'useCase'],
    [['Entity', 'Prototype'], 'prototype'],
    [['Entity', 'Strategy'], 'strategy'],
    [['Entity', 'Signal'], 'signal'],
    [['Entity', 'OrgUnit'], 'orgUnit'],
    [['Entity', 'Initiative'], 'initiative'],
    [['Entity', 'PainPoint'], 'painPoint'],
    [['Document'], 'document'],
  ])('maps labels %j to entity type %s', (labels, expected) => {
    expect(getEntityTypeFromGraphLabels(labels)).toBe(expected);
  });

  it('returns null for non-entity labels', () => {
    expect(getEntityTypeFromGraphLabels(['CommunityReport'])).toBeNull();
    expect(getEntityTypeFromGraphLabels([])).toBeNull();
  });

  it('is exact-match: lowercase labels (e.g. on :Memory nodes) are not entities', () => {
    expect(getEntityTypeFromGraphLabels(['Memory', 'technology'])).toBeNull();
  });
});

describe('resolveGraphNodeEntityId', () => {
  const elementId = '4:c0a65d5c-e6d8-4f0e-8b1e-9a1f2b3c4d5e:42';

  it('prefers the Firestore id from properties.id over the renderer node id', () => {
    const node = { id: elementId, properties: { id: 'tech-1769448924185-a4l8qs8' } };
    expect(resolveGraphNodeEntityId(node)).toBe('tech-1769448924185-a4l8qs8');
  });

  it('ignores empty/whitespace/non-string properties.id', () => {
    expect(resolveGraphNodeEntityId({ id: 'tech-1', properties: { id: '' } })).toBe('tech-1');
    expect(resolveGraphNodeEntityId({ id: 'tech-1', properties: { id: '   ' } })).toBe('tech-1');
    expect(resolveGraphNodeEntityId({ id: 'tech-1', properties: { id: 42 } })).toBe('tech-1');
    expect(resolveGraphNodeEntityId({ id: 'tech-1', properties: {} })).toBe('tech-1');
  });

  it('never falls back to a Neo4j elementId-shaped node id', () => {
    expect(resolveGraphNodeEntityId({ id: elementId, properties: {} })).toBeNull();
  });

  it('never falls back to a numeric legacy-identity node id', () => {
    expect(resolveGraphNodeEntityId({ id: '12345', properties: {} })).toBeNull();
  });

  it('returns null when nothing usable exists', () => {
    expect(resolveGraphNodeEntityId({ id: '', properties: {} })).toBeNull();
  });
});
