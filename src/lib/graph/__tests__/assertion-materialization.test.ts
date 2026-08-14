/**
 * @file assertion-materialization.test.ts
 * @description Unit tests for materializeAssertionAsEdge.
 *
 * Verifies that an approved Assertion produces a typed edge between subject
 * and object with full provenance metadata and a claimId back-pointer.
 */

import type { GraphAssertion } from '../types';

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

import * as neo4jClient from '../neo4j-client';
import { materializeAssertionAsEdge } from '../assertions';

const mockedWrite = neo4jClient.runWriteTransaction as jest.Mock;
const mockedRead = neo4jClient.runReadTransaction as jest.Mock;

function makeAssertion(overrides: Partial<GraphAssertion> = {}): GraphAssertion {
  return {
    id: 'claim-abc',
    statement: 'TestTech addresses TestUseCase',
    confidence: 82,
    status: 'proposed',
    subjectId: 'tech-1',
    subjectType: 'technology',
    subjectName: 'TestTech',
    objectId: 'uc-1',
    objectType: 'useCase',
    objectName: 'TestUseCase',
    predicate: 'ADDRESSES',
    assertedBy: 'agent:scout',
    asserterType: 'agent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as GraphAssertion;
}

describe('materializeAssertionAsEdge', () => {
  const correlationId = 'corr_00000000-0000-4000-8000-000000000001';
  const sourceFingerprint = 'a'.repeat(64);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when assertion does not exist', async () => {
    mockedRead.mockResolvedValue({ records: [] });
    const result = await materializeAssertionAsEdge('missing-claim');
    expect(result).toBeNull();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('returns early for an assertion already known to be rejected', async () => {
    const claim = makeAssertion({ status: 'rejected' });
    mockedRead.mockResolvedValue({ records: [{ claim }] });

    await expect(materializeAssertionAsEdge(claim.id)).resolves.toBeNull();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('refuses a concurrent rejection under the same write lock', async () => {
    const proposed = makeAssertion({ status: 'proposed' });
    const rejected = makeAssertion({ status: 'rejected' });
    mockedRead.mockResolvedValueOnce({ records: [{ claim: proposed }] }).mockResolvedValueOnce({ records: [{ claim: rejected }] });
    mockedWrite.mockResolvedValue({ records: [] });

    await expect(materializeAssertionAsEdge(proposed.id)).resolves.toBeNull();

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('SET claim.updatedAt = claim.updatedAt');
    expect(cypher).toContain("coalesce(claim.status, 'proposed') <> 'rejected'");
    expect(cypher).toContain('claim.subjectId = $subjectId');
    expect(cypher).toContain('claim.objectId = $objectId');
    expect(cypher).toContain('claim.predicate = $predicate');
  });

  it('retries from a fresh assertion after a concurrent topology rewrite', async () => {
    const oldSnapshot = makeAssertion({ subjectId: 'old-source', objectId: 'old-target', predicate: 'USES' });
    const freshSnapshot = makeAssertion({ subjectId: 'new-source', objectId: 'new-target', predicate: 'SUPPORTS' });
    mockedRead
      .mockResolvedValueOnce({ records: [{ claim: oldSnapshot }] })
      .mockResolvedValueOnce({ records: [{ claim: freshSnapshot }] });
    mockedWrite
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ created: true, edgeType: 'SUPPORTS' }] });

    await expect(materializeAssertionAsEdge(oldSnapshot.id)).resolves.toEqual({ created: true, edgeType: 'SUPPORTS' });

    expect(mockedWrite).toHaveBeenCalledTimes(2);
    expect(mockedWrite.mock.calls[0][1]).toMatchObject({
      subjectId: 'old-source',
      objectId: 'old-target',
      predicate: 'USES',
    });
    expect(mockedWrite.mock.calls[1][0]).toContain('`SUPPORTS`');
    expect(mockedWrite.mock.calls[1][1]).toMatchObject({
      subjectId: 'new-source',
      objectId: 'new-target',
      predicate: 'SUPPORTS',
    });
  });

  it('writes a typed edge named after the assertion predicate with claimId back-pointer', async () => {
    const claim = makeAssertion({ predicate: 'ADDRESSES' });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: true, edgeType: 'ADDRESSES' }],
    });

    const result = await materializeAssertionAsEdge(claim.id);

    expect(result).toEqual({ created: true, edgeType: 'ADDRESSES' });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];

    // Edge type comes from predicate, claimId is the MERGE key
    expect(cypher).toContain('`ADDRESSES`');
    expect(cypher).toContain('claimId: $assertionId');
    expect(cypher).toContain('tail(exactEdges)');
    expect(params.assertionId).toBe(claim.id);
    expect(params.subjectId).toBe(claim.subjectId);
    expect(params.objectId).toBe(claim.objectId);
  });

  it('stamps the validated source version on create and refreshes it on replay', async () => {
    const claim = makeAssertion();
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({ records: [{ created: true, edgeType: 'ADDRESSES' }] });

    await materializeAssertionAsEdge(claim.id, {
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
    expect(cypher).toContain(
      'claim.sourceCorrelationId = coalesce($sourceCorrelationId, claim.sourceCorrelationId)'
    );
    expect(cypher).toContain(
      'claim.sourceFingerprint = coalesce($sourceFingerprint, claim.sourceFingerprint)'
    );
  });

  it('inherits a validated source pair when a withheld Relation edge is materialized later', async () => {
    const claim = makeAssertion({ sourceCorrelationId: correlationId, sourceFingerprint });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({ records: [{ created: true, edgeType: 'ADDRESSES' }] });

    await materializeAssertionAsEdge(claim.id);

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(params).toMatchObject({
      sourceCorrelationId: correlationId,
      sourceFingerprint,
      snapshotSourceCorrelationId: correlationId,
      snapshotSourceFingerprint: sourceFingerprint,
    });
    expect(cypher).toContain("coalesce(claim.sourceCorrelationId, '')");
    expect(cypher).toContain("coalesce(claim.sourceFingerprint, '')");
  });

  it('rejects arbitrary correlation text before reading or writing the graph', async () => {
    await expect(materializeAssertionAsEdge('claim-abc', { correlationId: 'customer-secret' })).rejects.toThrow(
      /correlation ID/
    );
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('rejects a malformed source fingerprint before reading or writing the graph', async () => {
    await expect(
      materializeAssertionAsEdge('claim-abc', {
        sourceCorrelationId: correlationId,
        sourceFingerprint: 'private-source-text',
      })
    ).rejects.toThrow(/source fingerprint/);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('rejects an incomplete source version before reading or writing the graph', async () => {
    await expect(
      materializeAssertionAsEdge('claim-abc', { sourceFingerprint })
    ).rejects.toThrow(/both fields/);
    expect(mockedRead).not.toHaveBeenCalled();
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('propagates the assertion confidence to the edge properties', async () => {
    const claim = makeAssertion({ confidence: 92 });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: true, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const params = mockedWrite.mock.calls[0][1];
    expect(params.properties.confidence).toBe(92);
    expect(params.properties.claimId).toBe(claim.id);
    expect(params.properties.t_observed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('marks agent-asserted assertions with aiSuggested=true and proposed status', async () => {
    const claim = makeAssertion({ asserterType: 'agent' });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: true, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const params = mockedWrite.mock.calls[0][1];
    expect(params.properties.aiSuggested).toBe(true);
    expect(params.properties.claimStatus).toBe('proposed');
  });

  it('preserves the actual assertion status for user projections', async () => {
    const claim = makeAssertion({ asserterType: 'user', assertedBy: 'user:abc' });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: false, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const params = mockedWrite.mock.calls[0][1];
    expect(params.properties.aiSuggested).toBe(false);
    expect(params.properties.claimStatus).toBe('proposed');
  });

  it('carries an explicitly curated assertion status', async () => {
    const claim = makeAssertion({ status: 'curated', asserterType: 'user', assertedBy: 'user:abc' });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({ records: [{ created: true, edgeType: 'ADDRESSES' }] });

    await materializeAssertionAsEdge(claim.id);

    expect(mockedWrite.mock.calls[0][1].properties.claimStatus).toBe('curated');
    expect(mockedWrite.mock.calls[0][1].snapshotStatus).toBe('curated');
  });

  // --------------------------------------------------------------------------
  // B0 two-field confidence authority
  // --------------------------------------------------------------------------

  it('ON CREATE mints assertedConfidence and effectiveConfidence equal to the mint-source confidence', async () => {
    const claim = makeAssertion({ confidence: 88 });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: true, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const params = mockedWrite.mock.calls[0][1];
    expect(params.properties.assertedConfidence).toBe(88);
    expect(params.properties.effectiveConfidence).toBe(88);
  });

  it('ON MATCH never overwrites an existing effectiveConfidence (coalesce)', async () => {
    const claim = makeAssertion({ confidence: 92 });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: false, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const [cypher] = mockedWrite.mock.calls[0];
    const onMatchBlock = cypher.split('ON MATCH SET')[1];
    expect(onMatchBlock).toContain('r.assertedConfidence = $properties.assertedConfidence');
    expect(onMatchBlock).toContain(
      'r.effectiveConfidence = coalesce(r.effectiveConfidence, $properties.effectiveConfidence)'
    );
  });

  it('materializes using assertedConfidence over a stale legacy confidence when both are present', async () => {
    const claim = makeAssertion({ confidence: 60, assertedConfidence: 90 });
    mockedRead.mockResolvedValue({ records: [{ claim }] });
    mockedWrite.mockResolvedValue({
      records: [{ created: true, edgeType: 'ADDRESSES' }],
    });

    await materializeAssertionAsEdge(claim.id);

    const params = mockedWrite.mock.calls[0][1];
    // Mint source is assertion.assertedConfidence ?? assertion.confidence — a
    // higher assertedConfidence wins over a not-yet-refreshed legacy value.
    expect(params.properties.confidence).toBe(90);
    expect(params.properties.assertedConfidence).toBe(90);
    expect(params.properties.effectiveConfidence).toBe(90);
  });
});
