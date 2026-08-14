/**
 * @file assertions.test.ts
 * @description Unit tests for the Neo4j Assertions service.
 *
 * Tests cover:
 * - CRUD operations for assertions
 * - Evidence management
 * - Connection explanations
 * - Query operations
 * - Bulk operations
 *
 * @phase Phase 4: Relations-as-Assertions (formerly Relations-as-Claims)
 */

import type { CreateAssertionInput, GraphAssertion, GraphEvidence } from '../types';

// Mock must be defined before imports, and use factory function
jest.mock('../neo4j-client', () => {
  return {
    __esModule: true,
    runQuery: jest.fn(),
    runWriteTransaction: jest.fn(),
    runReadTransaction: jest.fn(),
  };
});

// Import after mock
import neo4j from 'neo4j-driver';
import * as neo4jClient from '../neo4j-client';

// Get references to the mocked functions
const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// Import assertions module AFTER mocking
import {
  createAssertion,
  getAssertion,
  getAssertionWithEvidence,
  getAssertionsForEntity,
  getAssertionsBetweenEntities,
  updateAssertionStatus,
  updateAssertionConfidence,
  deleteAssertion,
  addEvidenceToAssertion,
  getEvidenceForAssertion,
  removeEvidence,
  explainConnection,
  getAssertionsCitingDocument,
  getAssertionsByStatus,
  getAssertionsByAsserter,
  getHighConfidenceAssertions,
  getAssertionsByPredicate,
  getAssertionStats,
  syncEntity,
  deleteEntityFromGraph,
  bulkCreateAssertions,
  bulkApproveAssertions,
  bulkRejectAssertions,
  shouldMaterializeAssertion,
} from '../assertions';

// ============================================================================
// TEST DATA HELPERS
// ============================================================================

function createMockAssertionInput(overrides: Partial<CreateAssertionInput> = {}): CreateAssertionInput {
  return {
    subject: {
      id: 'tech-123',
      type: 'technology',
      name: 'TensorFlow',
    },
    object: {
      id: 'uc-456',
      type: 'useCase',
      name: 'Machine Learning Pipeline',
    },
    predicate: 'ADDRESSES',
    confidence: 85,
    assertedBy: 'agent:scout',
    ...overrides,
  };
}

function createMockAssertion(overrides: Partial<GraphAssertion> = {}): GraphAssertion {
  return {
    id: 'claim-123',
    statement: 'TensorFlow addresses Machine Learning Pipeline',
    confidence: 85,
    status: 'proposed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    subjectId: 'tech-123',
    subjectType: 'technology',
    subjectName: 'TensorFlow',
    objectId: 'uc-456',
    objectType: 'useCase',
    objectName: 'Machine Learning Pipeline',
    predicate: 'ADDRESSES',
    assertedBy: 'agent:scout',
    asserterType: 'agent',
    ...overrides,
  };
}

