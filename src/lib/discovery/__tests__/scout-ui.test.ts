import {
  buildGraphScoutContext,
  clampScoutViewContext,
  getDiscoveryScoutFailureMessage,
  SCOUT_CONTEXT_MAX_ITEMS,
  SCOUT_CONTEXT_MAX_TERM_LENGTH,
} from '../scout-ui';

describe('getDiscoveryScoutFailureMessage', () => {
  it('turns debounce milliseconds into an actionable rounded wait', () => {
    expect(getDiscoveryScoutFailureMessage(429, { retryAfterMs: 61_000 })).toContain('2 minutes');
  });

  it.each([
    ['automation_paused', 'Enable Background Automation'],
    ['discovery_disabled', 'disabled in the local environment'],
    ['automation_policy_unavailable', 'No scout was queued'],
    ['maintenance_paused', 'MAINTENANCE_PAUSED'],
  ])('maps %s to honest operator guidance', (code, expected) => {
    expect(getDiscoveryScoutFailureMessage(409, { code })).toContain(expected);
  });

  it('preserves an unknown server error', () => {
    expect(getDiscoveryScoutFailureMessage(500, { error: 'Inngest unavailable' })).toBe('Inngest unavailable');
  });
});

describe('buildGraphScoutContext', () => {
  const entityNode = (id: string, tags: string[] = []) => ({
    id: `neo4j-element-${id}`,
    labels: ['Entity', 'Technology'],
    properties: { id, name: id, tags },
  });

  it('collects entity ids plus name and tag topics from Entity-labeled nodes', () => {
    const context = buildGraphScoutContext([
      entityNode('tech-1', ['graph-db', 'llm']),
      entityNode('tech-2', ['graph-db']),
    ]);
    expect(context).toEqual({
      focusEntityIds: ['tech-1', 'tech-2'],
      focusTopics: ['tech-1', 'graph-db', 'llm', 'tech-2'],
    });
  });

  it('uses entity names as topics when tags are empty (DISC-016 — untagged views stay view-scoped)', () => {
    const context = buildGraphScoutContext([entityNode('Neo4j'), entityNode('Weaviate')]);
    expect(context).toEqual({
      focusEntityIds: ['Neo4j', 'Weaviate'],
      focusTopics: ['Neo4j', 'Weaviate'],
    });
  });

  it('returns undefined when entities carry neither names nor tags (no usable topic scope)', () => {
    const context = buildGraphScoutContext([
      { id: 'n1', labels: ['Entity'], properties: { id: 'tech-1' } },
      { id: 'n2', labels: ['Entity'], properties: { id: 'tech-2', tags: [] } },
    ]);
    expect(context).toBeUndefined();
  });

  it('ignores non-entity nodes (placements, assertions, signals without Entity label)', () => {
    const context = buildGraphScoutContext([
      { id: 'p1', labels: ['RadarPlacement'], properties: { id: 'placement-1' } },
      { id: 'a1', labels: ['Assertion'], properties: { id: 'assert-1' } },
    ]);
    expect(context).toBeUndefined();
  });

  it('returns undefined for an empty view (the scout is not offered without scope)', () => {
    expect(buildGraphScoutContext([])).toBeUndefined();
  });

  it('caps both lists at SCOUT_CONTEXT_MAX_ITEMS (bounded payload)', () => {
    const nodes = Array.from({ length: SCOUT_CONTEXT_MAX_ITEMS + 10 }, (_, i) =>
      entityNode(`tech-${i}`, [`topic-${i}`])
    );
    const context = buildGraphScoutContext(nodes);
    expect(context?.focusEntityIds).toHaveLength(SCOUT_CONTEXT_MAX_ITEMS);
    expect(context?.focusTopics).toHaveLength(SCOUT_CONTEXT_MAX_ITEMS);
  });

  it('drops non-string ids/tags and dedupes repeats', () => {
    const context = buildGraphScoutContext([
      { id: 'n1', labels: ['Entity'], properties: { id: 'tech-1', tags: ['llm', 42, 'llm'] } },
      { id: 'n2', labels: ['Entity'], properties: { id: 'tech-1', tags: null } },
      { id: 'n3', labels: ['Entity'], properties: { id: 7 } },
    ]);
    expect(context).toEqual({ focusEntityIds: ['tech-1'], focusTopics: ['llm'] });
  });
});

describe('clampScoutViewContext', () => {
  it('passes through a well-formed bounded context', () => {
    expect(clampScoutViewContext({ focusEntityIds: ['t1'], focusTopics: ['LLM Agents'] })).toEqual({
      focusEntityIds: ['t1'],
      focusTopics: ['LLM Agents'],
    });
  });

  it.each([[undefined], [null], ['nope'], [42], [[]]])('returns undefined for non-object input %p', (input) => {
    expect(clampScoutViewContext(input)).toBeUndefined();
  });

  it('returns undefined when nothing usable survives filtering', () => {
    expect(clampScoutViewContext({ focusEntityIds: [1, ''], focusTopics: '   ' })).toBeUndefined();
  });

  it('caps list lengths and truncates oversized terms', () => {
    const clamped = clampScoutViewContext({
      focusEntityIds: Array.from({ length: SCOUT_CONTEXT_MAX_ITEMS + 5 }, (_, i) => `id-${i}`),
      focusTopics: ['x'.repeat(SCOUT_CONTEXT_MAX_TERM_LENGTH + 50)],
    });
    expect(clamped?.focusEntityIds).toHaveLength(SCOUT_CONTEXT_MAX_ITEMS);
    expect(clamped?.focusTopics?.[0]).toHaveLength(SCOUT_CONTEXT_MAX_TERM_LENGTH);
  });

  it('trims whitespace and dedupes while preserving order', () => {
    expect(clampScoutViewContext({ focusEntityIds: [' t1 ', 't1', 't2'], focusTopics: ['a', ' a ', 'b'] })).toEqual({
      focusEntityIds: ['t1', 't2'],
      focusTopics: ['a', 'b'],
    });
  });
});
