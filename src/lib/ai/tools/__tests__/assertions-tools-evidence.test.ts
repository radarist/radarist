/**
 * Tests for the F2 read-path fallback in executeGetRelationEvidence.
 *
 * Post-F3 (schema simplification), ~95% of edges are plain typed edges
 * with no :Assertion/:Claim bridge. The tool used to return empty evidence
 * for that case; it must now fall through to (a) Firestore evidenceRefs
 * and (b) edge-annotation notes.
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));
// assertions-tools.ts now reads/writes relations through the admin-SDK twin
// (@/lib/relations-admin), not the client @/lib/relations module. Mock the
// admin module so the spies observe the calls.
jest.mock('@/lib/relations-admin', () => ({
  adminGetRelationById: jest.fn(),
  adminCreateRelationFromIds: jest.fn(),
  adminDeleteRelation: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));
// claims-tools.ts imports getAssertionWithEvidence from the @/lib/graph barrel,
// not the raw module. Mock the barrel so the spy sees the call.
jest.mock('@/lib/graph', () => ({
  getAssertionWithEvidence: jest.fn(),
  getAssertionWithEvidenceByRelationId: jest.fn(),
  explainConnection: jest.fn(),
  getAssertionsForEntity: jest.fn(),
  runReadTransaction: jest.fn(),
}));
jest.mock('@/lib/inngest/client', () => ({
  sendEvent: jest.fn(),
  inngest: { send: jest.fn() },
}));

import * as relationsAdmin from '@/lib/relations-admin';
import * as graph from '@/lib/graph';
import {
  executeCreateRelationWithEvidence,
  executeGetRelationEvidence,
  executeExplainRelation,
} from '../assertions-tools';

const mockedGet = relationsAdmin.adminGetRelationById as jest.Mock;
const mockedClaim = graph.getAssertionWithEvidence as jest.Mock;
const mockedClaimByRelationId = graph.getAssertionWithEvidenceByRelationId as jest.Mock;
const mockedExplainConnection = graph.explainConnection as jest.Mock;

function baseRelation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rel-1',
    sourceSnapshot: { id: 's', type: 'technology', name: 'S' },
    targetSnapshot: { id: 'o', type: 'technology', name: 'O' },
    relationType: 'uses',
    confidence: 85,
    claimStatus: 'curated',
    reasoningSummary: null,
    evidenceRefs: [],
    notes: null,
    ...overrides,
  } as unknown;
}

describe('executeGetRelationEvidence — provenance fallback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks provenanceSource=assertion when the :Claim/:Assertion bridge has Evidence', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: 'claim-x' }));
    mockedClaim.mockResolvedValue({
      claim: {},
      evidence: [{ sourceType: 'document_chunk', snippet: 'real snippet', sourceUrl: 'https://x' }],
    });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });
    expect(r.success).toBe(true);
    expect(r.evidence?.provenanceSource).toBe('assertion');
    expect(r.evidence?.sources).toHaveLength(1);
    expect(r.evidence?.sources?.[0].snippet).toBe('real snippet');
  });

  it('falls back to Firestore evidenceRefs when no Assertion Evidence exists', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        evidenceRefs: [{ type: 'signal', snippet: 'firestore snippet', signalId: 'sig-1' }],
      })
    );
    mockedClaim.mockResolvedValue({ claim: {}, evidence: [] });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });
    expect(r.evidence?.provenanceSource).toBe('firestore-refs');
    expect(r.evidence?.sources?.[0].snippet).toBe('firestore snippet');
  });

  it('reads every durable evidence source variant without collapsing its source semantics', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          { id: 'doc', type: 'document_chunk', documentId: 'doc-1', chunkId: 'chunk-1', capturedAt: 1 },
          { id: 'signal', type: 'signal', signalId: 'signal-1', capturedAt: 2 },
          {
            id: 'entity',
            type: 'entity_field',
            entityId: 'tech-1',
            entityType: 'technology',
            entityField: 'description',
            capturedAt: 3,
          },
          { id: 'web', type: 'web_ref', url: 'https://example.test/source', capturedAt: 4 },
          { id: 'user', type: 'user_assertion', snippet: 'review note', capturedAt: 5 },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.sources).toEqual([
      expect.objectContaining({ type: 'document_chunk', documentId: 'doc-1' }),
      expect.objectContaining({ type: 'signal', signalId: 'signal-1' }),
      expect.objectContaining({
        type: 'entity_field',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      }),
      expect.objectContaining({ type: 'web_ref', url: 'https://example.test/source' }),
      expect.objectContaining({ type: 'user_assertion', snippet: 'review note' }),
    ]);
    expect(r.evidence?.claimChip).toMatchObject({ kind: 'corroborated', independentSourceCount: 3 });
  });

  it('surfaces durable proposal reasoning after the proposal record is no longer available', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        reasoningSummary: 'Headline summary',
        evidenceRefs: [
          {
            id: 'proposal:p-17:reasoning',
            sourceKey: 'proposal:p-17:reasoning',
            type: 'user_assertion',
            snippet: 'Distinct proposal rationale',
            capturedAt: 1,
          },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.provenanceSource).toBe('firestore-refs');
    expect(result.evidence?.reasoningSummary).toBe('Headline summary');
    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ type: 'user_assertion', snippet: 'Distinct proposal rationale' }),
    ]);
  });

  it('merges partial Assertion evidence with newer durable Firestore provenance', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        evidenceRefs: [
          {
            id: 'ref-old',
            sourceKey: 'source-old',
            type: 'signal',
            snippet: 'Firestore refresh of old evidence',
            signalId: 'sig-old',
            capturedAt: 1,
          },
          {
            id: 'proposal:p-new:reasoning',
            sourceKey: 'proposal:p-new:reasoning',
            type: 'user_assertion',
            snippet: 'New durable proposal reasoning',
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'neo-evidence-old',
          sourceKey: 'source-old',
          sourceType: 'signal',
          snippet: 'Stale graph snippet',
          signalId: 'sig-old',
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.provenanceSource).toBe('merged');
    expect(result.evidence?.sources).toHaveLength(2);
    expect(result.evidence?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snippet: 'Firestore refresh of old evidence' }),
        expect.objectContaining({ snippet: 'New durable proposal reasoning' }),
      ])
    );
    expect(result.evidence?.sources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ snippet: 'Stale graph snippet' })])
    );
  });

  it('refreshes graph document evidence when only Firestore retains chunkIndex', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-document',
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'firestore-document',
            sourceKey: 'document:doc-1:chunk-7',
            type: 'document_chunk',
            snippet: 'Fresh durable document excerpt.',
            documentId: 'doc-1',
            chunkId: 'chunk-7',
            chunkIndex: 7,
            pageNumber: 4,
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'graph-document',
          sourceKey: 'document:doc-1:chunk-7',
          sourceType: 'document_chunk',
          snippet: 'Stale graph document excerpt.',
          documentId: 'doc-1',
          chunkId: 'chunk-7',
          pageNumber: 4,
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.provenanceSource).toBe('merged');
    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({
        snippet: 'Fresh durable document excerpt.',
        documentId: 'doc-1',
        chunkId: 'chunk-7',
        chunkIndex: 7,
        pageNumber: 4,
      }),
    ]);
  });

  it('uses the required Firestore evidence id as the graph sync key when sourceKey is absent', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-document',
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'document:doc-1:chunk-7',
            type: 'document_chunk',
            snippet: 'Fresh durable excerpt without an optional source key.',
            documentId: 'doc-1',
            chunkId: 'chunk-7',
            chunkIndex: 7,
            pageNumber: 4,
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'graph-document',
          sourceKey: 'document:doc-1:chunk-7',
          sourceType: 'document_chunk',
          snippet: 'Stale graph excerpt.',
          documentId: 'doc-1',
          chunkId: 'chunk-7',
          pageNumber: 4,
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.provenanceSource).toBe('merged');
    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({
        snippet: 'Fresh durable excerpt without an optional source key.',
        documentId: 'doc-1',
        chunkId: 'chunk-7',
        chunkIndex: 7,
        pageNumber: 4,
      }),
    ]);
  });

  it('deduplicates identical display evidence even when Firestore and Neo4j use different internal source keys', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'firestore-evidence',
            sourceKey: 'proposal:p-1:reasoning',
            type: 'user_assertion',
            snippet: 'The exact marker rationale.',
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'neo4j-evidence',
          sourceKey: 'claim:claim-x:reasoning',
          sourceType: 'user_assertion',
          snippet: 'The exact marker rationale.',
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.provenanceSource).toBe('merged');
    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ type: 'user_assertion', snippet: 'The exact marker rationale.' }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'unverified', independentSourceCount: 0 });
  });

  it('keeps identical snippets from genuinely distinct sources separate', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'firestore-web',
            sourceKey: 'web:firestore',
            type: 'web_ref',
            snippet: 'Shared factual wording.',
            url: 'https://source-b.example/evidence',
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'neo4j-web',
          sourceKey: 'web:neo4j',
          sourceType: 'web_ref',
          snippet: 'Shared factual wording.',
          sourceUrl: 'https://source-a.example/evidence',
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ url: 'https://source-a.example/evidence' }),
      expect.objectContaining({ url: 'https://source-b.example/evidence' }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'corroborated', independentSourceCount: 2 });
  });

  it('does not let a reused persistence sourceKey erase a distinct URL', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'firestore-web',
            sourceKey: 'legacy-colliding-key',
            type: 'web_ref',
            snippet: 'Shared factual wording.',
            url: 'https://source-b.example/evidence',
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'neo4j-web',
          sourceKey: 'legacy-colliding-key',
          sourceType: 'web_ref',
          snippet: 'Shared factual wording.',
          sourceUrl: 'https://source-a.example/evidence',
        },
      ],
    });

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ url: 'https://source-a.example/evidence' }),
      expect.objectContaining({ url: 'https://source-b.example/evidence' }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'corroborated', independentSourceCount: 2 });
  });

  it('preserves distinct document chunks and pages even when their visible snippets match', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'doc-page-2',
            sourceKey: 'document:doc-1:chunk-2',
            type: 'document_chunk',
            snippet: 'Repeated page header.',
            documentId: 'doc-1',
            chunkId: 'chunk-2',
            chunkIndex: 2,
            pageNumber: 2,
            capturedAt: 2,
          },
          {
            id: 'doc-page-1',
            sourceKey: 'document:doc-1:chunk-1',
            type: 'document_chunk',
            snippet: 'Repeated page header.',
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            chunkIndex: 1,
            pageNumber: 1,
            capturedAt: 1,
          },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ documentId: 'doc-1', chunkId: 'chunk-1', chunkIndex: 1, pageNumber: 1 }),
      expect.objectContaining({ documentId: 'doc-1', chunkId: 'chunk-2', chunkIndex: 2, pageNumber: 2 }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'single', independentSourceCount: 1 });
  });

  it('preserves distinct signal and entity-field coordinates with matching text', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'signal-b',
            type: 'signal',
            snippet: 'Shared wording.',
            signalId: 'signal-b',
            capturedAt: 4,
          },
          {
            id: 'entity-title',
            type: 'entity_field',
            snippet: 'Shared wording.',
            entityId: 'technology-1',
            entityType: 'technology',
            entityField: 'title',
            capturedAt: 3,
          },
          {
            id: 'signal-a',
            type: 'signal',
            snippet: 'Shared wording.',
            signalId: 'signal-a',
            capturedAt: 2,
          },
          {
            id: 'entity-description',
            type: 'entity_field',
            snippet: 'Shared wording.',
            entityId: 'technology-1',
            entityType: 'technology',
            entityField: 'description',
            capturedAt: 1,
          },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ signalId: 'signal-a' }),
      expect.objectContaining({ signalId: 'signal-b' }),
      expect.objectContaining({ entityId: 'technology-1', entityField: 'description' }),
      expect.objectContaining({ entityId: 'technology-1', entityField: 'title' }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'corroborated', independentSourceCount: 2 });
  });

  it('returns deterministic evidence order independent of Neo4j collection order', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({ claimId: 'claim-x', claimStatus: 'proposed', aiSuggested: true, evidenceRefs: [] })
    );
    const sourceA = {
      id: 'source-a',
      sourceKey: 'web:a',
      sourceType: 'web_ref',
      snippet: 'Evidence A',
      sourceUrl: 'https://source-a.example/evidence',
    };
    const sourceB = {
      id: 'source-b',
      sourceKey: 'web:b',
      sourceType: 'web_ref',
      snippet: 'Evidence B',
      sourceUrl: 'https://source-b.example/evidence',
    };
    mockedClaim
      .mockResolvedValueOnce({ claim: { asserterType: 'agent' }, evidence: [sourceB, sourceA] })
      .mockResolvedValueOnce({ claim: { asserterType: 'agent' }, evidence: [sourceA, sourceB] });

    const first = await executeGetRelationEvidence({ relationId: 'rel-1' });
    const second = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(first.evidence?.sources).toEqual(second.evidence?.sources);
    expect(first.evidence?.sources).toEqual([
      expect.objectContaining({ url: 'https://source-a.example/evidence' }),
      expect.objectContaining({ url: 'https://source-b.example/evidence' }),
    ]);
  });

  it('preserves distinct claims from one source while collapsing exact partial duplicates', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'claim-b',
            type: 'web_ref',
            snippet: 'Claim B',
            url: 'https://source.example/evidence',
            capturedAt: 3,
          },
          {
            id: 'claim-a-copy',
            type: 'web_ref',
            snippet: ' Claim A ',
            url: ' https://source.example/evidence ',
            capturedAt: 2,
          },
          {
            id: 'claim-a',
            type: 'web_ref',
            snippet: 'Claim A',
            url: 'https://source.example/evidence',
            capturedAt: 1,
          },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const result = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(result.evidence?.sources).toEqual([
      expect.objectContaining({ snippet: expect.stringMatching(/^\s*Claim A\s*$/) }),
      expect.objectContaining({ snippet: 'Claim B' }),
    ]);
    expect(result.evidence?.claimChip).toMatchObject({ kind: 'single', independentSourceCount: 1 });
  });

  it('falls back to edge-annotation notes when there is no Assertion and no Firestore refs', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        evidenceRefs: [],
        notes: 'Primary tech stack — added by alice',
      })
    );

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });
    expect(r.evidence?.provenanceSource).toBe('edge-annotations');
    expect(r.evidence?.sources).toHaveLength(1);
    expect(r.evidence?.sources?.[0].type).toBe('edge_annotation');
    expect(r.evidence?.sources?.[0].snippet).toContain('Primary tech stack');
  });

  it('returns provenanceSource=none when nothing is available', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: null, evidenceRefs: [], notes: null }));

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });
    expect(r.evidence?.provenanceSource).toBe('none');
    expect(r.evidence?.sources).toEqual([]);
  });

  it('handles Neo4j outage gracefully — still tries Firestore refs', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: 'claim-x',
        evidenceRefs: [{ type: 'web_ref', snippet: 'from firestore', url: 'https://s' }],
      })
    );
    mockedClaim.mockRejectedValueOnce(new Error('Neo4j down'));

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });
    expect(r.evidence?.provenanceSource).toBe('firestore-refs');
    expect(r.evidence?.sources?.[0].snippet).toBe('from firestore');
  });

  it('returns error when the relation itself does not exist', async () => {
    mockedGet.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'missing' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  // --------------------------------------------------------------------------
  // M3 (D9 null-tolerant read): legacy relation rows never got claimId written
  // back — the tool must fall back to resolving the :Assertion by relationId
  // instead of silently skipping the assertion layer.
  // --------------------------------------------------------------------------

  it('M3: resolves the :Assertion by relationId when the relation doc has no claimId (legacy rows)', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: null }));
    mockedClaimByRelationId.mockResolvedValue({
      claim: { id: 'claim-legacy' },
      evidence: [{ sourceType: 'signal', snippet: 'assertion-backed snippet', signalId: 'sig-7' }],
    });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(mockedClaimByRelationId).toHaveBeenCalledWith('rel-1');
    expect(mockedClaim).not.toHaveBeenCalled();
    expect(r.evidence?.provenanceSource).toBe('assertion');
    expect(r.evidence?.sources?.[0].snippet).toBe('assertion-backed snippet');
  });

  it('M3: prefers the claimId pointer when present (no relationId fallback query)', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: 'claim-x' }));
    mockedClaim.mockResolvedValue({
      claim: { id: 'claim-x' },
      evidence: [{ sourceType: 'web_ref', snippet: 'pointer snippet', sourceUrl: 'https://y' }],
    });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(mockedClaim).toHaveBeenCalledWith('claim-x');
    expect(mockedClaimByRelationId).not.toHaveBeenCalled();
    expect(r.evidence?.provenanceSource).toBe('assertion');
  });
});

// ----------------------------------------------------------------------------
// H4 — createRelationWithEvidence used to fire BOTH app/relation.sync.requested
// (via adminCreateRelationFromIds → triggerRelationSyncSafely) AND a direct
// app/claim.sync.requested — producing two :Assertion nodes and two typed
// edges with DIFFERENT predicates (mapped USES vs raw 'uses'), with no F1
// between them. The relation pipeline (Class B/C) is the single sync channel.
// ----------------------------------------------------------------------------

describe('executeCreateRelationWithEvidence — single sync pipeline (H4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the relation once and sends NO direct claim.sync event (relation pipeline is the only channel)', async () => {
    const mockedCreate = relationsAdmin.adminCreateRelationFromIds as jest.Mock;
    mockedCreate.mockResolvedValue({
      id: 'rel-new',
      sourceSnapshot: { id: 'tech-1', type: 'technology', name: 'LangChain' },
      targetSnapshot: { id: 'tech-2', type: 'technology', name: 'Claude API' },
    });

    const r = await executeCreateRelationWithEvidence({
      sourceType: 'technology',
      sourceId: 'tech-1',
      targetType: 'technology',
      targetId: 'tech-2',
      relationType: 'uses',
      confidence: 80,
      evidence: { snippet: 'LangChain calls the Claude API', sourceUrl: 'https://docs.example' },
      reasoningSummary: 'observed in docs',
    });

    expect(r.success).toBe(true);
    expect(r.relationId).toBe('rel-new');

    // Exactly ONE sync source: the Firestore create fires the single
    // app/relation.sync.requested inside adminCreateRelationFromIds.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const { sendEvent, inngest } = jest.requireMock('@/lib/inngest/client');
    expect(sendEvent).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();

    // The evidence reaches the graph through the relation doc (Class B/C
    // loads evidenceRefs), so it must be on the create input.
    const input = mockedCreate.mock.calls[0][0];
    expect(input.claimStatus).toBe('proposed');
    expect(input.aiSuggested).toBe(true);
    // B1 — distinct asserter identity: the AI Assistant tool stamps its own
    // agent name rather than leaving the sync handler to fall back to 'linker'.
    expect(input.agentName).toBe('assistant');
    expect(input.evidenceRefs).toHaveLength(1);
    expect(input.evidenceRefs[0]).toMatchObject({
      type: 'web_ref',
      snippet: 'LangChain calls the Claude API',
      url: 'https://docs.example',
    });
  });
});

// ----------------------------------------------------------------------------
// Task 9 (C3b) — corroboration chips surfaced through the assertion tools.
// executeGetRelationEvidence.evidence.claimChip and
// executeExplainRelation.explanation.chip must both be populated via
// deriveClaimChip so the chat extractor (chat-entity-refs.ts) has a top-level
// field to read (not nested under `data`).
// ----------------------------------------------------------------------------

describe('executeGetRelationEvidence — claim chip (Task 9)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('computes a corroborated chip from multi-source assertion evidence, using the fetched assertion asserterType', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: 'claim-x', claimStatus: 'proposed', aiSuggested: true }));
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        { sourceType: 'document_chunk', snippet: 's1', documentId: 'doc-1', id: 'ev-1' },
        { sourceType: 'signal', snippet: 's2', signalId: 'sig-1', id: 'ev-2' },
      ],
    });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.claimChip).toMatchObject({
      relationId: 'rel-1',
      kind: 'corroborated',
      independentSourceCount: 2,
    });
  });

  it('derives the chip from Firestore evidenceRefs when there is no Assertion bridge', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [{ id: 'ev-1', type: 'signal', snippet: 'firestore snippet', signalId: 'sig-1' }],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.claimChip).toMatchObject({
      relationId: 'rel-1',
      kind: 'single',
      independentSourceCount: 1,
    });
  });

  it('reads entity_field coordinates from Neo4j without treating first-party content as corroboration', async () => {
    mockedGet.mockResolvedValue(baseRelation({ claimId: 'claim-entity', claimStatus: 'proposed', aiSuggested: true }));
    mockedClaim.mockResolvedValue({
      claim: { asserterType: 'agent' },
      evidence: [
        {
          id: 'ev-entity',
          sourceKey: 'proposal:p1:entity_field:tech-1:hash',
          sourceType: 'entity_field',
          snippet: 'The entity description names the dependency.',
          entityId: 'tech-1',
          entityType: 'technology',
          entityField: 'description',
        },
      ],
    });

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.sources).toEqual([
      expect.objectContaining({
        type: 'entity_field',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      }),
    ]);
    expect(r.evidence?.claimChip).toMatchObject({ kind: 'unverified', independentSourceCount: 0 });
  });

  it('retains entity_field coordinates in the Firestore fallback while counting only independent sources', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        claimStatus: 'proposed',
        aiSuggested: true,
        evidenceRefs: [
          {
            id: 'entity-ref',
            type: 'entity_field',
            snippet: 'First-party description',
            entityId: 'tech-1',
            entityType: 'technology',
            entityField: 'description',
            capturedAt: 1,
          },
          {
            id: 'web-ref',
            type: 'web_ref',
            snippet: 'Independent source',
            url: 'https://example.test/independent',
            capturedAt: 2,
          },
        ],
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'entity_field',
          entityId: 'tech-1',
          entityType: 'technology',
          entityField: 'description',
        }),
      ])
    );
    expect(r.evidence?.claimChip).toMatchObject({ kind: 'single', independentSourceCount: 1 });
  });

  it('falls back to relation.aiSuggested for asserterType when no assertion is found — curated edge chips ★ Curated', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({ claimId: null, evidenceRefs: [], notes: null, claimStatus: 'curated', aiSuggested: false })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.claimChip).toMatchObject({ relationId: 'rel-1', kind: 'curated' });
  });

  it('chips a proposed, agent-suggested edge with no evidence as unverified (not curated)', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({ claimId: null, evidenceRefs: [], notes: null, claimStatus: 'proposed', aiSuggested: true })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.claimChip).toMatchObject({ kind: 'unverified', independentSourceCount: 0 });
  });

  it('excludes edge_annotation evidence from corroboration counting but still chips curated', async () => {
    mockedGet.mockResolvedValue(
      baseRelation({
        claimId: null,
        evidenceRefs: [],
        notes: 'Primary tech stack — added by alice',
        claimStatus: 'curated',
        aiSuggested: false,
      })
    );
    mockedClaimByRelationId.mockResolvedValue(null);

    const r = await executeGetRelationEvidence({ relationId: 'rel-1' });

    expect(r.evidence?.provenanceSource).toBe('edge-annotations');
    expect(r.evidence?.claimChip).toMatchObject({ kind: 'curated', independentSourceCount: 0 });
  });
});

describe('executeExplainRelation — claim chip (Task 9)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('derives a curated chip for a plain edge-backed explanation (pass-2 synthesis: evidence: [], status: curated)', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'rel-9',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'uses',
          confidence: 80,
          status: 'curated',
          asserterType: 'user',
          reasoningSummary: null,
        },
        evidence: [],
        asserter: { id: 'user:alice', name: 'alice' },
        relationType: { name: 'uses' },
      },
    ]);

    const r = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(r.explanation?.chip).toMatchObject({ relationId: 'rel-9', kind: 'curated', independentSourceCount: 0 });
  });

  it('derives a corroborated chip for an assertion-backed explanation with 2+ distinct evidence sources', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'claim-1',
          relationId: 'rel-10',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'addresses',
          confidence: 82,
          status: 'proposed',
          asserterType: 'agent',
          reasoningSummary: 'observed twice',
        },
        evidence: [
          { sourceType: 'document_chunk', snippet: 'a', documentId: 'doc-1', id: 'e1' },
          { sourceType: 'web_ref', snippet: 'b', sourceUrl: 'https://x', id: 'e2' },
        ],
        asserter: { id: 'agent:scout', name: 'scout' },
        relationType: { name: 'addresses' },
      },
    ]);

    const r = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(r.explanation?.chip).toMatchObject({
      relationId: 'rel-10',
      kind: 'corroborated',
      independentSourceCount: 2,
    });
  });

  it('does not inflate visible evidence for duplicate graph rows with different internal keys', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'claim-duplicate',
          relationId: 'rel-duplicate',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'uses',
          confidence: 70,
          status: 'proposed',
          asserterType: 'agent',
          reasoningSummary: 'marker relation',
        },
        evidence: [
          {
            id: 'neo-evidence-a',
            sourceKey: 'proposal:p-1:reasoning',
            sourceType: 'user_assertion',
            snippet: 'The exact marker rationale.',
          },
          {
            id: 'neo-evidence-b',
            sourceKey: 'claim:claim-duplicate:reasoning',
            sourceType: 'user_assertion',
            snippet: 'The exact marker rationale.',
          },
        ],
        asserter: { id: 'agent:assistant', name: 'assistant' },
        relationType: { name: 'uses' },
      },
    ]);

    const result = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(result.explanation?.evidenceCount).toBe(1);
    expect(result.explanation?.evidenceSnippets).toEqual(['The exact marker rationale.']);
    expect(result.message).toContain('with 1 evidence snippet.');
    expect(result.explanation?.chip).toMatchObject({ kind: 'unverified', independentSourceCount: 0 });
  });

  it('does not let duplicate persistence IDs inflate an incomplete source into corroborated evidence', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'claim-partial-duplicate',
          relationId: 'rel-partial-duplicate',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'uses',
          confidence: 70,
          status: 'proposed',
          asserterType: 'agent',
          reasoningSummary: 'partial source relation',
        },
        evidence: [
          {
            id: 'persistence-id-a',
            sourceKey: 'legacy-source-a',
            sourceType: 'web_ref',
            snippet: 'Same incomplete source.',
          },
          {
            id: 'persistence-id-b',
            sourceKey: 'legacy-source-b',
            sourceType: 'web_ref',
            snippet: 'Same incomplete source.',
          },
        ],
        asserter: { id: 'agent:assistant', name: 'assistant' },
        relationType: { name: 'uses' },
      },
    ]);

    const result = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(result.explanation?.evidenceCount).toBe(1);
    expect(result.explanation?.chip).toMatchObject({ kind: 'single', independentSourceCount: 1 });
  });

  it('keeps the same snippet twice when it is backed by distinct independent URLs', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'claim-distinct',
          relationId: 'rel-distinct',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'uses',
          confidence: 80,
          status: 'proposed',
          asserterType: 'agent',
          reasoningSummary: 'corroborated relation',
        },
        evidence: [
          {
            id: 'source-a',
            sourceKey: 'web:a',
            sourceType: 'web_ref',
            snippet: 'Shared factual wording.',
            sourceUrl: 'https://source-a.example/evidence',
          },
          {
            id: 'source-b',
            sourceKey: 'web:b',
            sourceType: 'web_ref',
            snippet: 'Shared factual wording.',
            sourceUrl: 'https://source-b.example/evidence',
          },
        ],
        asserter: { id: 'agent:assistant', name: 'assistant' },
        relationType: { name: 'uses' },
      },
    ]);

    const result = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(result.explanation?.evidenceCount).toBe(2);
    expect(result.explanation?.evidenceSnippets).toEqual(['Shared factual wording.', 'Shared factual wording.']);
    expect(result.explanation?.chip).toMatchObject({ kind: 'corroborated', independentSourceCount: 2 });
  });

  it('keeps matching text from distinct document chunk and page coordinates', async () => {
    mockedExplainConnection.mockResolvedValue([
      {
        claim: {
          id: 'claim-document-pages',
          relationId: 'rel-document-pages',
          subjectId: 's',
          subjectName: 'S',
          objectId: 'o',
          objectName: 'O',
          predicate: 'uses',
          confidence: 80,
          status: 'proposed',
          asserterType: 'agent',
          reasoningSummary: 'document-backed relation',
        },
        evidence: [
          {
            id: 'page-2',
            sourceType: 'document_chunk',
            snippet: 'Repeated page header.',
            documentId: 'doc-1',
            chunkId: 'chunk-2',
            pageNumber: 2,
          },
          {
            id: 'page-1',
            sourceType: 'document_chunk',
            snippet: 'Repeated page header.',
            documentId: 'doc-1',
            chunkId: 'chunk-1',
            pageNumber: 1,
          },
        ],
        asserter: { id: 'agent:assistant', name: 'assistant' },
        relationType: { name: 'uses' },
      },
    ]);

    const result = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(result.explanation?.evidenceCount).toBe(2);
    expect(result.explanation?.evidenceSnippets).toEqual(['Repeated page header.', 'Repeated page header.']);
    expect(result.explanation?.chip).toMatchObject({ kind: 'single', independentSourceCount: 1 });
  });

  it('has no chip when there is no connection between the entities', async () => {
    mockedExplainConnection.mockResolvedValue([]);

    const r = await executeExplainRelation({ sourceId: 's', targetId: 'o' });

    expect(r.explanation?.chip).toBeUndefined();
  });
});
