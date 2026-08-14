/**
 * @file chat-entity-refs.test.ts
 * @description Pins the derivation of clickable entity chips from chat tool
 * results — the data source that makes AIMessage's entity chips render at all.
 */

import { extractEntityRefs, extractCitations, extractClaimChips, type ChatToolCall } from '../chat-entity-refs';
import { getEntityUrl } from '@/lib/entity-links';
import type { ClaimChip } from '@/lib/claim-chips';

const entityResult = (results: unknown[]): ChatToolCall => ({
  name: 'searchEntities',
  result: { success: true, data: { entityType: 'company', count: results.length, results } },
});

/** getRelatedEntities shape: data.related map whose KEY supplies the type. */
const relatedResult = (related: Record<string, unknown>): ChatToolCall => ({
  name: 'getRelatedEntities',
  result: { success: true, data: { sourceEntity: { type: 'company', id: 'c-1' }, related } },
});

/** searchKnowledgeGraph shape: data.entities array with per-item type. */
const knowledgeResult = (entities: unknown[]): ChatToolCall => ({
  name: 'searchKnowledgeGraph',
  result: {
    success: true,
    data: { entities, chunks: [], concepts: [], graphPaths: [], totalResults: entities.length, executionTimeMs: 5 },
  },
});

describe('extractEntityRefs', () => {
  it('extracts {type, id, name} refs from entity-shaped tool results', () => {
    const refs = extractEntityRefs([
      entityResult([
        { id: 'c-1', name: 'Anthropic', type: 'company', description: 'x' },
        { id: 't-1', name: 'LangChain', type: 'technology' },
      ]),
    ]);

    expect(refs).toEqual([
      { type: 'company', id: 'c-1', name: 'Anthropic' },
      { type: 'technology', id: 't-1', name: 'LangChain' },
    ]);
  });

  it('dedupes by type+id across multiple tool calls', () => {
    const refs = extractEntityRefs([
      entityResult([{ id: 'c-1', name: 'Anthropic', type: 'company' }]),
      entityResult([{ id: 'c-1', name: 'Anthropic', type: 'company' }]),
    ]);

    expect(refs).toHaveLength(1);
  });

  it('caps the number of refs at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `c-${i}`,
      name: `Company ${i}`,
      type: 'company',
    }));

    expect(extractEntityRefs([entityResult(many)])).toHaveLength(8);
  });

  it('ignores failed tool calls', () => {
    const refs = extractEntityRefs([{ name: 'searchEntities', result: { success: false, error: 'boom' } }]);

    expect(refs).toBeUndefined();
  });

  it('ignores non-entity result shapes (web search items, scalars, null)', () => {
    const refs = extractEntityRefs([
      entityResult([
        { title: 'A web page', url: 'https://example.com' }, // no id/name/type
        { id: 'c-1', name: 'Valid Co' }, // missing type
        { id: 'c-2', name: '', type: 'company' }, // empty name
        'a string',
        null,
      ]),
      { name: 'webSearch', result: { success: true, data: { answers: ['x'] } } },
    ]);

    expect(refs).toBeUndefined();
  });

  it('returns undefined for an empty turn so the field is omitted from JSON', () => {
    expect(extractEntityRefs([])).toBeUndefined();
  });

  it('extracts orgUnit refs from searchOrgUnits results and the type is navigable', () => {
    // T1-7: searchOrgUnits now emits the navigable entity type ('orgUnit') in
    // `type` and keeps the domain value (department/team/…) in `orgUnitType`.
    const refs = extractEntityRefs([
      {
        name: 'searchOrgUnits',
        result: {
          success: true,
          data: {
            query: 'engineering',
            count: 1,
            results: [
              { id: 'org-1', name: 'Engineering Department', type: 'orgUnit', orgUnitType: 'department', level: 'L2' },
            ],
          },
        },
      },
    ]);

    expect(refs).toEqual([{ type: 'orgUnit', id: 'org-1', name: 'Engineering Department' }]);
    // The chip must deep-link: 'orgUnit' resolves to a real page in entity-links
    expect(getEntityUrl('orgUnit', 'org-1')).toContain('/library/org-units');
    // …unlike the old domain value, which was not navigable
    expect(getEntityUrl('department', 'org-1')).toBeNull();
  });

  it('extracts refs from getRelatedEntities data.related — the map key supplies the type', () => {
    const refs = extractEntityRefs([
      relatedResult({
        companies: [{ id: 'c-2', name: 'Vercel', description: 'x' }],
        technologies: [{ id: 't-9', name: 'Next.js' }],
        useCases: [{ id: 'u-3', name: 'Edge rendering' }],
      }),
    ]);

    expect(refs).toEqual([
      { type: 'company', id: 'c-2', name: 'Vercel' },
      { type: 'technology', id: 't-9', name: 'Next.js' },
      { type: 'useCase', id: 'u-3', name: 'Edge rendering' },
    ]);
  });

  it('ignores unknown related keys and malformed related items', () => {
    const refs = extractEntityRefs([
      relatedResult({
        gadgets: [{ id: 'g-1', name: 'Unknown key' }], // unmapped key
        companies: [{ id: 42, name: 'numeric id' }, { name: 'missing id' }, null, 'a string'],
      }),
    ]);

    expect(refs).toBeUndefined();
  });

  it('extracts refs from searchKnowledgeGraph data.entities with the same structural check', () => {
    const refs = extractEntityRefs([
      knowledgeResult([
        { id: 'kg-1', name: 'Anthropic', type: 'company', score: 0.92, source: 'graph' },
        { id: 'kg-2', name: 'GraphRAG', type: 'technology', score: 0.81, source: 'vector' },
        { title: 'Not an entity', url: 'https://example.com' }, // filtered by shape
      ]),
    ]);

    expect(refs).toEqual([
      { type: 'company', id: 'kg-1', name: 'Anthropic' },
      { type: 'technology', id: 'kg-2', name: 'GraphRAG' },
    ]);
  });

  it('dedupes and caps across all three sources (results + entities + related)', () => {
    const refs = extractEntityRefs([
      entityResult([
        { id: 'c-1', name: 'Anthropic', type: 'company' },
        { id: 'c-2', name: 'Vercel', type: 'company' },
      ]),
      knowledgeResult([
        { id: 'c-1', name: 'Anthropic', type: 'company' }, // duplicate of results item
        { id: 't-1', name: 'LangChain', type: 'technology' },
      ]),
      relatedResult({
        companies: [{ id: 'c-2', name: 'Vercel' }], // duplicate of results item
        technologies: Array.from({ length: 10 }, (_, i) => ({ id: `t-rel-${i}`, name: `Tech ${i}` })),
      }),
    ]);

    expect(refs).toHaveLength(8); // capped
    // No duplicates by type+id
    const keys = refs!.map((r) => `${r.type}:${r.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The first unique refs from earlier sources survive
    expect(refs![0]).toEqual({ type: 'company', id: 'c-1', name: 'Anthropic' });
    expect(refs![2]).toEqual({ type: 'technology', id: 't-1', name: 'LangChain' });
  });
});

describe('extractCitations (Part D)', () => {
  const webResult = (citations: unknown): ChatToolCall => ({
    name: 'webSearch',
    result: { success: true, data: { summary: 'x', citations } },
  });

  it('collects grounded web citations, deduped by uri', () => {
    const cites = extractCitations([
      webResult([
        { uri: 'https://a.com/1', title: 'A' },
        { uri: 'https://a.com/1', title: 'A dup' },
        { uri: 'https://b.com/2', title: 'B' },
      ]),
    ]);
    expect(cites).toEqual([
      { uri: 'https://a.com/1', title: 'A' },
      { uri: 'https://b.com/2', title: 'B' },
    ]);
  });

  it('returns undefined when no tool produced citations', () => {
    expect(
      extractCitations([{ name: 'searchEntities', result: { success: true, data: { results: [] } } }])
    ).toBeUndefined();
    expect(extractCitations([])).toBeUndefined();
  });

  it('ignores failed tool results and malformed citation entries', () => {
    const cites = extractCitations([
      { name: 'webSearch', result: { success: false, error: 'boom' } },
      webResult([{ title: 'no uri' }, { uri: 42 }, { uri: 'https://ok.com', title: 'Ok' }]),
    ]);
    expect(cites).toEqual([{ uri: 'https://ok.com', title: 'Ok' }]);
  });

  // AI-048 — the Sources block must show publisher identities. Deduping on the
  // raw uri would list one publisher twice whenever Gemini returns two grounding
  // redirects for it, the same aliasing that inflates corroboration (GRAPH-070).
  describe('publisher identity (AI-048)', () => {
    const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';

    it('carries identityUri through to the UI', () => {
      const cites = extractCitations([
        webResult([{ uri: `${REDIRECT}AAA`, title: 'A', identityUri: 'https://publisher.com/article' }]),
      ]);

      expect(cites).toEqual([{ uri: `${REDIRECT}AAA`, title: 'A', identityUri: 'https://publisher.com/article' }]);
    });

    it('dedupes two redirects that resolve to ONE publisher into one source', () => {
      const cites = extractCitations([
        webResult([
          { uri: `${REDIRECT}AAA`, title: 'A', identityUri: 'https://publisher.com/article' },
          { uri: `${REDIRECT}BBB`, title: 'A again', identityUri: 'https://publisher.com/article' },
        ]),
      ]);

      expect(cites).toHaveLength(1);
      expect(cites?.[0].identityUri).toBe('https://publisher.com/article');
    });

    it('keeps genuinely distinct publishers separate', () => {
      const cites = extractCitations([
        webResult([
          { uri: `${REDIRECT}AAA`, identityUri: 'https://one.com/a' },
          { uri: `${REDIRECT}BBB`, identityUri: 'https://two.com/b' },
        ]),
      ]);

      expect(cites).toHaveLength(2);
    });

    it('omits identityUri when it is absent or not a string', () => {
      const cites = extractCitations([webResult([{ uri: 'https://ok.com', identityUri: 42 }])]);

      expect(cites).toEqual([{ uri: 'https://ok.com', title: undefined }]);
    });
  });
});

describe('extractClaimChips (Task 9)', () => {
  const chip = (relationId: string, overrides: Partial<ClaimChip> = {}): ClaimChip => ({
    relationId,
    statement: `${relationId} statement`,
    kind: 'corroborated',
    independentSourceCount: 2,
    ...overrides,
  });

  // getRelationEvidence result shape: {success, evidence: {..., claimChip}} — TOP LEVEL, not data.
  const evidenceCall = (claimChip: ClaimChip | undefined) => ({
    name: 'getRelationEvidence',
    result: { success: true, evidence: { relationId: claimChip?.relationId ?? 'unknown', sources: [], claimChip } },
  });

  // explainRelation result shape: {success, explanation: {..., chip}} — TOP LEVEL, not data.
  const explainCall = (chip: ClaimChip | undefined) => ({
    name: 'explainRelation',
    result: { success: true, explanation: { sourceId: 's', targetId: 't', chip } },
  });

  it('collects chips from getRelationEvidence and explainRelation result shapes (top-level, not data)', () => {
    const chips = extractClaimChips([evidenceCall(chip('rel-1')), explainCall(chip('rel-2', { kind: 'curated' }))]);

    expect(chips).toEqual([chip('rel-1'), chip('rel-2', { kind: 'curated' })]);
  });

  it('dedupes by relationId and caps at 6', () => {
    const calls = [
      evidenceCall(chip('rel-1')),
      explainCall(chip('rel-1')), // duplicate relationId — must not double-count
      evidenceCall(chip('rel-2')),
      evidenceCall(chip('rel-3')),
      evidenceCall(chip('rel-4')),
      evidenceCall(chip('rel-5')),
      evidenceCall(chip('rel-6')),
      evidenceCall(chip('rel-7')), // beyond the cap
    ];

    const chips = extractClaimChips(calls);

    expect(chips).toHaveLength(6);
    expect(chips!.map((c) => c.relationId)).toEqual(['rel-1', 'rel-2', 'rel-3', 'rel-4', 'rel-5', 'rel-6']);
  });

  it('returns undefined when no result carries a chip', () => {
    expect(
      extractClaimChips([
        evidenceCall(undefined),
        explainCall(undefined),
        { name: 'searchEntities', result: { success: true, data: { results: [] } } },
        { name: 'getRelationEvidence', result: { success: false, error: 'boom' } },
      ])
    ).toBeUndefined();
    expect(extractClaimChips([])).toBeUndefined();
  });
});
