/**
 * Tests for sync-assertion-to-neo4j.ts
 *
 * Covers:
 * - syncAssertionToNeo4jJob: Single claim sync (create/update/delete/updateStatus)
 *   including the agent-confidence materialization gate (Relation Write Contract)
 * - batchSyncAssertionsJob: Batch claim sync
 * - initGraphSchemaJob: Neo4j schema initialization
 *
 * (The legacy syncEntityToNeo4jJob was deleted 2026-06-10 — zero senders,
 * superseded by sync-unified-entity-to-neo4j in sync-entity-to-neo4j.ts.)
 */

// ============================================================================
// MOCKS - must be declared before any imports
// ============================================================================

jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

jest.mock('@/lib/graph', () => ({
  createAssertion: jest.fn(),
  getAssertion: jest.fn(),
  updateAssertionStatus: jest.fn(),
  updateAssertionConfidence: jest.fn(),
  deleteAssertion: jest.fn(),
  addEvidenceToAssertion: jest.fn(),
  materializeAssertionAsEdge: jest.fn().mockResolvedValue({ created: true, edgeType: 'USES' }),
  checkHealth: jest.fn(),
  initializeSchema: jest.fn(),
}));

// The job imports the materialization gate from the defining module (not the
// barrel above). Use the REAL predicate — the gate behavior (confidence-75
// boundary, agent vs user asserters) is part of what these tests pin.
jest.mock('@/lib/graph/assertions', () => ({
  shouldMaterializeAssertion: jest.requireActual('@/lib/graph/assertions').shouldMaterializeAssertion,
}));

// C3: the promotion path re-applies the corroboration nudge after
// materializing the edge. Bare stub — full coverage lives in
// confidence-calibration.test.ts.
jest.mock('@/lib/graph/confidence-calibration', () => ({
  applyCorroborationNudge: jest.fn(),
}));

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => {
      return {
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      };
    }),
    send: jest.fn(),
  },
}));

// ============================================================================
// IMPORTS - after mocks
// ============================================================================

import {
  createAssertion,
  getAssertion,
  updateAssertionStatus,
  updateAssertionConfidence,
  deleteAssertion,
  addEvidenceToAssertion,
  materializeAssertionAsEdge,
  checkHealth,
  initializeSchema,
} from '@/lib/graph';
import { applyCorroborationNudge } from '@/lib/graph/confidence-calibration';
import { inngest } from '../client';
import {
  syncAssertionToNeo4jJob,
  batchSyncAssertionsJob,
  initGraphSchemaJob,
} from '../functions/sync-assertion-to-neo4j';

// ============================================================================
// TYPE HELPER
// ============================================================================

interface TestableJob {
  config: { id: string; retries: number; throttle?: unknown; onFailure?: unknown };
  trigger: { event?: string; cron?: string };
  execute: (data: Record<string, unknown>) => Promise<{ result: unknown; steps: Record<string, unknown> }>;
}

// ============================================================================
// SHARED TEST DATA
// ============================================================================

const HEALTHY = { healthy: true };
const UNHEALTHY = { healthy: false, error: 'Connection refused' };

const SAMPLE_CLAIM_DATA = {
  subject: { id: 'tech-1', type: 'technology' as const, name: 'TensorFlow' },
  object: { id: 'pp-1', type: 'painPoint' as const, name: 'ML complexity' },
  predicate: 'SOLVES',
  confidence: 80,
  assertedBy: 'agent:scout',
};

const SAMPLE_EVIDENCE = [
  { sourceType: 'signal' as const, snippet: 'TensorFlow reduces ML complexity', signalId: 'sig-1' },
];

// ============================================================================
// TESTS
// ============================================================================