function createMockEvidence(overrides: Partial<GraphEvidence> = {}): GraphEvidence {
  return {
    id: 'evidence-123',
    sourceType: 'document_chunk',
    snippet: 'TensorFlow is widely used for ML pipelines...',
    capturedAt: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// ASSERTION CRUD OPERATIONS
// ============================================================================

describe('Assertions Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createAssertion', () => {
    it('should create an assertion with agent asserter', async () => {
      const input = createMockAssertionInput();

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion() }],
      });

      const result = await createAssertion(input);

      expect(result).toBeDefined();
      expect(result.subjectId).toBe('tech-123');
      expect(result.objectId).toBe('uc-456');
      expect(result.predicate).toBe('ADDRESSES');
      expect(result.confidence).toBe(85);
      expect(result.asserterType).toBe('agent');
      expect(result.status).toBe('proposed');
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it('should create an assertion with user asserter', async () => {
      const input = createMockAssertionInput({
        assertedBy: 'user:user-abc123',
      });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ assertedBy: 'user:user-abc123', asserterType: 'user' }) }],
      });

      const result = await createAssertion(input);

      expect(result.asserterType).toBe('user');
      expect(result.assertedBy).toBe('user:user-abc123');
    });

    it("should derive asserterType 'agent' from an 'ai:' prefix (AI assistant claims)", async () => {
      // The live AI-assistant sender (ai/tools/assertions-tools.ts) uses
      // assertedBy: 'ai:assistant'. It MUST classify as 'agent' so the
      // Relation Write Contract confidence gate applies (claims < 75 stay
      // 'proposed' instead of materializing a typed edge).
      const input = createMockAssertionInput({
        assertedBy: 'ai:assistant',
      });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ assertedBy: 'ai:assistant', asserterType: 'agent' }) }],
      });

      const result = await createAssertion(input);

      expect(result.asserterType).toBe('agent');
      // The Cypher params must also carry the derived type so the asserter
      // node gets the :Agent label, not :User.
      expect(mockedWriteTransaction.mock.calls[0][1]).toMatchObject({
        assertedBy: 'ai:assistant',
        asserterType: 'agent',
      });
    });

    it("should derive asserterType 'agent' from an 'agent:' prefix", async () => {
      const input = createMockAssertionInput({
        assertedBy: 'agent:linker',
      });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ assertedBy: 'agent:linker', asserterType: 'agent' }) }],
      });

      const result = await createAssertion(input);

      expect(result.asserterType).toBe('agent');
      expect(mockedWriteTransaction.mock.calls[0][1]).toMatchObject({ asserterType: 'agent' });
    });

    it('should generate statement if not provided', async () => {
      const input = createMockAssertionInput();

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion() }],
      });

      const result = await createAssertion(input);

      expect(result.statement).toBe('TensorFlow addresses Machine Learning Pipeline');
    });

    it('should use provided statement', async () => {
      const customStatement = 'Custom statement about the relationship';
      const input = createMockAssertionInput({ statement: customStatement });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ statement: customStatement }) }],
      });

      const result = await createAssertion(input);

      expect(result.statement).toBe(customStatement);
    });

    it('should add evidence when provided', async () => {
      const input = createMockAssertionInput({
        evidence: [
          {
            sourceType: 'document_chunk',
            snippet: 'Evidence snippet...',
          },
        ],
      });

      mockedWriteTransaction
        .mockResolvedValueOnce({ records: [{ claim: createMockAssertion() }] })
        .mockResolvedValueOnce({ records: [{ evidence: createMockEvidence(), wasCreated: true }] });

      await createAssertion(input);

      // Once for assertion creation, once for evidence
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
    });

    it('should include reasoning summary when provided', async () => {
      const input = createMockAssertionInput({
        reasoningSummary: 'Based on API documentation analysis',
      });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ reasoningSummary: 'Based on API documentation analysis' }) }],
      });

      const result = await createAssertion(input);

      expect(result.reasoningSummary).toBe('Based on API documentation analysis');
    });

    it('mints assertedConfidence and effectiveConfidence equal to the input confidence (B0)', async () => {
      const input = createMockAssertionInput({ confidence: 85 });

      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion() }],
      });

      const result = await createAssertion(input);

      expect(result.assertedConfidence).toBe(85);
      expect(result.effectiveConfidence).toBe(85);
      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('assertedConfidence: $confidence');
      expect(cypher).toContain('effectiveConfidence: $confidence');
    });
  });

  describe('getAssertion', () => {
    it('should return an assertion by ID', async () => {
      const mockAssertion = createMockAssertion();
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: mockAssertion }],
      });

      const result = await getAssertion('claim-123');

      expect(result).toEqual(mockAssertion);
      expect(mockedReadTransaction).toHaveBeenCalledWith(expect.stringContaining('MATCH (claim:Assertion {id: $id})'), {
        id: 'claim-123',
      });
    });

    it('should return null if assertion not found', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [],
      });

      const result = await getAssertion('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getAssertionWithEvidence', () => {
    it('should return assertion with its evidence', async () => {
      const mockAssertion = createMockAssertion();
      const mockEvidenceList = [createMockEvidence()];

      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: mockAssertion, evidence: mockEvidenceList }],
      });

      const result = await getAssertionWithEvidence('claim-123');

      expect(result).toBeDefined();
      expect(result?.claim).toEqual(mockAssertion);
      expect(result?.evidence).toHaveLength(1);
    });

    it('should return null if assertion not found', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: null, evidence: [] }],
      });

      const result = await getAssertionWithEvidence('nonexistent');

      expect(result).toBeNull();
    });

    it('should filter out null evidence', async () => {
      const mockAssertion = createMockAssertion();

      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: mockAssertion, evidence: [createMockEvidence(), null, null] }],
      });

      const result = await getAssertionWithEvidence('claim-123');

      expect(result?.evidence).toHaveLength(1);
    });
  });

  describe('getAssertionsForEntity', () => {
    it('should return assertions where entity is subject or object', async () => {
      const claimAsSubject = createMockAssertion({ id: 'claim-as-subject' });
      const claimAsObject = createMockAssertion({ id: 'claim-as-object' });

      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ asSubject: [claimAsSubject], asObject: [claimAsObject] }],
      });

      const result = await getAssertionsForEntity('tech-123');

      expect(result.asSubject).toHaveLength(1);
      expect(result.asObject).toHaveLength(1);
      expect(result.totalCount).toBe(2);
    });

    it('should handle entity with no assertions', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ asSubject: [], asObject: [] }],
      });

      const result = await getAssertionsForEntity('new-entity');

      expect(result.asSubject).toHaveLength(0);
      expect(result.asObject).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should filter out null assertions', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ asSubject: [createMockAssertion(), null], asObject: [null] }],
      });

      const result = await getAssertionsForEntity('tech-123');

      expect(result.asSubject).toHaveLength(1);
      expect(result.asObject).toHaveLength(0);
      expect(result.totalCount).toBe(1);
    });
  });

  describe('getAssertionsBetweenEntities', () => {
    it('should return assertions connecting two entities', async () => {
      const claims = [createMockAssertion({ id: 'claim-1' }), createMockAssertion({ id: 'claim-2' })];

      mockedReadTransaction.mockResolvedValueOnce({
        records: claims.map((claim) => ({ claim })),
      });

      const result = await getAssertionsBetweenEntities('tech-123', 'uc-456');

      expect(result).toHaveLength(2);
    });

    it('orders by COALESCE(claim.effectiveConfidence, claim.confidence) (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await getAssertionsBetweenEntities('tech-123', 'uc-456');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain(
        'ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC'
      );
    });

    it('should return empty array if no assertions exist', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [],
      });

      const result = await getAssertionsBetweenEntities('entity-a', 'entity-b');

      expect(result).toHaveLength(0);
    });
  });

  describe('updateAssertionStatus', () => {
    it('should update assertion status to curated', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ status: 'curated' }) }],
      });

      await updateAssertionStatus('claim-123', 'curated');

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('SET claim.status = $status'),
        expect.objectContaining({ id: 'claim-123', status: 'curated' })
      );
    });

    it('should update assertion status to rejected', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ status: 'rejected' }) }],
      });

      await updateAssertionStatus('claim-123', 'rejected');

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('SET claim.status = $status'),
        expect.objectContaining({ id: 'claim-123', status: 'rejected' })
      );

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('OPTIONAL MATCH ()-[edge {claimId: $id}]->()');
      expect(cypher).toContain('coalesce(r.t_invalidated, $invalidatedAt)');
      expect(cypher).toContain('r.claimStatus = $status');
      expect(params.invalidatedAt).toEqual(expect.any(String));
    });

    it('should set lastVerifiedAt when verifiedBy provided', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ status: 'curated' }) }],
      });

      await updateAssertionStatus('claim-123', 'curated', 'user:abc123');

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('lastVerifiedAt'),
        expect.any(Object)
      );
    });
  });

  describe('updateAssertionConfidence', () => {
    it('should update assertion confidence', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ confidence: 95 }) }],
      });

      await updateAssertionConfidence('claim-123', 95);

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('SET claim.confidence = $confidence'),
        expect.objectContaining({ id: 'claim-123', confidence: 95 })
      );
    });

    it('refreshes assertedConfidence but only coalesces effectiveConfidence (B0)', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ confidence: 95 }) }],
      });

      await updateAssertionConfidence('claim-123', 95);

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('claim.assertedConfidence = $confidence');
      expect(cypher).toContain('claim.effectiveConfidence = coalesce(claim.effectiveConfidence, $confidence)');
      expect(params).toMatchObject({ id: 'claim-123', confidence: 95 });
    });
  });

  describe('deleteAssertion', () => {
    it('deletes the assertion, evidence, and every claimId projection atomically', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await deleteAssertion('claim-123');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('OPTIONAL MATCH ()-[projection {claimId: $id}]->()');
      expect(cypher).toContain('FOREACH (edge IN projectionEdges | DELETE edge)');
      expect(cypher).toContain('DETACH DELETE evidence');
      expect(cypher).toContain('DETACH DELETE assertion');
      expect(params).toEqual({ id: 'claim-123' });
    });
  });

  describe('shouldMaterializeAssertion (Relation Write Contract gate)', () => {
    it('materializes agent assertions at exactly the 75 boundary', () => {
      expect(shouldMaterializeAssertion(75, 'agent:scout')).toBe(true);
    });

    it('withholds agent assertions just below the 75 boundary', () => {
      expect(shouldMaterializeAssertion(74, 'agent:scout')).toBe(false);
    });

    it("treats 'ai:'-prefixed asserters as machine asserters (gate applies)", () => {
      expect(shouldMaterializeAssertion(60, 'ai:assistant')).toBe(false);
      expect(shouldMaterializeAssertion(80, 'ai:assistant')).toBe(true);
    });

    it("treats 'agent:'-prefixed asserters as machine asserters (gate applies)", () => {
      expect(shouldMaterializeAssertion(0, 'agent:linker')).toBe(false);
      expect(shouldMaterializeAssertion(100, 'agent:linker')).toBe(true);
    });

    it("always materializes 'user:'-prefixed asserters regardless of confidence", () => {
      expect(shouldMaterializeAssertion(0, 'user:claudio')).toBe(true);
      expect(shouldMaterializeAssertion(74, 'user:claudio')).toBe(true);
    });

    it('treats unprefixed asserters as human (no gate) — matches deriveAsserterType', () => {
      expect(shouldMaterializeAssertion(10, 'system')).toBe(true);
    });

    it('materializes a below-threshold agent assertion once human-curated (F105 release valve)', () => {
      // A human approving a sub-75 machine proposal stamps claimStatus:'curated';
      // the gate must release the withheld edge despite the agent asserter + low confidence.
      expect(shouldMaterializeAssertion(60, 'agent:linker', { claimStatus: 'curated' })).toBe(true);
      // Without the human decision it stays withheld.
      expect(shouldMaterializeAssertion(60, 'agent:linker', { claimStatus: 'proposed' })).toBe(false);
      expect(shouldMaterializeAssertion(60, 'agent:linker')).toBe(false);
    });

    it('never materializes a rejected claim, even high-confidence or human-asserted (F137)', () => {
      // A re-sync of a rejected relation must not resurrect the edge a reviewer killed.
      expect(shouldMaterializeAssertion(100, 'agent:linker', { claimStatus: 'rejected' })).toBe(false);
      expect(shouldMaterializeAssertion(100, 'user:claudio', { claimStatus: 'rejected' })).toBe(false);
    });
  });
});

