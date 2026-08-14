/**
 * @file confidence-calibration.test.ts
 * @description Mocked unit tests for the B3 feedback → confidence
 * recalibration writer (`applyConfidenceFeedback`) and its shared
 * `effectiveConfidenceSet` Cypher-fragment helper.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));
jest.mock('../assertions', () => ({
  __esModule: true,
  getAssertionWithEvidenceByRelationId: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import * as neo4j from '../neo4j-client';
import * as assertions from '../assertions';
import {
  applyConfidenceFeedback,
  applyConfidenceFeedbackToEdge,
  applyConfidenceFeedbackToAssertion,
  relationFeedbackTargetsExist,
  applyCorroborationNudge,
  corroborationNudge,
  effectiveConfidenceSet,
} from '../confidence-calibration';
import { calculateCorroborationScore } from '@/lib/signals/trust-score';

const mockedWrite = neo4j.runWriteTransaction as jest.Mock;
const mockedRead = neo4j.runReadTransaction as jest.Mock;
const mockedGetAssertion = assertions.getAssertionWithEvidenceByRelationId as jest.Mock;
const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

beforeEach(() => jest.clearAllMocks());

describe('effectiveConfidenceSet — shared derivation fragment', () => {
  it('derives from coalesce(assertedConfidence, confidence, 100) + coalesce(corroborationNudge,0) + coalesce(feedbackDelta,0), clamped [5,100]', () => {
    const frag = effectiveConfidenceSet('r');
    expect(frag).toContain('r.effectiveConfidence = CASE');
    expect(frag).toContain(
      'coalesce(r.assertedConfidence, r.confidence, 100) + coalesce(r.corroborationNudge, 0) + coalesce(r.feedbackDelta, 0)'
    );
    expect(frag).toContain('> 100 THEN 100');
    expect(frag).toContain('< 5   THEN 5');
  });

  it('parameterizes by alias so the same fragment works for edges (r) and Assertion nodes (a)', () => {
    const edgeFrag = effectiveConfidenceSet('r');
    const assertionFrag = effectiveConfidenceSet('a');
    expect(edgeFrag).not.toContain('a.effectiveConfidence');
    expect(assertionFrag).toContain('a.effectiveConfidence');
    expect(assertionFrag).not.toContain('r.effectiveConfidence');
  });
});

describe('applyConfidenceFeedback', () => {
  it('applies +5/-5 to feedbackDelta with a ±25 bound and re-derives effectiveConfidence', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }])).mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedback('rel-1', 'up', TEST_CORRELATION_ID);

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('coalesce(r.feedbackDelta, 0) + $delta');
    expect(cypher).toContain('>  25 THEN  25');
    expect(cypher).toContain('< -25 THEN -25');
    expect(cypher).toContain(
      'coalesce(r.assertedConfidence, r.confidence, 100) + coalesce(r.corroborationNudge, 0) + coalesce(r.feedbackDelta, 0)'
    );
    expect(params.delta).toBe(5);
    expect(params.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('applies -5 on a down vote', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }])).mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedback('rel-1', 'down', TEST_CORRELATION_ID);

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.delta).toBe(-5);
    expect(params.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('never SETs confidence or assertedConfidence', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }])).mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedback('rel-1', 'up');

    for (const [cypher] of mockedWrite.mock.calls) {
      expect(cypher).not.toMatch(/SET\s+[a-z]\.confidence\s*=/);
      expect(cypher).not.toMatch(/[a-z]\.assertedConfidence\s*=(?!=)/);
    }
  });

  it('updates both the edge and the assertion matched by relationId', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }])).mockResolvedValueOnce(records([{ n: 1 }]));

    const result = await applyConfidenceFeedback('rel-42', 'up', TEST_CORRELATION_ID);

    expect(mockedWrite).toHaveBeenCalledTimes(2);
    const [edgeCypher, edgeParams] = mockedWrite.mock.calls[0];
    const [assertionCypher, assertionParams] = mockedWrite.mock.calls[1];
    expect(edgeCypher).toContain('()-[r {relationId: $relationId}]->()');
    expect(assertionCypher).toContain('(a:Assertion {relationId: $relationId})');
    expect(edgeParams.relationId).toBe('rel-42');
    expect(assertionParams.relationId).toBe('rel-42');
    expect(edgeParams.correlationId).toBe(TEST_CORRELATION_ID);
    expect(assertionParams.correlationId).toBe(TEST_CORRELATION_ID);
    expect(result).toEqual({ edgesUpdated: 1, assertionsUpdated: 1 });
  });

  it('reflects zero matches when neither the edge nor the assertion exist', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }])).mockResolvedValueOnce(records([{ n: 0 }]));

    const result = await applyConfidenceFeedback('rel-missing', 'up');

    expect(result).toEqual({ edgesUpdated: 0, assertionsUpdated: 0 });
  });

  it('composes applyConfidenceFeedbackToEdge then applyConfidenceFeedbackToAssertion (edge write first, single call each)', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }])).mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedback('rel-1', 'up');

    expect(mockedWrite).toHaveBeenCalledTimes(2);
    expect(mockedWrite.mock.calls[0][0]).toContain('()-[r {relationId: $relationId}]->()');
    expect(mockedWrite.mock.calls[1][0]).toContain('(a:Assertion {relationId: $relationId})');
  });
});

// ============================================================================
// LIVE-1 critical fix — split writers + read-only probe (2026-07-06)
// ============================================================================

describe('applyConfidenceFeedbackToEdge — edge-only write, independently memoizable', () => {
  it('writes only the edge cypher and returns { edgesUpdated }', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }]));

    const result = await applyConfidenceFeedbackToEdge('rel-1', 'up');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('()-[r {relationId: $relationId}]->()');
    expect(params).toEqual({ relationId: 'rel-1', delta: 5, now: expect.any(Number), correlationId: null });
    expect(cypher).toContain('r.correlationId = coalesce($correlationId, r.correlationId)');
    expect(result).toEqual({ edgesUpdated: 1 });
  });

  it('applies -5 on a down vote and never touches the Assertion cypher', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedbackToEdge('rel-1', 'down');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).not.toContain(':Assertion');
    expect(params.delta).toBe(-5);
  });

  it('stamps a strict correlation ID on an approved direct edge', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedbackToEdge('rel-1', 'up', TEST_CORRELATION_ID);

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('r.correlationId = coalesce($correlationId, r.correlationId)');
    expect(cypher).not.toContain('sourceCorrelationId');
    expect(cypher).not.toContain('sourceFingerprint');
    expect(params.correlationId).toBe(TEST_CORRELATION_ID);
  });

  it('rejects malformed correlation before direct-edge Neo4j access', async () => {
    await expect(applyConfidenceFeedbackToEdge('rel-1', 'up', 'caller-controlled-text')).rejects.toThrow(
      'Invalid confidence feedback correlation ID'
    );

    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('returns edgesUpdated: 0 when nothing matches (valid — not an error)', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }]));

    const result = await applyConfidenceFeedbackToEdge('rel-missing', 'up');

    expect(result).toEqual({ edgesUpdated: 0 });
  });
});

describe('applyConfidenceFeedbackToAssertion — assertion-only write, independently memoizable', () => {
  it('writes only the assertion cypher and returns { assertionsUpdated }', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }]));

    const result = await applyConfidenceFeedbackToAssertion('rel-1', 'up');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('(a:Assertion {relationId: $relationId})');
    expect(params).toEqual({ relationId: 'rel-1', delta: 5, now: expect.any(Number), correlationId: null });
    expect(cypher).toContain('a.correlationId = coalesce($correlationId, a.correlationId)');
    expect(result).toEqual({ assertionsUpdated: 1 });
  });

  it('returns assertionsUpdated: 0 when nothing matches (valid — Class B below-gate relation has no edge but this path is also 0-safe)', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }]));

    const result = await applyConfidenceFeedbackToAssertion('rel-missing', 'down');

    expect(result).toEqual({ assertionsUpdated: 0 });
  });

  it('stamps the same strict correlation ID on a rejected Assertion', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 1 }]));

    await applyConfidenceFeedbackToAssertion('rel-1', 'down', TEST_CORRELATION_ID);

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('a.correlationId = coalesce($correlationId, a.correlationId)');
    expect(cypher).not.toContain('sourceCorrelationId');
    expect(cypher).not.toContain('sourceFingerprint');
    expect(params).toMatchObject({ delta: -5, correlationId: TEST_CORRELATION_ID });
  });

  it('rejects malformed correlation before Assertion Neo4j access', async () => {
    await expect(applyConfidenceFeedbackToAssertion('rel-1', 'down', 'caller-controlled-text')).rejects.toThrow(
      'Invalid confidence feedback correlation ID'
    );

    expect(mockedWrite).not.toHaveBeenCalled();
  });
});

describe('relationFeedbackTargetsExist — read-only materialization probe', () => {
  it('uses a READ transaction, never a write', async () => {
    mockedRead.mockResolvedValueOnce(records([{ edgeCount: 1, assertionCount: 1 }]));

    await relationFeedbackTargetsExist('rel-1');

    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedWrite).not.toHaveBeenCalled();
    const [cypher, params] = mockedRead.mock.calls[0];
    expect(cypher).toContain('relationId: $relationId');
    expect(params).toEqual({ relationId: 'rel-1' });
  });

  it('reports { edge: true, assertion: true } when both counts are positive', async () => {
    mockedRead.mockResolvedValueOnce(records([{ edgeCount: 1, assertionCount: 2 }]));

    const result = await relationFeedbackTargetsExist('rel-1');

    expect(result).toEqual({ edge: true, assertion: true });
  });

  it('reports { edge: false, assertion: false } when neither has materialized', async () => {
    mockedRead.mockResolvedValueOnce(records([{ edgeCount: 0, assertionCount: 0 }]));

    const result = await relationFeedbackTargetsExist('rel-missing');

    expect(result).toEqual({ edge: false, assertion: false });
  });

  it('reports assertion-only materialization (Class B below-gate: Assertion exists, no typed edge yet)', async () => {
    mockedRead.mockResolvedValueOnce(records([{ edgeCount: 0, assertionCount: 1 }]));

    const result = await relationFeedbackTargetsExist('rel-proposed');

    expect(result).toEqual({ edge: false, assertion: true });
  });

  it('treats a missing/empty record row as neither existing', async () => {
    mockedRead.mockResolvedValueOnce(records([]));

    const result = await relationFeedbackTargetsExist('rel-empty');

    expect(result).toEqual({ edge: false, assertion: false });
  });
});

// ============================================================================
// C3 — corroboration → effectiveConfidence
// ============================================================================

describe('corroborationNudge — pure distinct-source → nudge mapping', () => {
  it('corroborationNudge maps 0/1/2/3/4+ → 0/0/+5/+10/+15', () => {
    expect(corroborationNudge(0)).toBe(0);
    expect(corroborationNudge(1)).toBe(0);
    expect(corroborationNudge(2)).toBe(5);
    expect(corroborationNudge(3)).toBe(10);
    expect(corroborationNudge(4)).toBe(15);
    expect(corroborationNudge(9)).toBe(15); // 4+ saturates at +15
  });
});

// ============================================================================
// Finding 1 — tier/nudge drift binder. corroborationNudge's 0/0/+5/+10/+15
// table and calculateCorroborationScore's 40/70/85/95 trust-score tiers
// (src/lib/signals/trust-score.ts) are frozen independently — nothing else
// ties them together. This test imports BOTH functions and asserts the
// composition directly: if either tier table is edited without the other,
// this fails loudly instead of the display-side trust score and the
// graph-side effectiveConfidence nudge silently drifting apart.
// ============================================================================

describe('corroborationNudge is bound to calculateCorroborationScore (drift guard)', () => {
  const NUDGE_BY_SCORE: Record<number, number> = { 40: 0, 70: 5, 85: 10, 95: 15 };

  it.each([0, 1, 2, 3, 4, 5])('distinctSources=%i: nudge matches the score tier it corresponds to', (n) => {
    const score = calculateCorroborationScore(n > 0, n);
    expect(corroborationNudge(n)).toBe(NUDGE_BY_SCORE[score]);
  });
});

describe('applyCorroborationNudge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Pin Date.now() so the `now` param is comparable across repeated calls
    // in the idempotence test below (real Date.now() would differ by a tick).
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => jest.restoreAllMocks());

  const evidenceWithThreeSources = [
    { id: 'ev-1', sourceType: 'document_chunk', documentId: 'doc-1' },
    { id: 'ev-2', sourceType: 'signal', signalId: 'sig-1' },
    { id: 'ev-3', sourceType: 'web_ref', sourceUrl: 'https://example.com/a' },
    // A user_assertion note must NOT count toward corroboration (same rule as
    // the display-side claim chips).
    { id: 'ev-4', sourceType: 'user_assertion', snippet: 'curated note' },
    // First-party entity content is provenance, but not independent evidence.
    { id: 'ev-5', sourceType: 'entity_field', entityId: 'tech-1', entityField: 'description' },
  ];

  function mockAssertionFound(evidence: Record<string, unknown>[]) {
    mockedGetAssertion.mockResolvedValue({
      claim: { id: 'claim-1', relationId: 'rel-1' },
      evidence,
    });
  }

  it('returns distinctSources 0, nudge 0, effectiveConfidence null when no assertion backs the relationId', async () => {
    mockedGetAssertion.mockResolvedValue(null);

    const result = await applyCorroborationNudge('rel-missing');

    expect(result).toEqual({ distinctSources: 0, nudge: 0, effectiveConfidence: null });
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('counts distinct sources via the SAME rule as the display chips (excludes notes and entity fields)', async () => {
    mockAssertionFound(evidenceWithThreeSources);
    mockedWrite
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]));

    const result = await applyCorroborationNudge('rel-1');

    // 3 distinct non-excluded sources → +10 nudge.
    expect(result.distinctSources).toBe(3);
    expect(result.nudge).toBe(10);
  });

  it('SETs a.corroborationNudge and re-derives effectiveConfidence on the Assertion first', async () => {
    mockAssertionFound(evidenceWithThreeSources);
    mockedWrite
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]));

    await applyCorroborationNudge('rel-1');

    const [assertionCypher, assertionParams] = mockedWrite.mock.calls[0];
    expect(assertionCypher).toContain('(a:Assertion {relationId: $relationId})');
    expect(assertionCypher).toContain('a.corroborationNudge = $nudge');
    expect(assertionCypher).toContain('a.effectiveConfidence = CASE');
    expect(assertionParams).toEqual({ relationId: 'rel-1', nudge: 10, now: expect.any(Number) });
  });

  it('mirrors the recomputed effectiveConfidence onto the edge', async () => {
    mockAssertionFound(evidenceWithThreeSources);
    mockedWrite
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]));

    const result = await applyCorroborationNudge('rel-1');

    expect(mockedWrite).toHaveBeenCalledTimes(2);
    const [edgeCypher, edgeParams] = mockedWrite.mock.calls[1];
    expect(edgeCypher).toContain('()-[r {relationId: $relationId}]->()');
    expect(edgeCypher).toContain('r.corroborationNudge = $nudge');
    expect(edgeCypher).toContain('r.effectiveConfidence = CASE');
    expect(edgeParams).toEqual({ relationId: 'rel-1', nudge: 10, now: expect.any(Number) });
    expect(result.effectiveConfidence).toBe(90);
  });

  it('is idempotent — same evidence twice yields the same SET params', async () => {
    mockAssertionFound(evidenceWithThreeSources);
    mockedWrite
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]))
      .mockResolvedValueOnce(records([{ effectiveConfidence: 90, n: 1 }]));

    const first = await applyCorroborationNudge('rel-1');
    const [, firstAssertionParams] = mockedWrite.mock.calls[0];
    const [, firstEdgeParams] = mockedWrite.mock.calls[1];

    const second = await applyCorroborationNudge('rel-1');
    const [, secondAssertionParams] = mockedWrite.mock.calls[2];
    const [, secondEdgeParams] = mockedWrite.mock.calls[3];

    expect(secondAssertionParams).toEqual(firstAssertionParams);
    expect(secondEdgeParams).toEqual(firstEdgeParams);
    expect(second).toEqual(first);
  });
});
