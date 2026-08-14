/**
 * @jest-environment node
 *
 * P0-T5 — assessment triage route + feedback wire. The feedback wire is
 * best-effort: a recorder failure must NEVER convert a 200 into a 500
 * (BLAST-#1, load-bearing).
 */
jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/proposed-assessments-admin', () => ({
  approveProposedAssessment: jest.fn(),
  rejectProposedAssessment: jest.fn(),
  dismissProposedAssessment: jest.fn(),
  isProposedAssessmentRadarAuthorizationError: jest.fn(),
}));
jest.mock('@/lib/discovery/discovery-feedback', () => ({ recordProposalFeedback: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as { getAuthenticatedUser: jest.Mock };
const admin = jest.requireMock('@/lib/proposed-assessments-admin') as {
  approveProposedAssessment: jest.Mock;
  rejectProposedAssessment: jest.Mock;
  dismissProposedAssessment: jest.Mock;
  isProposedAssessmentRadarAuthorizationError: jest.Mock;
};
const { recordProposalFeedback } = jest.requireMock('@/lib/discovery/discovery-feedback') as {
  recordProposalFeedback: jest.Mock;
};

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/triage/assessments/a1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
  });
}
const ctx = { params: Promise.resolve({ id: 'a1' }) };

describe('POST /api/triage/assessments/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordProposalFeedback.mockResolvedValue(undefined);
    admin.approveProposedAssessment.mockResolvedValue({ id: 'a1', technologyId: 't1', status: 'approved' });
    admin.rejectProposedAssessment.mockResolvedValue({ id: 'a1', technologyId: 't1', status: 'rejected' });
    admin.dismissProposedAssessment.mockResolvedValue({ id: 'a1', technologyId: 't1', status: 'dismissed' });
    admin.isProposedAssessmentRadarAuthorizationError.mockReturnValue(false);
  });

  it('approves (200) and records feedback with the technology topic', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'approve' }), ctx);
    expect(res.status).toBe(200);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'a1',
      'assessment',
      't1',
      'technology',
      'approved',
      undefined
    );
  });

  it('rejects (200) and records "rejected" with the feedback reason', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'reject', feedbackReason: 'low-quality' }), ctx);
    expect(res.status).toBe(200);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'a1',
      'assessment',
      't1',
      'technology',
      'rejected',
      'low-quality'
    );
  });

  it('dismisses (200) and records "dismissed"', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'dismiss' }), ctx);
    expect(res.status).toBe(200);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'a1',
      'assessment',
      't1',
      'technology',
      'dismissed',
      undefined
    );
  });

  it('returns 401 and does not record feedback when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await POST(req({ action: 'approve' }), ctx);
    expect(res.status).toBe(401);
    expect(admin.approveProposedAssessment).not.toHaveBeenCalled();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown action', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'frobnicate' }), ctx);
    expect(res.status).toBe(400);
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('returns the same 403 for a missing, foreign, or ownerless radar denial', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const denial = new Error('uniform owner denial');
    admin.approveProposedAssessment.mockRejectedValueOnce(denial);
    admin.isProposedAssessmentRadarAuthorizationError.mockImplementation((error) => error === denial);

    const res = await POST(req({ action: 'approve', radarId: 'radar-foreign', quadrantId: 'q1' }), ctx);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'You do not have permission to modify this radar.' });
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('drops an unrecognized feedback reason (validated against the reason-code enum)', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'reject', feedbackReason: 'totally-made-up' }), ctx);
    expect(res.status).toBe(200);
    expect(admin.rejectProposedAssessment).toHaveBeenCalledWith('a1', 'u1', undefined);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'a1',
      'assessment',
      't1',
      'technology',
      'rejected',
      undefined
    );
  });

  it('still returns 200 + the assessment when the feedback recorder throws (BLAST-#1)', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    recordProposalFeedback.mockRejectedValue(new Error('learning store down'));
    const res = await POST(req({ action: 'approve' }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.assessment).toMatchObject({ id: 'a1', status: 'approved' });
  });
});
