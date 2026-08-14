/**
 * @file relation-assertion-sync.test.ts
 * @description Unit tests for the Assertion-first relation sync helper.
 *
 * UNMASKED 2026-07-03 (graph-foundation master plan, fix-cluster 3): the file
 * used to jest.mock BOTH `../assertions` (materializeAssertionAsEdge) and
 * `../temporal-queries` (invalidatePriorEdges) with bare jest.fn() stubs —
 * exactly the two seams where CRIT-1 lived (Class B edges self-invalidating on
 * every re-sync because the materialized edge carried a RANDOM relationId that
 * the invalidation self-exclusion could never match). The only boundary mocked
 * with fakes now is `../neo4j-client`. The assertions/temporal-queries mocks
 * below are jest.fn(actual) PASSTHROUGHS — real code by default (SWC emits
 * non-configurable module exports, so jest.spyOn can't patch them in place;
 * a wrapping module mock is the only way to observe calls without stubbing).
 * Orchestration describes override them per-test; the CRIT-1 contract tests at
 * the bottom re-install the real implementations and drive them against an
 * in-memory graph behind the mocked neo4j-client.
 */

// The ONLY behavior-replacing mock allowed in this file: the Neo4j boundary.
jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));
// Passthrough wrappers (real implementations by default) — see file header.
jest.mock('../assertions', () => {
  const actual = jest.requireActual('../assertions');
  return {
    __esModule: true,
    ...actual,
    addEvidenceToAssertion: jest.fn(actual.addEvidenceToAssertion),
    materializeAssertionAsEdge: jest.fn(actual.materializeAssertionAsEdge),
  };
});
jest.mock('../temporal-queries', () => {
  const actual = jest.requireActual('../temporal-queries');
  return {
    __esModule: true,
    ...actual,
    invalidatePriorEdges: jest.fn(actual.invalidatePriorEdges),
  };
});
// C3: applyCorroborationNudge has its own full unit-test coverage in
// confidence-calibration.test.ts — here it's a bare jest.fn() stub (not a
// passthrough) so the sync-hook tests only assert call-order/args and
// failure-tolerance, without also needing to stand up its Neo4j reads/writes.
jest.mock('../confidence-calibration', () => ({
  __esModule: true,
  applyCorroborationNudge: jest.fn(),
}));
// Increment 2 (C4): getAsserterReliability has its own full unit-test
// coverage in asserter-reliability.test.ts — passthrough by default so the
// no-flag tests above exercise the real (flag-off, bonus-0) resolution path,
// with a dedicated describe below overriding it to assert the upstream
// resolution contract itself.
jest.mock('../asserter-reliability', () => {
  const actual = jest.requireActual('../asserter-reliability');
  return {
    __esModule: true,
    ...actual,
    getAsserterReliability: jest.fn(actual.getAsserterReliability),
  };
});

import * as neo4j from '../neo4j-client';
import * as claims from '../assertions';
import * as temporal from '../temporal-queries';
import * as calibration from '../confidence-calibration';
import * as reliability from '../asserter-reliability';
import { deleteAssertionByRelationId, syncRelationAsAssertion, syncRelationAsEdge } from '../relation-assertion-sync';
import { shouldMaterializeAssertion } from '../assertions';

const actualAssertions = jest.requireActual('../assertions');
const actualTemporal = jest.requireActual('../temporal-queries');

const mockedWrite = neo4j.runWriteTransaction as jest.Mock;
const mockedRead = neo4j.runReadTransaction as jest.Mock;
const mockedAddEvidence = claims.addEvidenceToAssertion as jest.Mock;
const mockedMaterialize = claims.materializeAssertionAsEdge as jest.Mock;
const mockedInvalidate = temporal.invalidatePriorEdges as jest.Mock;
const mockedNudge = calibration.applyCorroborationNudge as jest.Mock;
const mockedGetReliability = reliability.getAsserterReliability as jest.Mock;

