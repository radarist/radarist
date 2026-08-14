/**
 * Extended tests for verify-entity (Defense Minister) — Gate 3 requirement: ≥20 tests
 */

// Admin SDK boundary — verify-entity.ts dynamic-imports `@/lib/firebase-admin`
// post T1.2. ENTITY_CONFIGS is no longer needed: the function uses an inline
// ENTITY_COLLECTIONS map.
import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';
const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/graph/verification', () => ({
  createVerificationResult: jest.fn().mockResolvedValue({ id: 'vr-test' }),
}));

// Smart scoring path — return sparse so the function falls through to the
// pragmatic-v1 active recheck. Combined with the inconclusive reality-check
// mock and a no-website entity, that yields score=50 / status='unverified',
// which matches the existing assertions in this suite.
jest.mock('@/lib/graph/observations', () => ({
  getObservationsForEntity: jest.fn().mockResolvedValue([]),
  aggregateObservationScore: jest.fn().mockReturnValue({ sparse: true, observationCount: 0 }),
}));

// Pragmatic-v1 fallback dependencies — default to inconclusive verdicts so the
// pragmatic path produces sourcesChecked=1, decisive=0 → score=50 / unverified.
jest.mock('@/lib/entity-reality-check', () => ({
  verifyEntityReality: jest.fn().mockResolvedValue({ ok: true, reason: 'inconclusive', evidenceText: '' }),
}));
jest.mock('@/lib/scout-url-verifier', () => ({
  verifyUrlsReachable: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockInngest = {
  createFunction: jest.fn((config, trigger, handler) => ({
    config,
    trigger,
    handler,
    async execute(data: Record<string, unknown>) {
      const step = {
        run: jest.fn(async (_name: string, fn: () => unknown) => fn()),
      };
      return handler({ event: { data }, step });
    },
  })),
  send: jest.fn(),
};
jest.mock('@/lib/inngest/client', () => ({ inngest: mockInngest }));

const { createVerificationResult } = require('@/lib/graph/verification');
// Admin-SDK spies for assertions (chain leaves on adminMock).
const docGet = adminMock.docGet;
const docUpdate = adminMock.update;

describe('verify-entity (Defense Minister)', () => {
  // The verify-entity function early-returns { skipped: true } unless the
  // master gate env var is set (verify-entity.ts:35-41 — defense in depth
  // added in commit 99c47f37). Use beforeEach/afterEach (not beforeAll) so
  // the env doesn't leak across files in the same Jest worker.
  beforeEach(() => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    jest.clearAllMocks();
    docGet.mockResolvedValue({
      exists: true,
      data: () => ({ name: 'Test Entity', description: 'A test', updatedAt: '2026-01-01' }),
    });
    docUpdate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('should load entity from Firestore', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(docGet).toHaveBeenCalled();
  });

  it('should throw when entity not found', async () => {
    docGet.mockResolvedValue({ exists: false });
    const { verifyEntityJob } = require('../verify-entity');
    await expect(verifyEntityJob.execute({ entityId: 'missing', entityType: 'company' })).rejects.toThrow('not found');
  });

  it('should write verification result to Neo4j', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(createVerificationResult).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'e1', status: 'unverified' })
    );
  });

  it('should update entity verifiedScore in Firestore', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    const updateArgs = docUpdate.mock.calls[0][0];
    expect(updateArgs).toMatchObject({ verifiedScore: 50, verifiedStatus: 'unverified' });
  });

  it('should return verification result', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    const result = await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(result).toHaveProperty('entityId', 'e1');
    expect(result).toHaveProperty('status', 'unverified');
  });

  it('should handle technology entity type', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    await verifyEntityJob.execute({ entityId: 't1', entityType: 'technology' });
    expect(createVerificationResult).toHaveBeenCalledWith(expect.objectContaining({ entityId: 't1' }));
  });

  it('should include score in result', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    const result = await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(result.score).toBe(50);
  });

  it('should include sourcesChecked in result', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    const result = await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(result.sourcesChecked).toBeDefined();
  });

  it('should include reasoning in result', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    const result = await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.length).toBeGreaterThan(0);
  });

  it('should include verifiedAt timestamp in Firestore update', async () => {
    const { verifyEntityJob } = require('../verify-entity');
    await verifyEntityJob.execute({ entityId: 'e1', entityType: 'company' });
    const updateArgs = docUpdate.mock.calls[0][0];
    expect(typeof updateArgs.verifiedAt).toBe('string');
  });

  it('should have correct Inngest function id', () => {
    const { verifyEntityJob } = require('../verify-entity');
    expect(verifyEntityJob.config.id).toBe('verify-entity');
  });

  it('should have retries configured', () => {
    const { verifyEntityJob } = require('../verify-entity');
    expect(verifyEntityJob.config.retries).toBe(2);
  });

  it('should have onFailure handler', () => {
    const { verifyEntityJob } = require('../verify-entity');
    expect(verifyEntityJob.config.onFailure).toBeDefined();
  });

  it('should trigger on verification requested event', () => {
    const { verifyEntityJob } = require('../verify-entity');
    expect(verifyEntityJob.trigger.event).toBe('app/entity.verification.requested');
  });
});