// ============================================================================
// EVIDENCE OPERATIONS
// ============================================================================

describe('Evidence Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('addEvidenceToAssertion', () => {
    it('should add evidence to an assertion', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ evidence: createMockEvidence(), wasCreated: true }],
      });

      const result = await addEvidenceToAssertion('claim-123', {
        sourceType: 'document_chunk',
        snippet: 'Evidence text...',
      });

      expect(result).toBeDefined();
      expect(result.evidence.sourceType).toBe('document_chunk');
      expect(result.created).toBe(true);
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it('should include optional fields when provided', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [
          {
            evidence: createMockEvidence({
              sourceUrl: 'https://example.com',
              documentId: 'doc-123',
              pageNumber: 5,
              relevanceScore: 0.95,
            }),
            wasCreated: true,
          },
        ],
      });

      const result = await addEvidenceToAssertion('claim-123', {
        sourceType: 'web_ref',
        snippet: 'Web content...',
        sourceUrl: 'https://example.com',
        documentId: 'doc-123',
        pageNumber: 5,
        relevanceScore: 0.95,
      });

      expect(result.evidence.sourceUrl).toBe('https://example.com');
      expect(result.evidence.documentId).toBe('doc-123');
    });

    it('should return constructed evidence if record is missing', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [],
      });

      const result = await addEvidenceToAssertion('claim-123', {
        sourceType: 'signal',
        snippet: 'Signal content...',
        signalId: 'signal-456',
      });

      expect(result).toBeDefined();
      expect(result.evidence.sourceType).toBe('signal');
      expect(result.evidence.signalId).toBe('signal-456');
      expect(result.created).toBe(true);
    });

    it('persists and returns entity_field coordinates without collapsing them into a user assertion', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      const result = await addEvidenceToAssertion('claim-entity-field', {
        sourceType: 'entity_field',
        snippet: 'First-party technology description',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      });

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('evidence.entityId = $entityId');
      expect(cypher).toContain('evidence.entityType = $entityType');
      expect(cypher).toContain('evidence.entityField = $entityField');
      expect(params).toMatchObject({
        sourceType: 'entity_field',
        sourceKey: 'entity:technology:tech-1:description',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      });
      expect(result.evidence).toMatchObject({
        sourceType: 'entity_field',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      });
    });

    it('MERGEs on (assertionId, sourceKey) instead of bare CREATE', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ evidence: createMockEvidence(), wasCreated: true }],
      });

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'document_chunk',
        snippet: 'Evidence text...',
        documentId: 'doc-123',
      });

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain(
        'MERGE (claim)-[:SUPPORTED_BY]->(evidence:Evidence {assertionId: $assertionId, sourceKey: $sourceKey})'
      );
      expect(cypher).not.toContain('CREATE (evidence:Evidence');
    });

    it('derives sourceKey with precedence sourceUrl > signalId > documentId > chunkId > entity field > sourceType', async () => {
      mockedWriteTransaction.mockResolvedValue({
        records: [{ evidence: createMockEvidence(), wasCreated: true }],
      });

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'web_ref',
        snippet: 's',
        sourceUrl: 'https://example.com/a',
        signalId: 'signal-1',
        documentId: 'doc-1',
        chunkId: 'chunk-1',
      });
      expect(mockedWriteTransaction.mock.calls[0][1].sourceKey).toBe('https://example.com/a');

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'signal',
        snippet: 's',
        signalId: 'signal-1',
        documentId: 'doc-1',
        chunkId: 'chunk-1',
      });
      expect(mockedWriteTransaction.mock.calls[1][1].sourceKey).toBe('signal-1');

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'document_chunk',
        snippet: 's',
        documentId: 'doc-1',
        chunkId: 'chunk-1',
      });
      expect(mockedWriteTransaction.mock.calls[2][1].sourceKey).toBe('doc-1');

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'document_chunk',
        snippet: 's',
        chunkId: 'chunk-1',
      });
      expect(mockedWriteTransaction.mock.calls[3][1].sourceKey).toBe('chunk-1');

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'entity_field',
        snippet: 's',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      });
      expect(mockedWriteTransaction.mock.calls[4][1].sourceKey).toBe('entity:technology:tech-1:description');

      await addEvidenceToAssertion('claim-123', {
        sourceType: 'user_assertion',
        snippet: 's',
      });
      expect(mockedWriteTransaction.mock.calls[5][1].sourceKey).toBe('user_assertion');
    });

    // GRAPH-070 — the last line before Neo4j. An unresolved grounding redirect
    // must never become a citable stored identity, or two redirects aliasing one
    // article become two :Evidence nodes and inflate the corroboration count.
    describe('unresolved grounding redirects (GRAPH-070)', () => {
      const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';

      beforeEach(() => {
        mockedWriteTransaction.mockResolvedValue({
          records: [{ evidence: createMockEvidence(), wasCreated: true }],
        });
      });

      it('collapses a redirect sourceUrl into the shared unresolved bucket', async () => {
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceUrl: `${REDIRECT}AUZIYQaaa`,
        });

        expect(mockedWriteTransaction.mock.calls[0][1].sourceKey).toBe('unresolved:google-grounding-redirect');
      });

      it('gives two distinct redirects the SAME sourceKey so they MERGE to one node', async () => {
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceUrl: `${REDIRECT}AUZIYQaaa`,
        });
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceUrl: `${REDIRECT}AUZIYQbbb`,
        });

        expect(mockedWriteTransaction.mock.calls[0][1].sourceKey).toBe(
          mockedWriteTransaction.mock.calls[1][1].sourceKey
        );
      });

      it('still stores the raw redirect as sourceUrl — consultation is preserved, citability is not', async () => {
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceUrl: `${REDIRECT}AUZIYQaaa`,
        });

        expect(mockedWriteTransaction.mock.calls[0][1].sourceUrl).toBe(`${REDIRECT}AUZIYQaaa`);
      });

      it('leaves a real publisher URL as its own sourceKey', async () => {
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceUrl: 'https://publisher.com/article',
        });

        expect(mockedWriteTransaction.mock.calls[0][1].sourceKey).toBe('https://publisher.com/article');
      });

      it('honours an explicit sourceKey over the redirect collapse', async () => {
        // Callers that already carry a stable per-ref key (relation sync passes
        // `ref.sourceKey ?? ref.id`) keep it; the collapse only governs the
        // sourceUrl fallback.
        await addEvidenceToAssertion('claim-123', {
          sourceType: 'web_ref',
          snippet: 's',
          sourceKey: 'ev-123',
          sourceUrl: `${REDIRECT}AUZIYQaaa`,
        });

        expect(mockedWriteTransaction.mock.calls[0][1].sourceKey).toBe('ev-123');
      });
    });

    it('returns created=false when the same source re-syncs', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [{ evidence: createMockEvidence(), wasCreated: false }],
      });

      const result = await addEvidenceToAssertion('claim-123', {
        sourceType: 'document_chunk',
        snippet: 'Evidence text...',
        documentId: 'doc-123',
      });

      expect(result.created).toBe(false);
    });
  });

  describe('getEvidenceForAssertion', () => {
    it('should return all evidence for an assertion', async () => {
      const evidenceList = [createMockEvidence({ id: 'ev-1' }), createMockEvidence({ id: 'ev-2' })];

      mockedReadTransaction.mockResolvedValueOnce({
        records: evidenceList.map((evidence) => ({ evidence })),
      });

      const result = await getEvidenceForAssertion('claim-123');

      expect(result).toHaveLength(2);
    });

    it('should return empty array if no evidence', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [],
      });

      const result = await getEvidenceForAssertion('claim-no-evidence');

      expect(result).toHaveLength(0);
    });
  });

  describe('removeEvidence', () => {
    it('should delete evidence by ID', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await removeEvidence('evidence-123');

      expect(mockedWriteTransaction).toHaveBeenCalledWith(expect.stringContaining('DETACH DELETE evidence'), {
        evidenceId: 'evidence-123',
      });
    });
  });
});