const writeResult = (records: Record<string, unknown>[]) => ({
  records,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

/**
 * Stub the orchestration seams for call-order/arg assertions.
 * deriveAsserterType and shouldMaterializeAssertion always run real.
 * The CRIT-1 describe re-installs the real implementations instead.
 */
function installOrchestrationSpies() {
  mockedAddEvidence.mockReset().mockResolvedValue({ evidence: { id: 'ev-1' }, created: true });
  mockedMaterialize.mockReset().mockResolvedValue({ created: true, edgeType: 'USES' });
  mockedInvalidate.mockReset().mockResolvedValue(0);
  mockedNudge.mockReset().mockResolvedValue({ distinctSources: 1, nudge: 0, effectiveConfidence: 88 });
  // Default flag-off resolution never even reads this — kept at zeros so a
  // test that forgets to reset ASSERTER_RELIABILITY_ENABLED still behaves.
  mockedGetReliability.mockReset().mockResolvedValue({ approvedCount: 0, rejectedCount: 0, reliabilityBonus: 0 });
  return {
    addEvidence: mockedAddEvidence,
    materialize: mockedMaterialize,
    invalidate: mockedInvalidate,
    nudge: mockedNudge,
    getReliability: mockedGetReliability,
  };
}

/** Re-install the REAL implementations (used by the CRIT-1 contract tests). */
function installRealImplementations() {
  mockedAddEvidence.mockReset().mockImplementation(actualAssertions.addEvidenceToAssertion);
  mockedMaterialize.mockReset().mockImplementation(actualAssertions.materializeAssertionAsEdge);
  mockedInvalidate.mockReset().mockImplementation(actualTemporal.invalidatePriorEdges);
  // confidence-calibration stays a bare stub here — CRIT-1 exercises the
  // Assertion/edge simulation, not the corroboration nudge (that has its own
  // full coverage in confidence-calibration.test.ts).
  mockedNudge.mockReset().mockResolvedValue({ distinctSources: 0, nudge: 0, effectiveConfidence: null });
  // Reliability flag is off by default in this suite — CRIT-1 doesn't exercise it.
  mockedGetReliability.mockReset().mockResolvedValue({ approvedCount: 0, rejectedCount: 0, reliabilityBonus: 0 });
}

const baseInput = {
  relationId: 'rel-test-1',
  subject: { id: 'tech-1', type: 'technology', name: 'LangChain' },
  object: { id: 'tech-2', type: 'technology', name: 'Claude API' },
  predicate: 'USES',
  confidence: 88,
  assertedBy: 'agent:linker',
  notes: 'LangChain forwards messages to the Claude API for reasoning',
};

const correlationId = 'corr_00000000-0000-4000-8000-000000000001';
const sourceFingerprint = 'a'.repeat(64);

describe('syncRelationAsAssertion', () => {
  let spies: ReturnType<typeof installOrchestrationSpies>;

  beforeEach(() => {
    jest.clearAllMocks();
    spies = installOrchestrationSpies();
  });

  it('upserts an Assertion, attaches Evidence from notes, and materializes the edge on first sync', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-1', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion(baseInput);

    expect(r.claimId).toBe('claim-1');
    expect(r.claimCreated).toBe(true);
    expect(r.edgeType).toBe('USES');
    expect(r.edgeCreated).toBe(true);
    expect(r.evidenceCreated).toBe(1);

    // Evidence snippet is the notes, source type is user_assertion.
    expect(spies.addEvidence).toHaveBeenCalledTimes(1);
    expect(spies.addEvidence).toHaveBeenCalledWith('claim-1', {
      sourceType: 'user_assertion',
      snippet: baseInput.notes,
    });

    expect(spies.materialize).toHaveBeenCalledWith('claim-1', expect.any(Object));
  });

  it('stores and forwards one validated source version for an Assertion projection', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-correlated', relationId: baseInput.relationId }, wasCreated: true }])
    );

    await syncRelationAsAssertion({
      ...baseInput,
      correlationId,
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    });

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(params.correlationId).toBe(correlationId);
    expect(cypher).toContain('claim.correlationId = $correlationId');
    expect(cypher).toContain('edge.correlationId = coalesce($correlationId, edge.correlationId)');
    expect(cypher).not.toContain('claim.sourceCorrelationId');
    expect(cypher).not.toContain('claim.sourceFingerprint');
    expect(spies.materialize).toHaveBeenCalledWith(
      'claim-correlated',
      expect.objectContaining({
        correlationId,
        sourceCorrelationId: correlationId,
        sourceFingerprint,
      })
    );
  });

  it('fails retryably before source convergence when Evidence attachment fails', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-evidence-failure', relationId: baseInput.relationId }, wasCreated: true }])
    );
    spies.addEvidence.mockRejectedValueOnce(new Error('evidence write unavailable'));

    await expect(
      syncRelationAsAssertion({
        ...baseInput,
        correlationId,
        sourceCorrelationId: correlationId,
        sourceFingerprint,
      })
    ).rejects.toThrow('evidence write unavailable');

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).not.toContain('claim.sourceCorrelationId');
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it('rejects arbitrary correlation text before the Assertion write', async () => {
    await expect(syncRelationAsAssertion({ ...baseInput, correlationId: 'private-note' })).rejects.toThrow(
      /correlation ID/
    );
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(spies.materialize).not.toHaveBeenCalled();
  });

  it('re-attaches evidence on re-sync without duplicating (idempotent accrual)', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-1', relationId: baseInput.relationId }, wasCreated: false }])
    );
    spies.addEvidence.mockResolvedValueOnce({ evidence: { id: 'ev-1' }, created: false });

    const r = await syncRelationAsAssertion(baseInput);

    expect(r.claimCreated).toBe(false);
    // The evidence-accrual guard was lifted — addEvidenceToAssertion is now
    // called on every sync (it MERGEs on sourceKey, so a re-sync of an
    // already-seen source refreshes the existing node instead of
    // duplicating it — created:false means no NEW evidence was added).
    expect(spies.addEvidence).toHaveBeenCalledTimes(1);
    expect(r.evidenceCreated).toBe(0);
    expect(spies.materialize).toHaveBeenCalledWith('claim-1', expect.any(Object));
  });

  it('counts newly accrued evidence from a new source on re-sync (+1)', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-1', relationId: baseInput.relationId }, wasCreated: false }])
    );
    spies.addEvidence.mockResolvedValueOnce({ evidence: { id: 'ev-2' }, created: true });

    const r = await syncRelationAsAssertion(baseInput);

    expect(r.claimCreated).toBe(false);
    expect(spies.addEvidence).toHaveBeenCalledTimes(1);
    // evidenceCreated counts NEW evidence only — a genuinely new source seen
    // on a re-sync still increments it even though the Assertion itself
    // already existed.
    expect(r.evidenceCreated).toBe(1);
  });

  it('produces no Evidence when notes are empty and no structured evidence passed', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-2' }, wasCreated: true }]));

    const r = await syncRelationAsAssertion({ ...baseInput, notes: '' });

    expect(r.evidenceCreated).toBe(0);
    expect(spies.addEvidence).not.toHaveBeenCalled();
  });

  it('uses provided structured evidence when present (ignores notes)', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-3' }, wasCreated: true }]));

    await syncRelationAsAssertion({
      ...baseInput,
      evidence: [
        { sourceType: 'document_chunk', snippet: 'chunk A', documentId: 'doc-1' },
        { sourceType: 'signal', snippet: 'sig B', signalId: 'sig-2' },
      ],
    });

    expect(spies.addEvidence).toHaveBeenCalledTimes(2);
    expect(spies.addEvidence.mock.calls[0][1].sourceType).toBe('document_chunk');
    expect(spies.addEvidence.mock.calls[1][1].sourceType).toBe('signal');
  });

  it('throws when materializeAssertionAsEdge returns null (assertion vanished)', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-4' }, wasCreated: true }]));
    spies.materialize.mockResolvedValueOnce(null);
    mockedRead.mockResolvedValueOnce(writeResult([]));

    await expect(syncRelationAsAssertion(baseInput)).rejects.toThrow(/materializeAssertionAsEdge/);
  });

  it('rewrites all mutable Assertion structure and removes obsolete projections', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-edit' }, wasCreated: false }]));

    await syncRelationAsAssertion({
      ...baseInput,
      subject: { id: 'new-source', type: 'company', name: 'New source' },
      object: { id: 'new-target', type: 'technology', name: 'New target' },
      predicate: 'SUPPORTS',
      assertedBy: 'user:reviewer',
      claimStatus: 'curated',
    });

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('claim.subjectId = $subjectId');
    expect(cypher).toContain('claim.objectId = $objectId');
    expect(cypher).toContain('claim.predicate = $predicate');
    expect(cypher).toContain('claim.assertedBy = $assertedBy');
    expect(cypher).toContain('collect(oldSubject) AS oldSubjects');
    expect(cypher).toContain('collect(oldObject) AS oldObjects');
    expect(cypher).toContain('collect(oldPredicate) AS oldPredicates');
    expect(cypher).toContain('collect(oldAsserter) AS oldAsserters');
    expect(cypher).toContain('collect(oldEdge) AS projectionEdges');
  });

  it('preserves an existing curated status when the incoming event omits claimStatus', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-curated', status: 'curated' }, wasCreated: false }])
    );

    const result = await syncRelationAsAssertion({ ...baseInput, confidence: 20 });

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain("claim.status = coalesce($claimStatus, claim.status, 'proposed')");
    expect(params.claimStatus).toBeNull();
    expect(spies.materialize).toHaveBeenCalledWith('claim-curated', expect.any(Object));
    expect(result.materializationSkipped).not.toBe(true);
  });

  it('rejects the Assertion and every current projection in the same upsert transaction', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-rejected', status: 'rejected' }, wasCreated: false }])
    );

    const result = await syncRelationAsAssertion({ ...baseInput, claimStatus: 'rejected' });

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('collect(statusEdge) AS statusEdges');
    expect(cypher).toContain('edge.claimStatus = claim.status');
    expect(cypher).toContain("WHEN claim.status = 'rejected' THEN coalesce(edge.t_invalidated, $invalidatedAt)");
    expect(params.invalidatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(result.materializationSkipped).toBe(true);
  });

  it('distinguishes user vs agent asserter in the Cypher params', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-user' }, wasCreated: true }]));

    await syncRelationAsAssertion({ ...baseInput, assertedBy: 'user:u-42' });

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('(asserter:User {id: $assertedBy})');
    expect(params.asserterType).toBe('user');
    expect(params.assertedBy).toBe('user:u-42');
  });

  it("classifies 'ai:'-prefixed asserters as agents (Relation Write Contract gate applies)", async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-ai' }, wasCreated: true }]));

    await syncRelationAsAssertion({ ...baseInput, assertedBy: 'ai:assistant' });

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('(asserter:Agent {id: $assertedBy})');
    expect(params.asserterType).toBe('agent');
    expect(params.assertedBy).toBe('ai:assistant');
  });

  // --------------------------------------------------------------------------
  // B0 two-field confidence authority — the Assertion upsert.
  // --------------------------------------------------------------------------

  it('ON CREATE sets all three confidence fields on the Assertion node', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-b0-1' }, wasCreated: true }]));

    await syncRelationAsAssertion(baseInput);

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('claim.confidence = $confidence');
    expect(cypher).toContain('claim.assertedConfidence = $confidence');
    expect(cypher).toContain('claim.effectiveConfidence = $confidence');
  });

  it('ON MATCH refreshes assertedConfidence but only coalesces effectiveConfidence', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ claim: { id: 'claim-b0-2' }, wasCreated: false }]));

    await syncRelationAsAssertion(baseInput);

    const [cypher] = mockedWrite.mock.calls[0];
    const onMatchBlock = cypher.split('ON MATCH SET')[1];
    expect(onMatchBlock).toContain('claim.assertedConfidence = $confidence');
    expect(onMatchBlock).toContain('claim.effectiveConfidence = coalesce(claim.effectiveConfidence, $confidence)');
  });

  // --------------------------------------------------------------------------
  // Relation Write Contract materialization gate (shouldMaterializeAssertion):
  // machine assertions ('agent:'/'ai:') below confidence 75 keep the
  // :Assertion at 'proposed' with NO typed edge until a reviewer approves.
  // --------------------------------------------------------------------------

  it("does NOT materialize an edge for an 'ai:' assertion at confidence 60 (stays proposed)", async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-gated', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 60, assertedBy: 'ai:assistant' });

    expect(spies.materialize).not.toHaveBeenCalled();
    // No superseding edge is written, so prior triples must NOT be invalidated.
    expect(spies.invalidate).not.toHaveBeenCalled();
    // Result stays coherent: edgeType from the input predicate, no edge.
    expect(r).toMatchObject({
      claimId: 'claim-gated',
      edgeType: 'USES',
      edgeCreated: false,
      claimCreated: true,
      materializationSkipped: true,
    });
    // Evidence is still attached — the Assertion itself is fully recorded.
    expect(spies.addEvidence).toHaveBeenCalledTimes(1);
  });

  it('finalizes the source pair only after Evidence succeeds when the edge is withheld', async () => {
    mockedWrite
      .mockResolvedValueOnce(
        writeResult([{ claim: { id: 'claim-versioned-gated', relationId: baseInput.relationId }, wasCreated: true }])
      )
      .mockResolvedValueOnce(writeResult([{ updated: 1 }]));

    await syncRelationAsAssertion({
      ...baseInput,
      confidence: 60,
      assertedBy: 'ai:assistant',
      correlationId,
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    });

    expect(spies.addEvidence).toHaveBeenCalledTimes(1);
    expect(spies.materialize).not.toHaveBeenCalled();
    const [cypher, params] = mockedWrite.mock.calls[1];
    expect(cypher).toContain('SET claim.sourceCorrelationId = $sourceCorrelationId');
    expect(params).toMatchObject({
      claimId: 'claim-versioned-gated',
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    });
  });

  it("materializes the edge for an 'ai:' assertion at confidence 80", async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-ai-80', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 80, assertedBy: 'ai:assistant' });

    expect(spies.materialize).toHaveBeenCalledWith('claim-ai-80', expect.any(Object));
    expect(r.edgeCreated).toBe(true);
    expect(r.materializationSkipped).toBeUndefined();
  });

  it('materializes the edge for a user assertion regardless of confidence', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-user-low', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 10, assertedBy: 'user:claudio' });

    expect(spies.materialize).toHaveBeenCalledWith('claim-user-low', expect.any(Object));
    expect(r.edgeCreated).toBe(true);
  });

  // --------------------------------------------------------------------------
  // C3 — corroboration nudge hook: applied right after evidence accrual,
  // best-effort (never aborts the sync on failure).
  // --------------------------------------------------------------------------

  it('applies the corroboration nudge after evidence accrual and tolerates its failure', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-nudge', relationId: baseInput.relationId }, wasCreated: true }])
    );
    spies.nudge.mockRejectedValueOnce(new Error('neo4j unavailable'));

    const r = await syncRelationAsAssertion(baseInput);

    expect(spies.nudge).toHaveBeenCalledWith(baseInput.relationId);
    // The nudge failure must NOT abort the sync — Assertion + edge still land.
    expect(r.claimId).toBe('claim-nudge');
    expect(r.edgeCreated).toBe(true);
    expect(r.edgeType).toBe('USES');
  });

  it('first materialization with multi-source evidence lands the nudge on the NEW edge (materialize BEFORE nudge)', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-nudge-order', relationId: baseInput.relationId }, wasCreated: true }])
    );

    await syncRelationAsAssertion({
      ...baseInput,
      evidence: [
        { sourceType: 'signal', snippet: 'first source', sourceUrl: 'https://a.example' },
        { sourceType: 'document_chunk', snippet: 'second source', sourceUrl: 'https://b.example' },
      ],
    });

    // Order is load-bearing: the nudge's edge mirror can only land on an edge
    // that already exists. Pre-materialization nudging silently mirrored onto
    // zero edges (reviewed defect) — evidence accrues, edge materializes, THEN
    // the nudge derives from the full evidence set and lands on both.
    const addEvidenceOrder = spies.addEvidence.mock.invocationCallOrder[0];
    const materializeOrder = spies.materialize.mock.invocationCallOrder[0];
    const nudgeOrder = spies.nudge.mock.invocationCallOrder[0];
    expect(addEvidenceOrder).toBeLessThan(materializeOrder);
    expect(materializeOrder).toBeLessThan(nudgeOrder);
    expect(spies.nudge).toHaveBeenCalledTimes(1);
    expect(spies.nudge).toHaveBeenCalledWith(baseInput.relationId);
  });

  it('below-threshold path still nudges the assertion (no edge exists; the mirror is a harmless 0-row match)', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-nudge-gated', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 60, assertedBy: 'ai:assistant' });

    expect(spies.nudge).toHaveBeenCalledTimes(1);
    expect(spies.nudge).toHaveBeenCalledWith(baseInput.relationId);
    expect(r.materializationSkipped).toBe(true);
  });
});

