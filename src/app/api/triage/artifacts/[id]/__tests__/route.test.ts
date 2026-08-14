/**
 * @jest-environment node
 *
 * proposedArtifact resolve route: APPROVE is the execute-on-approve gate — it dispatches
 * the generation job AND wires 'artifact' feedback; reject/dismiss never dispatch; unknown
 * action 400s; and neither a feedback-wire failure nor a dispatch failure breaks the 200.
 */
export {};

const mockGetAuth = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();
const mockDismiss = jest.fn();
const mockSend = jest.fn();
const mockRecordFeedback = jest.fn();

// The route branches on `instanceof ProposedArtifactNotFoundError`, so the mock
// must export the SAME class identity the route imports.
class MockProposedArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Proposed artifact not found: ${id}`);
    this.name = 'ProposedArtifactNotFoundError';
  }
}

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: (...a: unknown[]) => mockGetAuth(...a) }));
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  approveProposedArtifact: (...a: unknown[]) => mockApprove(...a),
  rejectProposedArtifact: (...a: unknown[]) => mockReject(...a),
  dismissProposedArtifact: (...a: unknown[]) => mockDismiss(...a),
  ProposedArtifactNotFoundError: MockProposedArtifactNotFoundError,
}));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => mockSend(...a) } }));
jest.mock('@/lib/discovery/discovery-feedback', () => ({
  recordProposalFeedback: (...a: unknown[]) => mockRecordFeedback(...a),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { POST } = require('../route');

function req(body: unknown) {
  return { json: async () => body } as unknown as import('next/server').NextRequest;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/triage/artifacts/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({ authenticated: true, uid: 'u1' });
    mockApprove.mockResolvedValue({
      artifact: { id: 'p1', title: 'Report', scope: { entityIds: ['s1'], entityType: 'strategy' } },
      transitioned: true,
    });
    mockReject.mockResolvedValue({
      id: 'p1',
      title: 'Report',
      scope: { entityIds: [], entityType: 'document', query: 'AI agents' },
    });
    mockDismiss.mockResolvedValue({
      id: 'p1',
      title: 'Report',
      scope: { entityIds: [], entityType: 'document', query: 'AI agents' },
    });
    mockSend.mockResolvedValue(undefined);
    mockRecordFeedback.mockResolvedValue(undefined);
  });

  it('401s when unauthenticated and does not touch the store', async () => {
    mockGetAuth.mockResolvedValue({ authenticated: false, error: 'no auth' });
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(401);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('approve dispatches the generation job and wires artifact feedback', async () => {
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith('p1', 'u1');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/artifact.generation.requested',
        data: { proposedArtifactId: 'p1', userId: 'u1' },
      })
    );
    // entity-scoped (entityIds present) → no topicOverride; resolveEntityTopic reads the strategy's tags.
    expect(mockRecordFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'artifact',
      's1',
      'strategy',
      'approved',
      undefined,
      undefined
    );
  });

  it('reject records feedback and does NOT dispatch generation', async () => {
    const res = await POST(req({ action: 'reject' }), ctx('p1'));
    expect(res.status).toBe(200);
    expect(mockReject).toHaveBeenCalledWith('p1', 'u1', undefined);
    expect(mockSend).not.toHaveBeenCalled();
    // query-only (no entityIds) → topic derived from the subject ('AI agents' → 'ai'), NOT the 'document' dead-end.
    expect(mockRecordFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'artifact',
      'p1',
      'document',
      'rejected',
      undefined,
      'ai'
    );
  });

  it('an idempotent re-approve (transitioned:false) returns 200 but NEVER re-dispatches generation', async () => {
    mockApprove.mockResolvedValue({
      artifact: { id: 'p1', title: 'Report', scope: { entityIds: ['s1'], entityType: 'strategy' } },
      transitioned: false,
    });
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
    // No second event — a duplicate approve must not duplicate deep-research
    // documents or race the report slot upsert.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects an unknown action with 400', async () => {
    const res = await POST(req({ action: 'frobnicate' }), ctx('p1'));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a dispatch failure NEVER breaks the approve 200 (approval already committed)', async () => {
    mockSend.mockRejectedValue(new Error('inngest down'));
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
  });

  it('a feedback-wire failure NEVER breaks the triage 200', async () => {
    mockRecordFeedback.mockRejectedValue(new Error('neo4j down'));
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
  });

  describe('SEC-011: foreign and absent proposals are indistinguishable', () => {
    it.each(['approve', 'reject', 'dismiss'])(
      '%s → identical 404 body for a miss, with no dispatch and no feedback',
      async (action) => {
        const err = new MockProposedArtifactNotFoundError('p-foreign');
        mockApprove.mockRejectedValue(err);
        mockReject.mockRejectedValue(err);
        mockDismiss.mockRejectedValue(err);

        const resForeign = await POST(req({ action }), ctx('p-foreign'));
        const resAbsent = await POST(req({ action }), ctx('p-absent'));

        expect(resForeign.status).toBe(404);
        expect(resAbsent.status).toBe(404);
        // Byte-identical bodies: a caller must not learn whether the id exists.
        expect(await resForeign.json()).toEqual(await resAbsent.json());
        expect(await (await POST(req({ action }), ctx('p-x'))).json()).toEqual({
          error: 'Proposed artifact not found',
        });
        expect(mockSend).not.toHaveBeenCalled();
        expect(mockRecordFeedback).not.toHaveBeenCalled();
      }
    );
  });
});
