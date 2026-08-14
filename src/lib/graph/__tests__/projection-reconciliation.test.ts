import {
  CLAIM_RELATION_PREDICATES,
  RELATION_TYPES_LOWER,
  resolveNeo4jPredicate,
} from '../relation-registry';
import {
  buildReconciliationRepairPlan,
  classifyAgentRunSource,
  nextReconciliationCursor,
  pageAfterCursor,
  parseReconciliationCursor,
  RECONCILIATION_KINDS,
  RECONCILED_RELATION_PREDICATES,
  relationProjectionFingerprint,
  relationNeedsReplay,
} from '../projection-reconciliation';

const rows = ['a', 'c', 'e', 'g'].map((id) => ({ id, data: {} }));

describe('projection reconciliation cursor', () => {
  it('starts at the first row and respects the page boundary', () => {
    expect(pageAfterCursor(rows, null, 2)).toEqual({ rows: rows.slice(0, 2), wrapped: false });
  });

  it('uses Firestore-compatible UTF-8 ordering rather than locale collation', () => {
    const unicodeRows = ['\u{1F600}', '\u{E000}', 'z', '\u00E4'].map((id) => ({ id, data: {} }));
    expect(pageAfterCursor(unicodeRows, null, 10).rows.map((row) => row.id)).toEqual([
      'z',
      '\u00E4',
      '\u{E000}',
      '\u{1F600}',
    ]);
  });

  it('starts after an exact existing cursor', () => {
    expect(pageAfterCursor(rows, 'c', 2)).toEqual({ rows: rows.slice(2, 4), wrapped: false });
  });

  it('includes the first row after a deleted cursor between IDs', () => {
    expect(pageAfterCursor(rows, 'd', 2)).toEqual({ rows: rows.slice(2, 4), wrapped: false });
  });

  it('starts at the first row when a cursor sorts below it', () => {
    expect(pageAfterCursor(rows, '0', 2)).toEqual({ rows: rows.slice(0, 2), wrapped: false });
  });

  it('wraps explicitly when a cursor sorts at or above the final row', () => {
    expect(pageAfterCursor(rows, 'g', 2)).toEqual({ rows: rows.slice(0, 2), wrapped: true });
    expect(pageAfterCursor(rows, 'z', 2)).toEqual({ rows: rows.slice(0, 2), wrapped: true });
  });

  it('returns an empty wrapped page for an exhausted empty source', () => {
    expect(pageAfterCursor([], 'old', 2)).toEqual({ rows: [], wrapped: true });
  });

  it('increments the cycle only on explicit wrap', () => {
    const cursor = { version: 1 as const, afterId: 'c', cycle: 3 };
    expect(nextReconciliationCursor(cursor, 'e', false)).toEqual({ version: 1, afterId: 'e', cycle: 3 });
    expect(nextReconciliationCursor(cursor, 'a', true)).toEqual({ version: 1, afterId: 'a', cycle: 4 });
  });

  it('fails closed on unknown cursor versions', () => {
    expect(() => parseReconciliationCursor({ version: 2, afterId: null, cycle: 0 })).toThrow(/version/i);
  });
});

describe('projection reconciliation registry', () => {
  it('covers every scheduled projection kind exactly once', () => {
    expect(new Set(RECONCILIATION_KINDS).size).toBe(16);
    expect(RECONCILIATION_KINDS).toEqual(
      expect.arrayContaining(['signals', 'relations', 'documentLinks', 'radars', 'radarPlacements', 'agentRuns'])
    );
  });

  it('derives relation coverage from the canonical predicate registry', () => {
    expect(RECONCILED_RELATION_PREDICATES).toBe(CLAIM_RELATION_PREDICATES);
    expect([...RECONCILED_RELATION_PREDICATES].sort()).toEqual(
      [...new Set(RELATION_TYPES_LOWER.map(resolveNeo4jPredicate))].sort()
    );
    expect(RECONCILED_RELATION_PREDICATES).toContain('EVALUATES');
    expect(RECONCILED_RELATION_PREDICATES).toContain('RELATED_TO');
  });
});