// ============================================================================
// Increment 2 (C4) — reliability-aware gate opts. shouldMaterializeAssertion
// gains an OPTIONAL third arg: `confidence + (opts?.reliabilityBonus ?? 0) >=
// 75 || deriveAsserterType(assertedBy) !== 'agent'`. The Task 17 golden truth
// table (materialization-gate.golden.test.ts) calls with opts OMITTED and
// must stay green untouched — these are pure-function EXTENSION cases for
// the new opts-aware branch, added here per the C4 brief rather than to the
// frozen golden file.
// ============================================================================
describe('shouldMaterializeAssertion — reliability-aware gate opts (pure extension)', () => {
  it('materializes an agent assertion at confidence 70 with reliabilityBonus +10 (flag on)', () => {
    expect(shouldMaterializeAssertion(70, 'agent:linker', { reliabilityBonus: 10 })).toBe(true);
  });

  it('withholds at 70 with bonus 0 — baseline unchanged', () => {
    expect(shouldMaterializeAssertion(70, 'agent:linker', { reliabilityBonus: 0 })).toBe(false);
    // Omitted opts must behave identically (byte-identical baseline).
    expect(shouldMaterializeAssertion(70, 'agent:linker')).toBe(false);
  });

  it('a +5 bonus does not rescue confidence 69', () => {
    expect(shouldMaterializeAssertion(69, 'agent:linker', { reliabilityBonus: 5 })).toBe(false);
  });

  it('a negative bonus can push a borderline agent confidence below the gate', () => {
    expect(shouldMaterializeAssertion(75, 'agent:linker', { reliabilityBonus: -1 })).toBe(false);
  });

  it('human/system asserters still always materialize regardless of bonus', () => {
    expect(shouldMaterializeAssertion(0, 'user:claudio', { reliabilityBonus: -10 })).toBe(true);
  });
});