// ============================================================================
// CONNECTION EXPLANATION
// ============================================================================

describe('Connection Explanation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('explainConnection', () => {
    it('should return all connection explanations (Assertion-backed)', async () => {
      // Pass 1 (assertion): one hit
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            claim: createMockAssertion(),
            evidence: [createMockEvidence()],
            asserter: { id: 'agent:scout', name: 'scout' },
            relType: { name: 'ADDRESSES' },
          },
        ],
      });
      // Pass 2 (edge): empty — no plain edges for this pair
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      const result = await explainConnection('tech-123', 'uc-456');

      expect(result).toHaveLength(1);
      expect(result[0].claim).toBeDefined();
      expect(result[0].evidence).toHaveLength(1);
      expect(result[0].asserter).toBeDefined();
    });

    it('should filter out null evidence', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            claim: createMockAssertion(),
            evidence: [createMockEvidence(), null, null],
            asserter: { id: 'agent:scout', name: 'scout' },
            relType: { name: 'ADDRESSES' },
          },
        ],
      });
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      const result = await explainConnection('tech-123', 'uc-456');

      expect(result[0].evidence).toHaveLength(1);
    });

    it('should return empty array if no connections (no assertion, no edge)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      const result = await explainConnection('entity-a', 'entity-b');

      expect(result).toHaveLength(0);
    });

    it('falls back to edge properties when no :Assertion exists (F3 default path)', async () => {
      // Pass 1: no Assertion
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });
      // Pass 2: one plain typed edge
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            predicate: 'USES',
            relationId: 'rel-42',
            claimId: null,
            confidence: 90,
            claimStatus: 'curated',
            assertedBy: 'user:alice',
            notes: 'Primary tech stack',
            t_observed: '2026-04-18T10:00:00.000Z',
            t_valid: '2026-04-18T10:00:00.000Z',
            t_invalidated: null,
            subjectId: 'tech-1',
            subjectName: 'LangChain',
            subjectType: 'technology',
            objectId: 'tech-2',
            objectName: 'Claude API',
            objectType: 'technology',
          },
        ],
      });

      const result = await explainConnection('tech-1', 'tech-2');

      expect(result).toHaveLength(1);
      expect(result[0].claim.id).toBe('rel-42');
      expect(result[0].claim.predicate).toBe('USES');
      expect(result[0].claim.confidence).toBe(90);
      expect(result[0].claim.reasoningSummary).toBe('Primary tech stack');
      // No snippet Evidence on plain edges
      expect(result[0].evidence).toHaveLength(0);
      // Synthetic asserter built from the assertedBy property
      expect(result[0].asserter.id).toBe('user:alice');
    });

    it('deduplicates: an edge whose claimId matches an already-returned Assertion is skipped', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            claim: createMockAssertion({ id: 'claim-xyz' }),
            evidence: [createMockEvidence()],
            asserter: { id: 'agent:scout', name: 'scout' },
            relType: { name: 'USES' },
          },
        ],
      });
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            predicate: 'USES',
            relationId: 'rel-a',
            claimId: 'claim-xyz', // already covered by the assertion pass
            confidence: 80,
            claimStatus: 'proposed',
            assertedBy: 'agent:scout',
            notes: null,
            t_observed: null,
            t_valid: null,
            t_invalidated: null,
            subjectId: 's',
            subjectName: 'S',
            subjectType: 'technology',
            objectId: 'o',
            objectName: 'O',
            objectType: 'technology',
          },
        ],
      });

      const result = await explainConnection('s', 'o');
      expect(result).toHaveLength(1); // Only the Assertion, not the duplicate edge
      expect(result[0].claim.id).toBe('claim-xyz');
    });

    it('orders both passes by COALESCE(effectiveConfidence, confidence) and projects effectiveConfidence on the edge pass (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await explainConnection('tech-1', 'tech-2');

      const [assertionCypher] = mockedReadTransaction.mock.calls[0];
      const [edgeCypher] = mockedReadTransaction.mock.calls[1];
      expect(assertionCypher).toContain('ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC');
      expect(edgeCypher).toContain('r.effectiveConfidence AS effectiveConfidence');
      expect(edgeCypher).toContain('ORDER BY coalesce(r.effectiveConfidence, r.confidence) DESC');
    });

    it('the edge-backed fallback prefers effectiveConfidence over a stale legacy confidence, kept default 50 (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            predicate: 'USES',
            relationId: 'rel-eff',
            claimId: null,
            confidence: 60,
            effectiveConfidence: 95,
            claimStatus: 'curated',
            assertedBy: 'user:alice',
            notes: null,
            t_observed: null,
            t_valid: null,
            t_invalidated: null,
            subjectId: 'tech-1',
            subjectName: 'LangChain',
            subjectType: 'technology',
            objectId: 'tech-2',
            objectName: 'Claude API',
            objectType: 'technology',
          },
        ],
      });

      const result = await explainConnection('tech-1', 'tech-2');

      expect(result[0].claim.confidence).toBe(95);
    });

    it('falls back to 50 when neither effectiveConfidence nor confidence is present (site default kept)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            predicate: 'USES',
            relationId: 'rel-none',
            claimId: null,
            confidence: null,
            effectiveConfidence: null,
            claimStatus: 'curated',
            assertedBy: 'user:alice',
            notes: null,
            t_observed: null,
            t_valid: null,
            t_invalidated: null,
            subjectId: 'tech-1',
            subjectName: 'LangChain',
            subjectType: 'technology',
            objectId: 'tech-2',
            objectName: 'Claude API',
            objectType: 'technology',
          },
        ],
      });

      const result = await explainConnection('tech-1', 'tech-2');

      expect(result[0].claim.confidence).toBe(50);
    });

    it('the final merged sort prefers an Assertion-backed effectiveConfidence over a higher legacy edge confidence (B0)', async () => {
      // Assertion-backed hit: raw confidence=60 but effectiveConfidence=99 (a
      // recalibration bumped it) — the merged sort must respect the recalibrated value.
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            claim: createMockAssertion({ id: 'claim-low-raw', confidence: 60, effectiveConfidence: 99 }),
            evidence: [],
            asserter: { id: 'agent:scout', name: 'scout' },
            relType: { name: 'ADDRESSES' },
          },
        ],
      });
      // Plain edge with a higher legacy confidence but no effectiveConfidence override.
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          {
            predicate: 'USES',
            relationId: 'rel-mid',
            claimId: null,
            confidence: 80,
            effectiveConfidence: null,
            claimStatus: 'curated',
            assertedBy: 'user:bob',
            notes: null,
            t_observed: null,
            t_valid: null,
            t_invalidated: null,
            subjectId: 'tech-1',
            subjectName: 'A',
            subjectType: 'technology',
            objectId: 'tech-2',
            objectName: 'B',
            objectType: 'technology',
          },
        ],
      });

      const result = await explainConnection('tech-1', 'tech-2');

      expect(result).toHaveLength(2);
      expect(result[0].claim.id).toBe('claim-low-raw'); // 99 > 80 despite raw confidence 60 < 80
    });
  });

  describe('getAssertionsCitingDocument', () => {
    it('should return assertions citing a document', async () => {
      const claims = [createMockAssertion({ id: 'claim-1' }), createMockAssertion({ id: 'claim-2' })];

      mockedReadTransaction.mockResolvedValueOnce({
        records: claims.map((claim) => ({ claim })),
      });

      const result = await getAssertionsCitingDocument('doc-123');

      expect(result.documentId).toBe('doc-123');
      expect(result.claims).toHaveLength(2);
      expect(result.citationCount).toBe(2);
    });

    it('should return empty result if document has no citations', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [],
      });

      const result = await getAssertionsCitingDocument('doc-no-citations');

      expect(result.citationCount).toBe(0);
      expect(result.claims).toHaveLength(0);
    });
  });
});

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