describe('sync-assertion-to-neo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkHealth as jest.Mock).mockResolvedValue(HEALTHY);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // syncAssertionToNeo4jJob
  // ==========================================================================

  describe('syncAssertionToNeo4jJob', () => {
    const job = syncAssertionToNeo4jJob as unknown as TestableJob;

    // ------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------

    it('should have correct id', () => {
      expect(job.config.id).toBe('sync-assertion-to-neo4j');
    });

    it('should have correct retries', () => {
      expect(job.config.retries).toBe(3);
    });

    it('should have throttle config', () => {
      expect(job.config.throttle).toBeDefined();
      expect(job.config.throttle).toMatchObject({ limit: 50, period: '1m' });
    });

    it('should be triggered by app/claim.sync.requested', () => {
      expect(job.trigger.event).toBe('app/claim.sync.requested');
    });

    // ------------------------------------------------------------------------
    // Create operation
    // ------------------------------------------------------------------------

    it('should check Neo4j health before creating a claim', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'claim-1', confidence: 80, assertedBy: 'agent:scout' });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: SAMPLE_CLAIM_DATA,
      });

      expect(checkHealth).toHaveBeenCalledTimes(1);
    });

    it('should create a claim and send a completion event', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'claim-new', confidence: 80, assertedBy: 'agent:scout' });

      const { result } = await (job as TestableJob).execute({
        operation: 'create',
        relationId: 'rel-1',
        claimData: SAMPLE_CLAIM_DATA,
      });

      expect(createAssertion).toHaveBeenCalledWith(SAMPLE_CLAIM_DATA);
      expect(result).toMatchObject({ success: true, claimId: 'claim-new', operation: 'created' });
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'app/claim.sync.completed',
        data: expect.objectContaining({
          claimId: 'claim-new',
          relationId: 'rel-1',
          operation: 'created',
        }),
      });
    });

    it('should throw when claimData is missing for create operation', async () => {
      await expect((job as TestableJob).execute({ operation: 'create' })).rejects.toThrow(
        'claimData required for create operation'
      );
    });

    // ------------------------------------------------------------------------
    // Task 16 (A1) — ingress normalization at the create-path
    // ------------------------------------------------------------------------

    it('normalizes a legacy 0-1 claimData.confidence to 0-100 before creating the assertion', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-legacy',
        confidence: 85,
        assertedBy: 'agent:scout',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 0.85 },
      });

      expect(createAssertion).toHaveBeenCalledWith(expect.objectContaining({ confidence: 85 }));
    });

    it('passes an already-0-100 claimData.confidence through unchanged at create ingress', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'claim-1', confidence: 80, assertedBy: 'agent:scout' });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: SAMPLE_CLAIM_DATA,
      });

      expect(createAssertion).toHaveBeenCalledWith(expect.objectContaining({ confidence: 80 }));
    });

    // ------------------------------------------------------------------------
    // Update operation - claim found
    // ------------------------------------------------------------------------

    it('should update confidence when claim exists and confidence changed', async () => {
      (getAssertion as jest.Mock).mockResolvedValue({ id: 'claim-1', confidence: 60 });

      const { result } = await (job as TestableJob).execute({
        operation: 'update',
        claimId: 'claim-1',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 90 },
      });

      expect(getAssertion).toHaveBeenCalledWith('claim-1');
      expect(updateAssertionConfidence).toHaveBeenCalledWith('claim-1', 90);
      expect(result).toMatchObject({ claimId: 'claim-1', operation: 'updated' });
    });

    it('should not update confidence when confidence is unchanged', async () => {
      (getAssertion as jest.Mock).mockResolvedValue({ id: 'claim-1', confidence: 80 });

      await (job as TestableJob).execute({
        operation: 'update',
        claimId: 'claim-1',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 80 },
      });

      expect(updateAssertionConfidence).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // Update operation - claim not found
    // ------------------------------------------------------------------------

    it('should create claim when claim not found in Neo4j but claimData is provided', async () => {
      (getAssertion as jest.Mock).mockResolvedValue(null);
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'claim-created' });

      const { result } = await (job as TestableJob).execute({
        operation: 'update',
        claimId: 'claim-missing',
        claimData: SAMPLE_CLAIM_DATA,
      });

      expect(createAssertion).toHaveBeenCalledWith(SAMPLE_CLAIM_DATA);
      expect(result).toMatchObject({ claimId: 'claim-created', operation: 'created' });
    });

    it('should throw when claim not found and no claimData provided for update', async () => {
      (getAssertion as jest.Mock).mockResolvedValue(null);

      await expect((job as TestableJob).execute({ operation: 'update', claimId: 'claim-ghost' })).rejects.toThrow(
        'Claim claim-ghost not found and no claimData provided'
      );
    });

    // ------------------------------------------------------------------------
    // Delete operation
    // ------------------------------------------------------------------------

    it('should delete a claim and send a completion event', async () => {
      (deleteAssertion as jest.Mock).mockResolvedValue(undefined);

      const { result } = await (job as TestableJob).execute({
        operation: 'delete',
        claimId: 'claim-del',
      });

      expect(deleteAssertion).toHaveBeenCalledWith('claim-del');
      expect(result).toMatchObject({ success: true, claimId: 'claim-del', operation: 'deleted' });
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/claim.sync.completed',
          data: expect.objectContaining({ operation: 'deleted' }),
        })
      );
    });

    it('should throw when claimId is missing for delete operation', async () => {
      await expect((job as TestableJob).execute({ operation: 'delete' })).rejects.toThrow(
        'claimId required for delete operation'
      );
    });

    // ------------------------------------------------------------------------
    // UpdateStatus operation
    // ------------------------------------------------------------------------

    it('should update claim status and send a completion event', async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);

      const { result } = await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-1',
        claimData: { status: 'curated' },
      });

      expect(updateAssertionStatus).toHaveBeenCalledWith('claim-1', 'curated');
      expect(result).toMatchObject({ claimId: 'claim-1', operation: 'statusUpdated' });
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/claim.sync.completed',
          data: expect.objectContaining({ operation: 'statusUpdated' }),
        })
      );
    });

    it('should throw when claimId is missing for updateStatus', async () => {
      await expect(
        (job as TestableJob).execute({ operation: 'updateStatus', claimData: { status: 'curated' } })
      ).rejects.toThrow('claimId and status required for updateStatus operation');
    });

    it('should throw when status is missing for updateStatus', async () => {
      await expect(
        (job as TestableJob).execute({ operation: 'updateStatus', claimId: 'claim-1', claimData: {} })
      ).rejects.toThrow('claimId and status required for updateStatus operation');
    });

    // ------------------------------------------------------------------------
    // Unknown operation
    // ------------------------------------------------------------------------

    it('should throw for an unknown operation', async () => {
      await expect((job as TestableJob).execute({ operation: 'archive', claimId: 'claim-1' })).rejects.toThrow(
        'Unknown operation: archive'
      );
    });

    // ------------------------------------------------------------------------
    // Evidence
    // ------------------------------------------------------------------------

    it('should add evidence to the claim after create', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'claim-ev', confidence: 80, assertedBy: 'agent:scout' });
      (addEvidenceToAssertion as jest.Mock).mockResolvedValue(undefined);

      const { steps } = await (job as TestableJob).execute({
        operation: 'create',
        claimData: SAMPLE_CLAIM_DATA,
        evidence: SAMPLE_EVIDENCE,
      });

      expect(addEvidenceToAssertion).toHaveBeenCalledWith('claim-ev', SAMPLE_EVIDENCE[0]);
      expect(steps['add-evidence']).toMatchObject({ evidenceCount: 1 });
    });

    it('should not add evidence for delete operation even if evidence provided', async () => {
      (deleteAssertion as jest.Mock).mockResolvedValue(undefined);

      await (job as TestableJob).execute({
        operation: 'delete',
        claimId: 'claim-1',
        evidence: SAMPLE_EVIDENCE,
      });

      expect(addEvidenceToAssertion).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // Neo4j health failures
    // ------------------------------------------------------------------------

    it('should throw when Neo4j is unhealthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue(UNHEALTHY);

      await expect((job as TestableJob).execute({ operation: 'create', claimData: SAMPLE_CLAIM_DATA })).rejects.toThrow(
        'Neo4j not healthy: Connection refused'
      );
    });

    // ------------------------------------------------------------------------
    // Materialization gate (Relation Write Contract)
    // Agent claims below confidence 75 (0–100 scale) stay 'proposed' and do
    // NOT materialize a typed edge until a reviewer approves.
    // ------------------------------------------------------------------------

    it('should NOT materialize a typed edge for an agent claim with confidence 60', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-low',
        confidence: 60,
        assertedBy: 'agent:scout',
        asserterType: 'agent',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 60 },
      });

      expect(materializeAssertionAsEdge).not.toHaveBeenCalled();
    });

    it('should materialize a typed edge for an agent claim with confidence 80', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-high',
        confidence: 80,
        assertedBy: 'agent:scout',
        asserterType: 'agent',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 80 },
      });

      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-high');
    });

    it('should materialize a typed edge for a user (curated) claim regardless of confidence', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-user',
        confidence: 10,
        assertedBy: 'user:claudio',
        asserterType: 'user',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 10, assertedBy: 'user:claudio' },
      });

      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-user');
    });

    it("should NOT materialize for an 'ai:'-prefixed asserter below confidence 75 (machine asserter)", async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-ai-low',
        confidence: 74,
        assertedBy: 'ai:assistant',
        asserterType: 'agent',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 74, assertedBy: 'ai:assistant' },
      });

      expect(materializeAssertionAsEdge).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // B0: the gate reads assertedConfidence when present, falls back to the
    // legacy confidence mirror otherwise.
    // ------------------------------------------------------------------------

    it('gates on assertedConfidence when present (wins over a stale lower legacy confidence)', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-asserted-precedence',
        confidence: 60,
        assertedConfidence: 80,
        assertedBy: 'agent:scout',
        asserterType: 'agent',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 60 },
      });

      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-asserted-precedence');
    });

    it('falls back to the legacy confidence field when assertedConfidence is absent', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({
        id: 'claim-legacy-fallback',
        confidence: 60,
        assertedBy: 'agent:scout',
        asserterType: 'agent',
      });

      await (job as TestableJob).execute({
        operation: 'create',
        claimData: { ...SAMPLE_CLAIM_DATA, confidence: 60 },
      });

      expect(materializeAssertionAsEdge).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------------
    // Approval materialization (Relation Write Contract)
    // updateStatus → 'curated' must materialize the typed edge the confidence
    // gate withheld at create time (idempotent MERGE on claimId).
    // ------------------------------------------------------------------------

    it("should materialize the typed edge when status is updated to 'curated'", async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);

      const { result } = await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-approved',
        claimData: { status: 'curated' },
      });

      expect(updateAssertionStatus).toHaveBeenCalledWith('claim-approved', 'curated');
      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-approved');
      expect(result).toMatchObject({ claimId: 'claim-approved', operation: 'statusUpdated' });
    });

    it("should NOT materialize when status is updated to 'rejected'", async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);

      await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-rejected',
        claimData: { status: 'rejected' },
      });

      expect(updateAssertionStatus).toHaveBeenCalledWith('claim-rejected', 'rejected');
      expect(materializeAssertionAsEdge).not.toHaveBeenCalled();
    });

    it('promotion re-applies the corroboration nudge to the fresh edge', async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);
      (applyCorroborationNudge as jest.Mock).mockResolvedValue({
        distinctSources: 2,
        nudge: 5,
        effectiveConfidence: 80,
      });

      const { result } = await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-promoted',
        relationId: 'rel-promoted-1',
        claimData: { status: 'curated' },
      });

      // The freshly materialized edge must inherit the nudge: materialize
      // first, nudge second (order-sensitive — a pre-materialization nudge
      // would mirror onto zero edges and be silently lost).
      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-promoted');
      expect(applyCorroborationNudge).toHaveBeenCalledWith('rel-promoted-1');
      const materializeOrder = (materializeAssertionAsEdge as jest.Mock).mock.invocationCallOrder[0];
      const nudgeOrder = (applyCorroborationNudge as jest.Mock).mock.invocationCallOrder[0];
      expect(materializeOrder).toBeLessThan(nudgeOrder);
      expect(result).toMatchObject({ claimId: 'claim-promoted', operation: 'statusUpdated' });
    });

    it('nudge failure never fails the promotion', async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);
      (applyCorroborationNudge as jest.Mock).mockRejectedValue(new Error('neo hiccup'));

      const { result } = await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-promoted-2',
        relationId: 'rel-promoted-2',
        claimData: { status: 'curated' },
      });

      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-promoted-2');
      expect(result).toMatchObject({ claimId: 'claim-promoted-2', operation: 'statusUpdated' });
    });

    it('promotion without a relationId skips the nudge (guard)', async () => {
      (updateAssertionStatus as jest.Mock).mockResolvedValue(undefined);

      await (job as TestableJob).execute({
        operation: 'updateStatus',
        claimId: 'claim-no-rel',
        claimData: { status: 'curated' },
      });

      expect(materializeAssertionAsEdge).toHaveBeenCalledWith('claim-no-rel');
      expect(applyCorroborationNudge).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // batchSyncAssertionsJob
  // ==========================================================================

  describe('batchSyncAssertionsJob', () => {
    const job = batchSyncAssertionsJob as unknown as TestableJob;

    // ------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------

    it('should have correct id', () => {
      expect(job.config.id).toBe('batch-sync-assertions-to-neo4j');
    });

    it('should have correct retries', () => {
      expect(job.config.retries).toBe(2);
    });

    it('should be triggered by app/claim.batch-sync.requested', () => {
      expect(job.trigger.event).toBe('app/claim.batch-sync.requested');
    });

    // ------------------------------------------------------------------------
    // Normal batch processing
    // ------------------------------------------------------------------------

    it('should process all claims and send completion event', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'created-claim' });

      const claims = [SAMPLE_CLAIM_DATA, { ...SAMPLE_CLAIM_DATA, predicate: 'USES' }];

      const { result } = await (job as TestableJob).execute({
        claims,
        options: { batchSize: 50 },
      });

      expect(createAssertion).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ success: true, created: 2, failed: 0 });
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/claim.batch-sync.completed',
          data: expect.objectContaining({ totalClaims: 2, created: 2, failed: 0 }),
        })
      );
    });

    it('should handle individual claim failures without aborting the batch', async () => {
      (createAssertion as jest.Mock)
        .mockResolvedValueOnce({ id: 'ok-claim' })
        .mockRejectedValueOnce(new Error('Constraint violation'));

      const claims = [SAMPLE_CLAIM_DATA, { ...SAMPLE_CLAIM_DATA, predicate: 'USES' }];

      const { result } = await (job as TestableJob).execute({ claims });

      const r = result as { created: number; failed: number; errors: string[]; success: boolean };
      expect(r.created).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('Constraint violation');
      expect(r.success).toBe(false);
    });

    it('should initialize schema before processing when options.initSchema is true', async () => {
      (initializeSchema as jest.Mock).mockResolvedValue(undefined);
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'c' });

      const { steps } = await (job as TestableJob).execute({
        claims: [SAMPLE_CLAIM_DATA],
        options: { initSchema: true },
      });

      expect(initializeSchema).toHaveBeenCalledTimes(1);
      expect(steps['init-schema']).toMatchObject({ schemaInitialized: true });
    });

    it('should skip schema initialization when options.initSchema is false', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'c' });

      await (job as TestableJob).execute({
        claims: [SAMPLE_CLAIM_DATA],
        options: { initSchema: false },
      });

      expect(initializeSchema).not.toHaveBeenCalled();
    });

    it('should use default batchSize of 50 when not specified', async () => {
      (createAssertion as jest.Mock).mockResolvedValue({ id: 'c' });

      // 55 claims - with batchSize 50 we expect 2 step.run calls: process-batch-1 and process-batch-2
      const claims = Array.from({ length: 55 }, (_, i) => ({ ...SAMPLE_CLAIM_DATA, predicate: `REL_${i}` }));

      const { steps } = await (job as TestableJob).execute({ claims });

      expect(steps['process-batch-1']).toBeDefined();
      expect(steps['process-batch-2']).toBeDefined();
      expect(createAssertion).toHaveBeenCalledTimes(55);
    });

    it('should throw when Neo4j is unhealthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue(UNHEALTHY);

      await expect((job as TestableJob).execute({ claims: [SAMPLE_CLAIM_DATA] })).rejects.toThrow(
        'Neo4j not healthy: Connection refused'
      );
    });
  });

  // ==========================================================================
  // initGraphSchemaJob
  // ==========================================================================

  describe('initGraphSchemaJob', () => {
    const job = initGraphSchemaJob as unknown as TestableJob;

    // ------------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------------

    it('should have correct id', () => {
      expect(job.config.id).toBe('init-graph-schema');
    });

    it('should have correct retries (1)', () => {
      expect(job.config.retries).toBe(1);
    });

    it('should be triggered by app/graph.init.requested', () => {
      expect(job.trigger.event).toBe('app/graph.init.requested');
    });

    // ------------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------------

    it('should check health, initialize schema, and send completion event', async () => {
      (initializeSchema as jest.Mock).mockResolvedValue(undefined);

      const { result, steps } = await (job as TestableJob).execute({});

      expect(checkHealth).toHaveBeenCalledTimes(1);
      expect(initializeSchema).toHaveBeenCalledTimes(1);
      expect(steps['init-schema']).toMatchObject({ initialized: true });
      expect(result).toMatchObject({ success: true });
      expect(inngest.send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app/graph.init.completed',
          data: expect.objectContaining({ initializedAt: expect.any(Number) }),
        })
      );
    });

    // ------------------------------------------------------------------------
    // Unhealthy Neo4j
    // ------------------------------------------------------------------------

    it('should throw and skip initialization when Neo4j is unhealthy', async () => {
      (checkHealth as jest.Mock).mockResolvedValue(UNHEALTHY);

      await expect((job as TestableJob).execute({})).rejects.toThrow('Neo4j not healthy: Connection refused');

      expect(initializeSchema).not.toHaveBeenCalled();
    });
  });
});