// ============================================================================
// Increment 2 (C4) — upstream resolution in syncRelationAsAssertion.
// resolveReliabilityBonus is a byte-identical no-op (bonus 0, no read call)
// unless ASSERTER_RELIABILITY_ENABLED is on; when on, a reliability-read
// failure still falls back to bonus 0 (never breaks the sync).
// ============================================================================
describe('syncRelationAsAssertion — reliability bonus resolution (Increment 2 upstream)', () => {
  let spies: ReturnType<typeof installOrchestrationSpies>;
  const savedFlag = process.env.ASSERTER_RELIABILITY_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    spies = installOrchestrationSpies();
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.ASSERTER_RELIABILITY_ENABLED;
    else process.env.ASSERTER_RELIABILITY_ENABLED = savedFlag;
  });

  it('flag off (default): never calls getAsserterReliability, below-threshold confidence stays skipped', async () => {
    delete process.env.ASSERTER_RELIABILITY_ENABLED;
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-flag-off', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 70, assertedBy: 'agent:linker' });

    expect(spies.getReliability).not.toHaveBeenCalled();
    expect(r.materializationSkipped).toBe(true);
    expect(spies.materialize).not.toHaveBeenCalled();
  });

  it('flag on: a strong track record (+10 bonus) rescues confidence 70 into materialization', async () => {
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    spies.getReliability.mockResolvedValueOnce({ approvedCount: 10, rejectedCount: 0, reliabilityBonus: 10 });
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-flag-on', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 70, assertedBy: 'agent:linker' });

    expect(spies.getReliability).toHaveBeenCalledWith('agent:linker');
    expect(r.materializationSkipped).toBeUndefined();
    expect(spies.materialize).toHaveBeenCalledWith('claim-flag-on', expect.any(Object));
  });

  it('flag on but reliability read rejects: falls back to bonus 0 (byte-identical baseline)', async () => {
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    spies.getReliability.mockRejectedValueOnce(new Error('neo4j unavailable'));
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-read-fail', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 70, assertedBy: 'agent:linker' });

    expect(r.materializationSkipped).toBe(true);
    expect(spies.materialize).not.toHaveBeenCalled();
  });

  it('flag on, human asserter: reliability is still resolved but is irrelevant to the always-materialize path', async () => {
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    spies.getReliability.mockResolvedValueOnce({ approvedCount: 0, rejectedCount: 10, reliabilityBonus: -10 });
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-user', relationId: baseInput.relationId }, wasCreated: true }])
    );

    const r = await syncRelationAsAssertion({ ...baseInput, confidence: 10, assertedBy: 'user:claudio' });

    expect(r.materializationSkipped).toBeUndefined();
    expect(spies.materialize).toHaveBeenCalledWith('claim-user', expect.any(Object));
  });
});