describe('Query Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAssertionsByStatus', () => {
    it('should return assertions with specified status', async () => {
      const claims = [createMockAssertion({ status: 'proposed' })];

      mockedReadTransaction.mockResolvedValueOnce({
        records: claims.map((claim) => ({ claim })),
      });

      const result = await getAssertionsByStatus('proposed');

      expect(result).toHaveLength(1);
      expect(mockedReadTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'proposed', limit: neo4j.int(50) })
      );
    });

    it('should respect custom limit', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await getAssertionsByStatus('curated', 10);

      expect(mockedReadTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ limit: neo4j.int(10) })
      );
    });
  });

  describe('getAssertionsByAsserter', () => {
    it('should return assertions by agent asserter', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ assertedBy: 'agent:scout' }) }],
      });

      const result = await getAssertionsByAsserter('agent:scout');

      expect(result).toHaveLength(1);
    });

    it('should return assertions by user asserter', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ assertedBy: 'user:abc123' }) }],
      });

      const result = await getAssertionsByAsserter('user:abc123');

      expect(result).toHaveLength(1);
    });
  });

  describe('getHighConfidenceAssertions', () => {
    it('should return assertions above threshold', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [
          { claim: createMockAssertion({ confidence: 90 }) },
          { claim: createMockAssertion({ confidence: 85 }) },
        ],
      });

      const result = await getHighConfidenceAssertions(80);

      expect(result).toHaveLength(2);
    });

    it('should use default threshold of 80', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await getHighConfidenceAssertions();

      expect(mockedReadTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ minConfidence: 80 })
      );
    });

    it('filters and orders via COALESCE(claim.effectiveConfidence, claim.confidence) (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await getHighConfidenceAssertions();

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('WHERE coalesce(claim.effectiveConfidence, claim.confidence) >= $minConfidence');
      expect(cypher).toContain(
        'ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC'
      );
    });
  });

  describe('getAssertionsByPredicate', () => {
    it('should return assertions with specified predicate', async () => {
      mockedReadTransaction.mockResolvedValueOnce({
        records: [{ claim: createMockAssertion({ predicate: 'SOLVES' }) }],
      });

      const result = await getAssertionsByPredicate('SOLVES');

      expect(result).toHaveLength(1);
    });

    it('orders by COALESCE(claim.effectiveConfidence, claim.confidence) (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] });

      await getAssertionsByPredicate('SOLVES');

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain(
        'ORDER BY coalesce(claim.effectiveConfidence, claim.confidence) DESC, claim.createdAt DESC'
      );
    });
  });
});