describe('AgentRun source classification', () => {
  const payload = {
    id: 'run-1',
    agentName: 'scout',
    action: 'Research a technology',
    status: 'success',
    userId: 'user-1',
    createdAt: '2026-07-14T10:00:00.000Z',
    costUsd: 0.25,
    duration: 1200,
    missionId: 'mission-1',
  };

  it('accepts exactly one lifecycle owner and ignores unrelated optional fields', () => {
    expect(
      classifyAgentRunSource({
        id: 'run-1',
        data: { ...payload, tokenUsage: { input: 12, output: 8 }, futureField: true },
      })
    ).toEqual({
      outcome: 'eligible',
      params: payload,
    });
  });

  it.each(['success', 'failure', 'skipped'] as const)(
    'accepts the authoritative %s terminal status',
    (status) => {
      expect(
        classifyAgentRunSource({ id: 'run-1', data: { ...payload, status } })
      ).toMatchObject({ outcome: 'eligible', params: { status } });
    }
  );

  it.each(['running', 'live', 'SUCCESS', ' success ', '', null, undefined])(
    'rejects non-authoritative or padded status %p',
    (status) => {
      expect(
        classifyAgentRunSource({ id: 'run-1', data: { ...payload, status } })
      ).toEqual({ outcome: 'malformed-source', reason: 'invalid-payload' });
    }
  );

  it('threads explicit estimated authority and accepts an honestly unavailable cost', () => {
    expect(
      classifyAgentRunSource({
        id: 'run-1',
        data: { ...payload, costState: 'estimated' },
      })
    ).toMatchObject({
      outcome: 'eligible',
      params: { costUsd: 0.25, costState: 'estimated' },
    });

    const { costUsd: _costUsd, ...unavailable } = payload;
    const result = classifyAgentRunSource({ id: 'run-1', data: unavailable });
    expect(result).toMatchObject({ outcome: 'eligible' });
    if (result.outcome === 'eligible') {
      expect(result.params).not.toHaveProperty('costUsd');
      expect(result.params).not.toHaveProperty('costState');
    }
  });

  it.each(['provider-final-v3', '', null, 42])(
    'rejects an explicit malformed cost authority %p instead of relabelling it settled',
    (costState) => {
      expect(
        classifyAgentRunSource({
          id: 'run-1',
          data: { ...payload, costState },
        })
      ).toEqual({ outcome: 'malformed-source', reason: 'invalid-payload' });

      const { missionId: _missionId, ...standalone } = payload;
      expect(
        classifyAgentRunSource({
          id: 'run-1',
          data: { ...standalone, costState },
        })
      ).toEqual({ outcome: 'malformed-source', reason: 'invalid-payload' });
    }
  );

  it('rejects a costState without a numeric cost', () => {
    const { costUsd: _costUsd, ...withoutCost } = payload;
    expect(
      classifyAgentRunSource({
        id: 'run-1',
        data: { ...withoutCost, costState: 'estimated' },
      })
    ).toEqual({ outcome: 'malformed-source', reason: 'invalid-payload' });
  });

  it('classifies standalone history without guessing an owner', () => {
    const { missionId: _missionId, ...standalone } = payload;
    expect(classifyAgentRunSource({ id: 'run-1', data: standalone })).toEqual({
      outcome: 'standalone',
      reason: 'no-lifecycle-owner',
    });
  });

  it('classifies dual-owner and invalid rows without throwing', () => {
    expect(
      classifyAgentRunSource({ id: 'run-1', data: { ...payload, sweepId: 'sweep-1' } })
    ).toEqual({ outcome: 'malformed-source', reason: 'dual-owner' });
    expect(
      classifyAgentRunSource({ id: 'run-1', data: { ...payload, duration: Number.NaN } })
    ).toEqual({ outcome: 'malformed-source', reason: 'invalid-payload' });
    expect(
      classifyAgentRunSource({ id: 'run-1', data: { ...payload, id: 'other-run' } })
    ).toEqual({ outcome: 'malformed-source', reason: 'id-mismatch' });
    expect(
      classifyAgentRunSource({ id: 'run-1', data: { ...payload, missionId: ' mission-1 ' } })
    ).toEqual({ outcome: 'malformed-source', reason: 'invalid-owner' });
  });
});