describe('deleteAssertionByRelationId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the number of Assertions removed (0 when none matched)', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ removed: 0 }]));
    expect(await deleteAssertionByRelationId('missing')).toBe(0);
  });

  it('deletes the Assertion, its Evidence and the materialized edge', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ removed: 1 }]));

    const n = await deleteAssertionByRelationId('rel-x');

    expect(n).toBe(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(params.relationId).toBe('rel-x');
    expect(cypher).toContain(':Assertion {relationId: $relationId}');
    expect(cypher).toContain(':SUPPORTED_BY');
    expect(cypher).toContain('claimId: claim.id');
    expect(cypher).toContain('DETACH DELETE claim');
  });
});

describe('syncRelationAsEdge (curated, no Assertion node)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Keep F1 a stubbed no-op — the direct-edge tests assert on the MERGE call.
    mockedInvalidate.mockReset().mockResolvedValue(0);
  });

  const base = {
    relationId: 'rel-1',
    subject: { id: 's1', type: 'technology', name: 'Src' },
    object: { id: 'o1', type: 'technology', name: 'Tgt' },
    predicate: 'USES',
    confidence: 90,
    assertedBy: 'user:admin',
    notes: 'curated note',
  };

  it('writes a typed edge directly with claimStatus=curated and no Assertion node', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    const r = await syncRelationAsEdge(base);
    expect(r.edgeType).toBe('USES');
    expect(r.edgeCreated).toBe(true);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain(':Entity {id: $subjectId}');
    expect(cypher).toContain('[r:`USES`');
    expect(cypher).toContain("claimStatus = 'curated'");
    expect(cypher).toContain('collect(oldEdge) WHERE');
    expect(cypher).toContain('FOREACH (edge IN obsoleteEdges | DELETE edge)');
    expect(cypher).toContain('tail(exactEdges)');
    expect(cypher).not.toContain(':Assertion');
    expect(cypher).not.toContain(':Claim');
    expect(params.relationId).toBe('rel-1');
    expect(params.confidence).toBe(90);
  });

  it('stamps one validated source version on a direct projection', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));

    await syncRelationAsEdge({
      ...base,
      correlationId,
      sourceCorrelationId: correlationId,
      sourceFingerprint,
    });

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(params.correlationId).toBe(correlationId);
    expect(params.sourceCorrelationId).toBe(correlationId);
    expect(params.sourceFingerprint).toBe(sourceFingerprint);
    expect(cypher).toContain('r.correlationId = $correlationId');
    expect(cypher).toContain('r.sourceCorrelationId = $sourceCorrelationId');
    expect(cypher).toContain('r.sourceFingerprint = $sourceFingerprint');
    expect(cypher).toContain('r.correlationId = coalesce($correlationId, r.correlationId)');
    expect(cypher).toContain(
      'r.sourceCorrelationId = coalesce($sourceCorrelationId, r.sourceCorrelationId)'
    );
    expect(cypher).toContain('r.sourceFingerprint = coalesce($sourceFingerprint, r.sourceFingerprint)');
  });

  it('rejects arbitrary correlation text before a direct graph write', async () => {
    await expect(syncRelationAsEdge({ ...base, correlationId: 'local operator notes' })).rejects.toThrow(
      /correlation ID/
    );
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('rejects an invalid source fingerprint before a direct graph write', async () => {
    await expect(
      syncRelationAsEdge({
        ...base,
        sourceCorrelationId: correlationId,
        sourceFingerprint: 'not-a-fingerprint',
      })
    ).rejects.toThrow(/source fingerprint/);
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('rejects an incomplete source version before a direct graph write', async () => {
    await expect(syncRelationAsEdge({ ...base, sourceFingerprint })).rejects.toThrow(
      /both correlation and fingerprint/
    );
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('refuses unsafe predicates to prevent Cypher injection', async () => {
    await expect(syncRelationAsEdge({ ...base, predicate: 'uses; DROP' })).rejects.toThrow(/[Ii]nvalid relation type/);
  });

  it('sets aiSuggested=false for user asserters and true for agent asserters', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    await syncRelationAsEdge({ ...base, assertedBy: 'agent:scout' });
    const params = mockedWrite.mock.calls[0][1];
    expect(params.aiSuggested).toBe(true);
  });

  it("sets aiSuggested=true for 'ai:'-prefixed asserters (machine asserter, not 'system')", async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    await syncRelationAsEdge({ ...base, assertedBy: 'ai:assistant' });
    const params = mockedWrite.mock.calls[0][1];
    expect(params.aiSuggested).toBe(true);
  });

  // --------------------------------------------------------------------------
  // B0 two-field confidence authority — the direct (Class A) edge twin.
  // --------------------------------------------------------------------------

  it('ON CREATE sets all three confidence fields on the direct edge', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    await syncRelationAsEdge(base);

    const [cypher] = mockedWrite.mock.calls[0];
    const edgeSection = cypher.slice(cypher.indexOf('MERGE (s)-[r:'));
    const onCreateBlock = edgeSection.split('ON CREATE SET')[1].split('ON MATCH SET')[0];
    expect(onCreateBlock).toContain('r.confidence = $confidence');
    expect(onCreateBlock).toContain('r.assertedConfidence = $confidence');
    expect(onCreateBlock).toContain('r.effectiveConfidence = $confidence');
  });

  it('ON MATCH refreshes assertedConfidence but only coalesces effectiveConfidence on the direct edge', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: false, edgeType: 'USES' }]));
    await syncRelationAsEdge(base);

    const [cypher] = mockedWrite.mock.calls[0];
    const onMatchBlock = cypher.split('ON MATCH SET')[1];
    expect(onMatchBlock).toContain('r.assertedConfidence = $confidence');
    expect(onMatchBlock).toContain('r.effectiveConfidence = coalesce(r.effectiveConfidence, $confidence)');
  });
});