// ============================================================================
// STATISTICS
// ============================================================================

describe('Statistics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAssertionStats', () => {
    it('should return comprehensive statistics', async () => {
      mockedReadTransaction
        .mockResolvedValueOnce({
          records: [
            {
              totalClaims: 100,
              avgConfidence: 75.5,
              proposedCount: 40,
              curatedCount: 50,
              rejectedCount: 5,
              derivedCount: 5,
              agentCount: 80,
              userCount: 20,
              claimsWithEvidence: 60,
              totalEvidence: 150,
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [
            { name: 'USES', count: 30 },
            { name: 'ADDRESSES', count: 25 },
          ],
        });

      const result = await getAssertionStats();

      expect(result.totalClaims).toBe(100);
      expect(result.avgConfidence).toBe(75.5);
      expect(result.byStatus.proposed).toBe(40);
      expect(result.byStatus.curated).toBe(50);
      expect(result.byAsserterType.agent).toBe(80);
      expect(result.byAsserterType.user).toBe(20);
      expect(result.topRelationTypes).toHaveLength(2);
    });

    it('should handle empty database', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] });

      const result = await getAssertionStats();

      expect(result.totalClaims).toBe(0);
      expect(result.avgConfidence).toBe(0);
      expect(result.topRelationTypes).toHaveLength(0);
    });

    it('averages via COALESCE(claim.effectiveConfidence, claim.confidence) (B0)', async () => {
      mockedReadTransaction.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] });

      await getAssertionStats();

      const [cypher] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('avg(coalesce(claim.effectiveConfidence, claim.confidence)) as avgConfidence');
    });
  });
});