describe('relation projection classification', () => {
  it('versions graph-driving content even when updatedAt is reused', () => {
    const base = {
      sourceSnapshot: { id: 'a', type: 'company', name: 'A' },
      targetSnapshot: { id: 'b', type: 'technology', name: 'B' },
      relationType: 'uses',
      confidence: 80,
      notes: 'before',
      updatedAt: 100,
    };
    expect(relationProjectionFingerprint(base)).not.toBe(
      relationProjectionFingerprint({ ...base, notes: 'after', updatedAt: 100 })
    );
  });

  it('does not treat evidence reordering as a new projection generation', () => {
    const base = {
      sourceSnapshot: { id: 'a', type: 'company', name: 'A' },
      targetSnapshot: { id: 'b', type: 'technology', name: 'B' },
      relationType: 'uses',
      evidenceRefs: [{ id: 'one' }, { id: 'two' }],
    };
    expect(relationProjectionFingerprint(base)).toBe(
      relationProjectionFingerprint({ ...base, evidenceRefs: [...base.evidenceRefs].reverse() })
    );
  });

  it('replays correlation-only or fingerprint-only drift on a direct edge', () => {
    const source = {
      sourceSnapshot: { id: 'company-1' },
      targetSnapshot: { id: 'technology-1' },
      relationType: 'uses',
      claimStatus: 'curated',
      sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000',
      sourceFingerprint: 'a'.repeat(64),
    };
    const exact = {
      relationId: 'rel-versioned',
      activeEdge: true,
      activeEdgeCount: 1,
      edgeSourceId: 'company-1',
      edgeTargetId: 'technology-1',
      edgePredicate: 'USES',
      edgeSourceCorrelationId: source.sourceCorrelationId,
      edgeSourceFingerprint: source.sourceFingerprint,
      assertionStatus: null,
      assertionCount: 0,
    };

    expect(relationNeedsReplay(source, exact)).toBe(false);
    expect(
      relationNeedsReplay(source, {
        ...exact,
        edgeSourceCorrelationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
    ).toBe(true);
    expect(relationNeedsReplay(source, { ...exact, edgeSourceFingerprint: 'b'.repeat(64) })).toBe(true);
  });

  it('requires the source version on both an Assertion and its active edge', () => {
    const source = {
      sourceSnapshot: { id: 'company-1' },
      targetSnapshot: { id: 'technology-1' },
      relationType: 'uses',
      aiSuggested: true,
      claimStatus: 'curated',
      confidence: 90,
      sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000',
      sourceFingerprint: 'a'.repeat(64),
    };
    const exact = {
      relationId: 'rel-assertion-versioned',
      activeEdge: true,
      activeEdgeCount: 1,
      edgeSourceId: 'company-1',
      edgeTargetId: 'technology-1',
      edgePredicate: 'USES',
      edgeSourceCorrelationId: source.sourceCorrelationId,
      edgeSourceFingerprint: source.sourceFingerprint,
      assertionStatus: 'curated',
      assertionCount: 1,
      assertionSourceId: 'company-1',
      assertionTargetId: 'technology-1',
      assertionPredicate: 'USES',
      assertionSourceCorrelationId: source.sourceCorrelationId,
      assertionSourceFingerprint: source.sourceFingerprint,
    };

    expect(relationNeedsReplay(source, exact)).toBe(false);
    expect(relationNeedsReplay(source, { ...exact, assertionSourceFingerprint: null })).toBe(true);
    expect(relationNeedsReplay(source, { ...exact, edgeSourceCorrelationId: null })).toBe(true);
  });

  it('keeps pre-contract source rows compatible when graph provenance is absent', () => {
    expect(
      relationNeedsReplay(
        {
          sourceSnapshot: { id: 'company-1' },
          targetSnapshot: { id: 'technology-1' },
          relationType: 'uses',
          claimStatus: 'curated',
        },
        {
          relationId: 'rel-legacy',
          activeEdge: true,
          activeEdgeCount: 1,
          edgeSourceId: 'company-1',
          edgeTargetId: 'technology-1',
          edgePredicate: 'USES',
          edgeSourceCorrelationId: null,
          edgeSourceFingerprint: null,
          assertionStatus: null,
          assertionCount: 0,
        }
      )
    ).toBe(false);
  });

  it('ignores a later operation trace when the authoritative source pair still matches', () => {
    const source = {
      sourceSnapshot: { id: 'company-1' },
      targetSnapshot: { id: 'technology-1' },
      relationType: 'uses',
      claimStatus: 'curated',
      sourceCorrelationId: 'corr_123e4567-e89b-42d3-a456-426614174000',
      sourceFingerprint: 'a'.repeat(64),
    };
    const feedbackStampedGraph = {
      relationId: 'rel-feedback',
      activeEdge: true,
      activeEdgeCount: 1,
      edgeSourceId: 'company-1',
      edgeTargetId: 'technology-1',
      edgePredicate: 'USES',
      edgeSourceCorrelationId: source.sourceCorrelationId,
      edgeSourceFingerprint: source.sourceFingerprint,
      assertionStatus: null,
      assertionCount: 0,
      correlationId: 'corr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };

    expect(relationNeedsReplay(source, feedbackStampedGraph)).toBe(false);
  });

  it('replays curated rows without an active edge even when a stale proposed assertion exists', () => {
    expect(
      relationNeedsReplay(
        { aiSuggested: true, claimStatus: 'curated', confidence: 40 },
        { relationId: 'rel-1', activeEdge: false, assertionStatus: 'proposed' }
      )
    ).toBe(true);
  });

  it('replays a curated row whose Assertion status is still proposed', () => {
    expect(
      relationNeedsReplay(
        { aiSuggested: true, claimStatus: 'curated', confidence: 90 },
        { relationId: 'rel-1', activeEdge: true, assertionStatus: 'proposed', assertionCount: 1 }
      )
    ).toBe(true);
  });

  it('replays duplicate Assertions instead of accepting an arbitrary status', () => {
    expect(
      relationNeedsReplay(
        { aiSuggested: true, claimStatus: 'curated', confidence: 90 },
        { relationId: 'rel-1', activeEdge: true, assertionStatus: null, assertionCount: 2 }
      )
    ).toBe(true);
  });

  it('removes a stale Assertion when a relation now belongs on the direct-edge path', () => {
    expect(
      relationNeedsReplay(
        { claimStatus: 'curated', confidence: 90 },
        { relationId: 'rel-1', activeEdge: true, assertionStatus: 'curated', assertionCount: 1 }
      )
    ).toBe(true);
  });

  it('accepts an intentionally withheld low-confidence proposal with an Assertion', () => {
    expect(
      relationNeedsReplay(
        { aiSuggested: true, claimStatus: 'proposed', confidence: 40 },
        { relationId: 'rel-1', activeEdge: false, assertionStatus: 'proposed' }
      )
    ).toBe(false);
  });

  it('replays rejected rows that still expose an active edge', () => {
    expect(
      relationNeedsReplay(
        { aiSuggested: true, claimStatus: 'rejected', confidence: 80 },
        { relationId: 'rel-1', activeEdge: true, assertionStatus: 'rejected' }
      )
    ).toBe(true);
  });

  it('replays a direct edge with stale endpoints, predicate, or duplicates', () => {
    const source = {
      sourceSnapshot: { id: 'company-1' },
      targetSnapshot: { id: 'technology-1' },
      relationType: 'uses',
      claimStatus: 'curated',
    };
    expect(
      relationNeedsReplay(source, {
        relationId: 'rel-1',
        activeEdge: true,
        activeEdgeCount: 1,
        edgeSourceId: 'company-old',
        edgeTargetId: 'technology-1',
        edgePredicate: 'USES',
        assertionStatus: null,
      })
    ).toBe(true);
    expect(
      relationNeedsReplay(source, {
        relationId: 'rel-1',
        activeEdge: true,
        activeEdgeCount: 1,
        edgeSourceId: 'company-old',
        edgeTargetId: 'technology-1',
        edgePredicate: 'USES',
        assertionStatus: 'proposed',
        assertionCount: 1,
        assertionSourceId: 'company-1',
        assertionTargetId: 'technology-1',
        assertionPredicate: 'USES',
      })
    ).toBe(true);
    expect(
      relationNeedsReplay(source, {
        relationId: 'rel-1',
        activeEdge: true,
        activeEdgeCount: 2,
        edgeSourceId: null,
        edgeTargetId: null,
        edgePredicate: null,
        assertionStatus: null,
      })
    ).toBe(true);
  });

  it('replays assertion topology drift and noncanonical active edges even when an edge may be withheld', () => {
    const source = {
      sourceSnapshot: { id: 'company-1' },
      targetSnapshot: { id: 'technology-1' },
      relationType: 'uses',
      aiSuggested: true,
      claimStatus: 'proposed',
      confidence: 40,
    };
    expect(
      relationNeedsReplay(source, {
        relationId: 'rel-1',
        activeEdge: false,
        activeEdgeCount: 0,
        unexpectedActiveEdgeCount: 1,
        assertionStatus: 'proposed',
        assertionCount: 1,
        assertionSourceId: 'company-1',
        assertionTargetId: 'technology-1',
        assertionPredicate: 'USES',
      })
    ).toBe(true);
    expect(
      relationNeedsReplay(source, {
        relationId: 'rel-1',
        activeEdge: false,
        activeEdgeCount: 0,
        assertionStatus: 'proposed',
        assertionCount: 1,
        assertionSourceId: 'company-old',
        assertionTargetId: 'technology-1',
        assertionPredicate: 'USES',
      })
    ).toBe(true);
  });
});

describe('exact repair plans', () => {
  it('hashes sorted exact-ID operations deterministically and cannot apply them', () => {
    const one = buildReconciliationRepairPlan([
      { kind: 'signals', id: 'sig-z', action: 'delete-candidate', reason: 'inbox-only' },
      { kind: 'relations', id: 'rel-a', action: 'replay', reason: 'missing' },
    ]);
    const two = buildReconciliationRepairPlan([...one.operations].reverse());
    expect(two.planHash).toBe(one.planHash);
    expect(one.applySupported).toBe(false);
    expect(one.destructiveApplyRequiresBackup).toBe(true);
    expect(one.planHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