// M4: Document nodes are created by the document sync handler WITHOUT the
// :Entity label. A bare `MERGE (o:Entity {id})` therefore never matches the
// real :Document node and creates a shadow duplicate. Document-typed
// endpoints must MERGE on :Document and add the :Entity label so identities
// converge on one node.
describe('document endpoints target :Document (M4 shadow-node fix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAddEvidence.mockResolvedValue({ evidence: { id: 'ev-1' }, created: true });
    mockedMaterialize.mockResolvedValue({ created: true, edgeType: 'EVIDENCES' });
  });

  const docObjectInput = {
    relationId: 'rel-doc-1',
    subject: { id: 'tech-1', type: 'technology', name: 'LangChain' },
    object: { id: 'doc-1', type: 'document', name: 'Whitepaper' },
    predicate: 'EVIDENCES',
    confidence: 95,
    assertedBy: 'user:admin',
    notes: 'primary source',
  };

  it('syncRelationAsEdge MERGEs a document object on :Document and adds the :Entity label', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'EVIDENCES' }]));
    await syncRelationAsEdge(docObjectInput);

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MERGE (o:Document {id: $objectId})');
    expect(cypher).toContain('SET o:Entity');
    expect(cypher).not.toContain('MERGE (o:Entity {id: $objectId})');
    // Non-document subject keeps the plain :Entity MERGE.
    expect(cypher).toContain('MERGE (s:Entity {id: $subjectId})');
  });

  it('syncRelationAsEdge MERGEs a document subject on :Document and adds the :Entity label', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'EVIDENCES' }]));
    await syncRelationAsEdge({
      ...docObjectInput,
      subject: { id: 'doc-2', type: 'document', name: 'Spec' },
      object: { id: 'tech-1', type: 'technology', name: 'LangChain' },
    });

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MERGE (s:Document {id: $subjectId})');
    expect(cypher).toContain('SET s:Entity');
    expect(cypher).not.toContain('MERGE (s:Entity {id: $subjectId})');
    expect(cypher).toContain('MERGE (o:Entity {id: $objectId})');
  });

  it('syncRelationAsAssertion (Class B) MERGEs document endpoints on :Document too', async () => {
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-doc-1', relationId: 'rel-doc-1' }, wasCreated: true }])
    );

    await syncRelationAsAssertion(docObjectInput);

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MERGE (object:Document {id: $objectId})');
    expect(cypher).toContain('SET object:Entity');
    expect(cypher).not.toContain('MERGE (object:Entity {id: $objectId})');
    expect(cypher).toContain('MERGE (subject:Entity {id: $subjectId})');
  });

  it('non-document endpoints are unchanged (no :Document MERGE)', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'EVIDENCES' }]));
    await syncRelationAsEdge({
      ...docObjectInput,
      object: { id: 'comp-1', type: 'company', name: 'Acme' },
    });

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).not.toContain(':Document');
  });
});