// ============================================================================
// ENTITY SYNC
// ============================================================================

describe('Entity Sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('syncEntity', () => {
    it('should sync entity to Neo4j', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await syncEntity({
        id: 'tech-123',
        entityType: 'technology',
        name: 'TensorFlow',
        description: 'ML framework',
        status: 'active',
        tags: ['ml', 'ai'],
        updatedAt: Date.now(),
      });

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('MERGE (e:Entity {id: $id})'),
        expect.objectContaining({
          id: 'tech-123',
          entityType: 'technology',
          name: 'TensorFlow',
        })
      );
    });

    // OBS-003 — graph evidence for the accepted request identity.
    it('stamps the graph-operation correlation when one is supplied', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await syncEntity({
        id: 'tech-123',
        entityType: 'technology',
        name: 'TensorFlow',
        correlationId: 'corr_3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      });

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('e.syncCorrelationId = coalesce($syncCorrelationId, e.syncCorrelationId)');
      expect(params).toMatchObject({ syncCorrelationId: 'corr_3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    });

    it('discards a malformed correlation rather than writing caller text to the graph', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await syncEntity({
        id: 'tech-123',
        entityType: 'technology',
        name: 'TensorFlow',
        correlationId: 'DROP DATABASE neo4j',
      });

      expect(mockedWriteTransaction.mock.calls[0][1]).toMatchObject({ syncCorrelationId: null });
    });

    it('leaves an existing stamp alone when no correlation is supplied', async () => {
      // A cron-driven refresh has no accepted request. Overwriting the last known
      // request identity with null would erase evidence rather than add it.
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await syncEntity({ id: 'tech-123', entityType: 'technology', name: 'TensorFlow' });

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('coalesce($syncCorrelationId, e.syncCorrelationId)');
    });

    it('should handle entity without optional fields', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await syncEntity({
        id: 'tech-123',
        entityType: 'technology',
        name: 'TensorFlow',
        updatedAt: Date.now(),
      });

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          description: null,
          status: null,
          tags: [],
        })
      );
    });
  });

  describe('deleteEntityFromGraph', () => {
    it('atomically deletes endpoint assertions, evidence, projections, and document chunks', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [
          {
            assertionsDeleted: 1,
            evidenceDeleted: 2,
            projectionsDeleted: 1,
            chunksDeleted: 3,
            endpointsDeleted: 1,
          },
        ],
      });

      await expect(deleteEntityFromGraph('tech-123', 'technology')).resolves.toEqual({
        assertionsDeleted: 1,
        evidenceDeleted: 2,
        projectionsDeleted: 1,
        chunksDeleted: 3,
        endpointsDeleted: 1,
      });

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('claim.subjectId = $entityId AND claim.subjectType IN $entityTypes');
      expect(cypher).toContain('claim.objectId = $entityId AND claim.objectType IN $entityTypes');
      expect(cypher).toContain('projection.claimId IN [assertion IN assertions | assertion.id]');
      expect(cypher).toContain('(document:Document {id: $entityId})-[:CONTAINS]->(chunk:Chunk)');
      expect(cypher).toContain("WHERE $entityType = 'document'");
      expect(cypher).toContain('$endpointLabel IN labels(endpoint)');
      expect(cypher).toContain("'Entity' IN labels(endpoint) AND endpoint.entityType IN $entityTypes");
      expect(cypher).toContain('WHERE size(endpoints) <= 1');
      expect(cypher).toContain('FOREACH (assertion IN assertions | DETACH DELETE assertion)');
      expect(cypher).toContain('FOREACH (endpoint IN endpoints | DETACH DELETE endpoint)');
      expect(params).toEqual({
        entityId: 'tech-123',
        entityType: 'technology',
        entityTypes: ['technology'],
        endpointLabel: 'Technology',
      });
    });

    it('scopes duplicate scalar IDs to the requested endpoint type', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [
          {
            assertionsDeleted: 0,
            evidenceDeleted: 0,
            projectionsDeleted: 0,
            chunksDeleted: 0,
            endpointsDeleted: 0,
          },
        ],
      });

      await deleteEntityFromGraph('shared-id', 'document');

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('claim.subjectType IN $entityTypes');
      expect(cypher).toContain('claim.objectType IN $entityTypes');
      expect(cypher).toContain('$endpointLabel IN labels(endpoint)');
      expect(cypher).toContain('WHERE size(endpoints) <= 1');
      expect(params).toEqual({
        entityId: 'shared-id',
        entityType: 'document',
        entityTypes: ['document'],
        endpointLabel: 'Document',
      });
    });

    it.each([
      ['orgUnit', 'OrgUnit', ['orgUnit', 'org_unit']],
      ['painPoint', 'PainPoint', ['painPoint', 'pain_point']],
    ] as const)(
      'deletes both canonical and legacy assertion vocabularies for %s',
      async (entityType, label, aliases) => {
        mockedWriteTransaction.mockResolvedValueOnce({
          records: [
            {
              assertionsDeleted: 0,
              evidenceDeleted: 0,
              projectionsDeleted: 0,
              chunksDeleted: 0,
              endpointsDeleted: 0,
            },
          ],
        });

        await deleteEntityFromGraph('legacy-id', entityType);

        expect(mockedWriteTransaction).toHaveBeenCalledWith(
          expect.stringContaining('claim.subjectType IN $entityTypes'),
          {
            entityId: 'legacy-id',
            entityType,
            entityTypes: [...aliases],
            endpointLabel: label,
          }
        );
      }
    );

    it('rejects an unvalidated endpoint type before issuing Cypher', async () => {
      await expect(deleteEntityFromGraph('unsafe-id', 'unknown' as never)).rejects.toThrow(
        'Unsupported graph entity type: unknown'
      );
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });

    it('returns zero counters when the endpoint is already absent', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({
        records: [
          {
            assertionsDeleted: 0,
            evidenceDeleted: 0,
            projectionsDeleted: 0,
            chunksDeleted: 0,
            endpointsDeleted: 0,
          },
        ],
      });

      await expect(deleteEntityFromGraph('missing', 'company')).resolves.toEqual({
        assertionsDeleted: 0,
        evidenceDeleted: 0,
        projectionsDeleted: 0,
        chunksDeleted: 0,
        endpointsDeleted: 0,
      });
    });

    it('fails loudly when the transaction detects ambiguous typed endpoints', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await expect(deleteEntityFromGraph('duplicate-id', 'company')).rejects.toThrow(
        'Ambiguous graph endpoint: multiple company nodes share id duplicate-id'
      );
    });
  });
});

