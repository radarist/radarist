/**
 * @jest-environment node
 *
 * B3 — proposedEntity resolve route: approve mints + wires feedback on the tag topic
 * (via appliedEntityId), reject/dismiss record feedback, unknown action 400s, and the
 * best-effort feedback wire never breaks the 200.
 */
export {};

const mockGetAuth = jest.fn();
const mockApprove = jest.fn();
const mockReject = jest.fn();
const mockDismiss = jest.fn();
const mockRecordFeedback = jest.fn();

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: (...a: unknown[]) => mockGetAuth(...a) }));
jest.mock('@/lib/proposed-entities-admin', () => ({
  approveProposedEntity: (...a: unknown[]) => mockApprove(...a),
  rejectProposedEntity: (...a: unknown[]) => mockReject(...a),
  dismissProposedEntity: (...a: unknown[]) => mockDismiss(...a),
}));
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

describe('POST /api/triage/entities/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuth.mockResolvedValue({ authenticated: true, uid: 'u1' });
    mockApprove.mockResolvedValue({ id: 'p1', entityType: 'technology', appliedEntityId: 'tech-1' });
    mockReject.mockResolvedValue({ id: 'p1', entityType: 'technology' });
    mockDismiss.mockResolvedValue({ id: 'p1', entityType: 'technology' });
    mockRecordFeedback.mockResolvedValue(undefined);
  });

  it('401s when unauthenticated and does not touch the store', async () => {
    mockGetAuth.mockResolvedValue({ authenticated: false, error: 'no auth' });
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(401);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('approve mints the entity and wires feedback on the appliedEntityId (its tag topic)', async () => {
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith('p1', 'u1');
    expect(mockRecordFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'entity',
      'tech-1',
      'technology',
      'approved',
      undefined
    );
  });

  it('reject records rejected feedback (falls back to the proposal id when no entity minted)', async () => {
    const res = await POST(req({ action: 'reject' }), ctx('p1'));
    expect(res.status).toBe(200);
    expect(mockReject).toHaveBeenCalledWith('p1', 'u1', undefined);
    expect(mockRecordFeedback).toHaveBeenCalledWith('u1', 'p1', 'entity', 'p1', 'technology', 'rejected', undefined);
  });

  it('rejects an unknown action with 400', async () => {
    const res = await POST(req({ action: 'frobnicate' }), ctx('p1'));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('a feedback-wire failure NEVER breaks the triage 200', async () => {
    mockRecordFeedback.mockRejectedValue(new Error('neo4j down'));
    const res = await POST(req({ action: 'approve' }), ctx('p1'));
    expect(res.status).toBe(200);
  });
});