describe('F1 temporal-invalidation contract', () => {
  // Temporal-invalidation contract: invalidatePriorEdges must run BEFORE the
  // MERGE that materializes the new edge — both for Class A (curated direct
  // edge) and Class B (Assertion-backed). Tests pin the orchestration order
  // using mock.invocationCallOrder rather than relying on await sequencing.
  let spies: ReturnType<typeof installOrchestrationSpies>;

  beforeEach(() => {
    jest.clearAllMocks();
    spies = installOrchestrationSpies();
  });

  const classBInput = {
    relationId: 'rel-f1-b',
    subject: { id: 'tech-A', type: 'technology', name: 'A' },
    object: { id: 'tech-B', type: 'technology', name: 'B' },
    predicate: 'USES',
    confidence: 80,
    assertedBy: 'agent:linker',
    notes: 'A uses B',
  };

  const classAInput = {
    relationId: 'rel-f1-a',
    subject: { id: 'tech-A', type: 'technology', name: 'A' },
    object: { id: 'tech-B', type: 'technology', name: 'B' },
    predicate: 'USES',
    confidence: 90,
    assertedBy: 'user:admin',
    notes: 'curated note',
  };

  it('invalidates prior edges before MERGE for assertion-backed relations (Class B)', async () => {
    // Class B path: upsert (runWriteTransaction) → invalidate → materialize.
    // The MERGE-of-the-new-edge here is materializeAssertionAsEdge, which is
    // what F1 must precede.
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-f1-b', relationId: classBInput.relationId }, wasCreated: true }])
    );

    await syncRelationAsAssertion(classBInput);

    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(spies.materialize).toHaveBeenCalledTimes(1);

    const invalidateOrder = spies.invalidate.mock.invocationCallOrder[0];
    const materializeOrder = spies.materialize.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(materializeOrder);
  });

  it('invalidates prior edges before MERGE for curated relations (Class A)', async () => {
    // Class A path: invalidate → MERGE (runWriteTransaction). No upsert/materialize
    // calls intervene — runWriteTransaction here IS the new-edge MERGE.
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));

    await syncRelationAsEdge(classAInput);

    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledTimes(1);

    const invalidateOrder = spies.invalidate.mock.invocationCallOrder[0];
    const mergeOrder = mockedWrite.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(mergeOrder);
  });

  it('passes (subjectId, predicate, objectId, excludeRelationId) to invalidatePriorEdges', async () => {
    // Both Class A and Class B must pass the same arg shape so a future
    // invalidatePriorEdges signature change is caught here.
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-f1-args', relationId: classBInput.relationId }, wasCreated: true }])
    );
    await syncRelationAsAssertion(classBInput);

    expect(spies.invalidate).toHaveBeenCalledWith({
      subjectId: classBInput.subject.id,
      predicate: classBInput.predicate,
      objectId: classBInput.object.id,
      excludeRelationId: classBInput.relationId,
    });

    spies.invalidate.mockClear();
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    await syncRelationAsEdge(classAInput);

    expect(spies.invalidate).toHaveBeenCalledWith({
      subjectId: classAInput.subject.id,
      predicate: classAInput.predicate,
      objectId: classAInput.object.id,
      excludeRelationId: classAInput.relationId,
    });
  });

  it('threads sourceRelationType so invalidation is scoped to the original type (F134)', async () => {
    // Two distinct relation types can collapse to the same Neo4j predicate
    // (e.g. RELATED_TO). The source type must reach invalidatePriorEdges so a
    // sibling relation of a DIFFERENT type is not wrongly superseded.
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-srt', relationId: classBInput.relationId }, wasCreated: true }])
    );
    await syncRelationAsAssertion({ ...classBInput, sourceRelationType: 'mentions' });

    expect(spies.invalidate).toHaveBeenCalledWith(expect.objectContaining({ sourceRelationType: 'mentions' }));
    // ...and the materialized edge is stamped with it for future scoping.
    expect(spies.materialize).toHaveBeenCalledWith('claim-srt', { sourceRelationType: 'mentions' });

    spies.invalidate.mockClear();
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'RELATED_TO' }]));
    await syncRelationAsEdge({ ...classAInput, sourceRelationType: 'about' });

    expect(spies.invalidate).toHaveBeenCalledWith(expect.objectContaining({ sourceRelationType: 'about' }));
  });

  it('proceeds with MERGE when invalidation rejects (non-fatal contract)', async () => {
    // Pins the current contract: an invalidation rejection MUST NOT abort
    // the write. If a future refactor makes invalidation fail-loud, this
    // test will fail and force the change to be deliberate.
    spies.invalidate.mockRejectedValue(new Error('neo4j unavailable'));

    // Class B
    mockedWrite.mockResolvedValueOnce(
      writeResult([{ claim: { id: 'claim-f1-rej', relationId: classBInput.relationId }, wasCreated: true }])
    );
    const bResult = await syncRelationAsAssertion(classBInput);
    expect(bResult.claimId).toBe('claim-f1-rej');
    expect(spies.materialize).toHaveBeenCalledTimes(1);

    // Class A
    mockedWrite.mockResolvedValueOnce(writeResult([{ created: true, edgeType: 'USES' }]));
    const aResult = await syncRelationAsEdge(classAInput);
    expect(aResult.edgeCreated).toBe(true);
    expect(aResult.edgeType).toBe('USES');
  });
});

// ============================================================================
// CRIT-1 — Class B edges must survive their own re-materialization.
//
// NO spies on ../assertions or ../temporal-queries here: the real
// upsert → invalidatePriorEdges → materializeAssertionAsEdge code runs against
// an in-memory graph simulation living behind the mocked neo4j-client. The
// simulation interprets exactly what the generated Cypher SAYS (invalidation
// exclusion by relationId; ON CREATE r = $properties; ON MATCH only the
// clauses the query actually contains), so a wrong query fails the test the
// same way it corrupts the live graph.
// ============================================================================