// ============================================================================
// BULK OPERATIONS
// ============================================================================

describe('Bulk Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('bulkCreateAssertions', () => {
    it('should create multiple assertions', async () => {
      const inputs = [
        createMockAssertionInput({ subject: { id: 'tech-1', type: 'technology', name: 'Tech 1' } }),
        createMockAssertionInput({ subject: { id: 'tech-2', type: 'technology', name: 'Tech 2' } }),
      ];

      mockedWriteTransaction
        .mockResolvedValueOnce({ records: [{ claim: createMockAssertion({ id: 'claim-1' }) }] })
        .mockResolvedValueOnce({ records: [{ claim: createMockAssertion({ id: 'claim-2' }) }] });

      const result = await bulkCreateAssertions(inputs);

      expect(result).toHaveLength(2);
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(2);
    });

    it('should return empty array for empty input', async () => {
      const result = await bulkCreateAssertions([]);

      expect(result).toHaveLength(0);
      expect(mockedWriteTransaction).not.toHaveBeenCalled();
    });
  });

  describe('bulkApproveAssertions', () => {
    it('should approve multiple assertions', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await bulkApproveAssertions(['claim-1', 'claim-2', 'claim-3'], 'user:admin');

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining("SET claim.status = 'curated'"),
        expect.objectContaining({
          assertionIds: ['claim-1', 'claim-2', 'claim-3'],
        })
      );
    });
  });

  describe('bulkRejectAssertions', () => {
    it('should reject multiple assertions', async () => {
      mockedWriteTransaction.mockResolvedValueOnce({ records: [] });

      await bulkRejectAssertions(['claim-1', 'claim-2']);

      expect(mockedWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining("SET claim.status = 'rejected'"),
        expect.objectContaining({
          assertionIds: ['claim-1', 'claim-2'],
        })
      );
      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('OPTIONAL MATCH ()-[edge {claimId: assertionId}]->()');
      expect(cypher).toContain('r.t_invalidated = coalesce(r.t_invalidated, $invalidatedAt)');
    });
  });
});

// ============================================================================
// EDGE CASES & ERROR HANDLING
// ============================================================================

describe('Edge Cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should handle assertion ID generation uniqueness', async () => {
    // Create two assertions and verify IDs are different
    mockedWriteTransaction.mockResolvedValue({
      records: [{ claim: createMockAssertion() }],
    });

    const input = createMockAssertionInput();
    const claim1 = await createAssertion(input);
    const claim2 = await createAssertion(input);

    // IDs are generated with timestamp + random, so should be different
    // Note: This tests the mock return, not actual ID generation
    expect(claim1).toBeDefined();
    expect(claim2).toBeDefined();
  });

  it('should handle predicate with underscores in statement generation', async () => {
    const input = createMockAssertionInput({
      predicate: 'IS_IMPLEMENTED_BY',
    });

    mockedWriteTransaction.mockResolvedValueOnce({
      records: [{ claim: createMockAssertion() }],
    });

    const result = await createAssertion(input);

    // Statement should have underscores replaced with spaces and be lowercase
    expect(result.statement).toBe('TensorFlow is implemented by Machine Learning Pipeline');
  });

  it('should handle empty records gracefully in getAssertionsForEntity', async () => {
    mockedReadTransaction.mockResolvedValueOnce({
      records: [],
    });

    const result = await getAssertionsForEntity('nonexistent-entity');

    expect(result.asSubject).toEqual([]);
    expect(result.asObject).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});