describe('CRIT-1 — relationId stamping & no self-invalidation (real assertions + temporal-queries)', () => {
  interface SimEdge {
    subjectId: string;
    objectId: string;
    edgeType: string;
    [prop: string]: unknown;
  }

  let assertionsByRelationId: Map<string, Record<string, unknown>>;
  let assertionsById: Map<string, Record<string, unknown>>;
  let edges: SimEdge[];

  const crit1Input = {
    relationId: 'rel-crit1',
    subject: { id: 'tech-A', type: 'technology', name: 'A' },
    object: { id: 'tech-B', type: 'technology', name: 'B' },
    predicate: 'USES',
    confidence: 88,
    assertedBy: 'agent:linker',
    notes: 'A uses B',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    installRealImplementations();
    assertionsByRelationId = new Map();
    assertionsById = new Map();
    edges = [];

    mockedRead.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('MATCH (claim:Assertion {id: $id})')) {
        const claim = assertionsById.get(params.id as string);
        return writeResult(claim ? [{ claim }] : []);
      }
      throw new Error(`CRIT-1 sim: unexpected read query: ${cypher}`);
    });

    mockedWrite.mockImplementation(async (cypher: string, params: Record<string, unknown>) => {
      // --- upsertAssertionByRelationId ---
      if (cypher.includes('MERGE (claim:Assertion {relationId: $relationId})')) {
        const relationId = params.relationId as string;
        let claim = assertionsByRelationId.get(relationId);
        const wasCreated = !claim;
        if (!claim) {
          claim = {
            id: params.assertionId,
            relationId,
            statement: params.statement,
            confidence: params.confidence,
            status: 'proposed',
            subjectId: params.subjectId,
            subjectType: params.subjectType,
            subjectName: params.subjectName,
            objectId: params.objectId,
            objectType: params.objectType,
            objectName: params.objectName,
            predicate: params.predicate,
            assertedBy: params.assertedBy,
            asserterType: params.asserterType,
            createdAt: params.now,
            updatedAt: params.now,
          };
          assertionsByRelationId.set(relationId, claim);
          assertionsById.set(claim.id as string, claim);
        } else {
          Object.assign(claim, { confidence: params.confidence, updatedAt: params.now });
        }
        return writeResult([{ claim, wasCreated }]);
      }

      // --- addEvidenceToAssertion ---
      if (cypher.includes(':Evidence {assertionId:')) {
        return writeResult([{ evidence: { id: params.evidenceId }, wasCreated: true }]);
      }

      // --- invalidatePriorEdges (F1) ---
      if (cypher.includes('SET r.t_invalidated = toString(datetime())') && cypher.includes('$excludeRelationId')) {
        let n = 0;
        for (const e of edges) {
          if (
            e.subjectId === params.subjectId &&
            e.objectId === params.objectId &&
            e.edgeType === params.predicate &&
            (e.t_invalidated === null || e.t_invalidated === undefined) &&
            ((e.relationId as string) ?? '') !== params.excludeRelationId
          ) {
            e.t_invalidated = '2026-07-03T00:00:00Z';
            n++;
          }
        }
        return writeResult([{ n }]);
      }

      // --- materializeAssertionAsEdge ---
      if (cypher.includes('{claimId: $assertionId}')) {
        const edgeType = /\[r:`([A-Z_]+)`/.exec(cypher)?.[1] ?? 'RELATED_TO';
        const properties = params.properties as Record<string, unknown>;
        const existing = edges.find((e) => e.claimId === params.assertionId);
        if (!existing) {
          edges.push({
            subjectId: params.subjectId as string,
            objectId: params.objectId as string,
            edgeType,
            ...properties,
          });
          return writeResult([{ created: true, edgeType }]);
        }
        // Interpret the ON MATCH SET clause literally — only apply what the
        // query actually contains.
        const onMatch = cypher.split('ON MATCH SET')[1] ?? '';
        existing.confidence = properties.confidence;
        existing.claimStatus = properties.claimStatus;
        existing.t_valid = properties.t_valid;
        if (onMatch.includes('r.t_invalidated = null')) {
          existing.t_invalidated = null;
        }
        if (onMatch.includes('r.relationId = $properties.relationId')) {
          existing.relationId = properties.relationId;
        }
        return writeResult([{ created: false, edgeType }]);
      }

      throw new Error(`CRIT-1 sim: unexpected write query: ${cypher}`);
    });
  });

  it('materializes the Class B typed edge with relationId === the Firestore relation id', async () => {
    const r = await syncRelationAsAssertion(crit1Input);

    expect(r.edgeCreated).toBe(true);
    expect(edges).toHaveLength(1);
    // The invalidation self-exclusion matches on relationId — a random
    // relationId here means the edge invalidates ITSELF on every re-sync.
    expect(edges[0].relationId).toBe('rel-crit1');
    expect(edges[0].claimId).toBe(r.claimId);
  });

  it('re-syncing the SAME relation id leaves the edge live (no self-invalidation)', async () => {
    await syncRelationAsAssertion(crit1Input);
    const second = await syncRelationAsAssertion({ ...crit1Input, confidence: 92 });

    expect(second.edgeCreated).toBe(false); // re-materialization, not a duplicate
    expect(edges).toHaveLength(1);
    expect(edges[0].t_invalidated ?? null).toBeNull();
    expect(edges[0].confidence).toBe(92);
  });

  it('still invalidates a DIFFERENT prior relation for the same triple (F1 preserved)', async () => {
    await syncRelationAsAssertion({ ...crit1Input, relationId: 'rel-old' });
    await syncRelationAsAssertion({ ...crit1Input, relationId: 'rel-new' });

    expect(edges).toHaveLength(2);
    const oldEdge = edges.find((e) => e.relationId === 'rel-old');
    const newEdge = edges.find((e) => e.relationId === 'rel-new');
    expect(oldEdge?.t_invalidated).toBeTruthy();
    expect(newEdge?.t_invalidated ?? null).toBeNull();
  });
});
