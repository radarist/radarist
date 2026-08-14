/**
 * @jest-environment node
 *
 * P0-T5 — relations triage route (admin-twin path). The admin twin
 * (`proposed-relations-admin.ts`) now owns discovery-feedback recording via
 * `options?: TriageFeedbackOptions { feedbackUserId }` — the route no longer
 * records feedback itself, it only forwards the authenticated user's id.
 * ProposedRelation has no owner field (global authed triage, same as
 * assessments), so the enforceable boundary is unauth -> 401. A twin failure
 * (e.g. relation-creation failure) must surface as a 500 — no silent success.
 */
jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/proposed-relations-admin', () => ({
  approveProposedRelationWithOutcome: jest.fn(),
  rejectProposedRelationWithOutcome: jest.fn(),
  dismissProposedRelation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/discovery/discovery-config', () => ({ getDiscoveryConfig: jest.fn() }));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: jest.fn() } }));
jest.mock('@/lib/graph/asserter-reliability', () => ({ recordAsserterOutcome: jest.fn() }));

import { NextRequest } from 'next/server';
import {
  CORRELATION_ID_HEADER,
  isCorrelationId,
} from '@/lib/observability/correlation';
import { POST } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as { getAuthenticatedUser: jest.Mock };
const admin = jest.requireMock('@/lib/proposed-relations-admin') as {
  approveProposedRelationWithOutcome: jest.Mock;
  rejectProposedRelationWithOutcome: jest.Mock;
  dismissProposedRelation: jest.Mock;
};
const { getDiscoveryConfig } = jest.requireMock('@/lib/discovery/discovery-config') as {
  getDiscoveryConfig: jest.Mock;
};
const { inngest } = jest.requireMock('@/lib/inngest/client') as { inngest: { send: jest.Mock } };
const { recordAsserterOutcome } = jest.requireMock('@/lib/graph/asserter-reliability') as {
  recordAsserterOutcome: jest.Mock;
};

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

function req(body: unknown, correlationId: string | null = TEST_CORRELATION_ID): NextRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer t',
  };
  if (correlationId !== null) headers[CORRELATION_ID_HEADER] = correlationId;
  return new NextRequest('http://localhost/api/triage/relations/r1', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}
const ctx = { params: Promise.resolve({ id: 'r1' }) };

describe('POST /api/triage/relations/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1' },
    });
    admin.rejectProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1' },
    });
    admin.dismissProposedRelation.mockResolvedValue({ id: 'r1', sourceId: 'src1', sourceType: 'technology' });
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    inngest.send.mockResolvedValue(undefined);
    recordAsserterOutcome.mockResolvedValue(undefined);
  });

  it('approves (200) — delegates feedback to the admin twin via feedbackUserId', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'approve' }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.relation).toMatchObject({ id: 'r1' });
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
    expect(admin.approveProposedRelationWithOutcome).toHaveBeenCalledWith('r1', 'u1', {
      feedbackUserId: 'u1',
      correlationId: TEST_CORRELATION_ID,
    });
  });

  it('rejects (200) — delegates feedbackReason + feedbackUserId to the admin twin', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'reject', feedbackReason: 'out-of-scope' }), ctx);
    expect(res.status).toBe(200);
    expect(admin.rejectProposedRelationWithOutcome).toHaveBeenCalledWith('r1', 'u1', 'out-of-scope', {
      feedbackUserId: 'u1',
      correlationId: TEST_CORRELATION_ID,
    });
  });

  it('dismisses (200) — delegates feedbackUserId to the admin twin', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'dismiss' }), ctx);
    expect(res.status).toBe(200);
    expect(admin.dismissProposedRelation).toHaveBeenCalledWith('r1', 'u1', {
      feedbackUserId: 'u1',
      correlationId: TEST_CORRELATION_ID,
    });
  });

  it('returns 400 for an unknown action', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    const res = await POST(req({ action: 'frobnicate' }), ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
    expect(admin.approveProposedRelationWithOutcome).not.toHaveBeenCalled();
  });

  it.each([
    ['null body', null],
    ['oversized feedback reason', { action: 'reject', feedbackReason: 'x'.repeat(1001) }],
    ['unknown fields', { action: 'approve', privatePayload: 'not accepted' }],
  ])('returns 400 for %s before triage mutation', async (_case, body) => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });

    const res = await POST(req(body), ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
    expect(admin.approveProposedRelationWithOutcome).not.toHaveBeenCalled();
    expect(admin.rejectProposedRelationWithOutcome).not.toHaveBeenCalled();
  });

  it('mints a correlation ID only when the authenticated request omits the header', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });

    const res = await POST(req({ action: 'approve' }, null), ctx);
    const minted = res.headers.get(CORRELATION_ID_HEADER);

    expect(res.status).toBe(200);
    expect(isCorrelationId(minted)).toBe(true);
    expect(admin.approveProposedRelationWithOutcome).toHaveBeenCalledWith('r1', 'u1', {
      feedbackUserId: 'u1',
      correlationId: minted,
    });
  });

  it('rejects an explicitly malformed correlation ID after authentication and before state change', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });

    const res = await POST(req({ action: 'approve' }, 'caller-controlled-text'), ctx);

    expect(res.status).toBe(400);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    expect(admin.approveProposedRelationWithOutcome).not.toHaveBeenCalled();
  });

  it('returns 401 with no state change when unauthenticated', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'no token' });
    const res = await POST(req({ action: 'approve' }, 'caller-controlled-text'), ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    expect(admin.approveProposedRelationWithOutcome).not.toHaveBeenCalled();
  });

  it('returns 500 when the twin fails loudly (relation not created)', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    admin.approveProposedRelationWithOutcome.mockRejectedValue(new Error('creation failed'));
    const res = await POST(req({ action: 'approve' }), ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(TEST_CORRELATION_ID);
  });
});

describe('POST /api/triage/relations/[id] — confidence recalibration (B3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1' },
    });
    admin.rejectProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1' },
    });
    admin.dismissProposedRelation.mockResolvedValue({ id: 'r1', sourceId: 'src1', sourceType: 'technology' });
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    inngest.send.mockResolvedValue(undefined);
    recordAsserterOutcome.mockResolvedValue(undefined);
  });

  it('approve sends app/relation.feedback.requested (up, expectMaterialized) when DISCOVERY_FEEDBACK_ENABLED', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });

    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/relation.feedback.requested',
      data: {
        correlationId: TEST_CORRELATION_ID,
        relationId: 'rel-1',
        direction: 'up',
        expectMaterialized: true,
      },
    });
  });

  it('skips the feedback event when the flag is off', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: false });

    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('a send failure never breaks the triage response', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    inngest.send.mockRejectedValue(new Error('inngest down'));

    const res = await POST(req({ action: 'approve' }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.relation).toMatchObject({ id: 'r1' });
  });

  it('does not dispatch feedback or reliability twice for an idempotent terminal replay', async () => {
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: false,
      proposal: {
        id: 'r1',
        sourceId: 'src1',
        sourceType: 'technology',
        relationId: 'rel-1',
        discoveredBy: 'linker-agent',
      },
    });

    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).not.toHaveBeenCalled();
    expect(recordAsserterOutcome).not.toHaveBeenCalled();
  });

  it('reject sends the feedback event (down, expectMaterialized: false) only when the proposal has a materialized relationId', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    admin.rejectProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1' },
    });

    const res = await POST(req({ action: 'reject' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/relation.feedback.requested',
      data: {
        correlationId: TEST_CORRELATION_ID,
        relationId: 'rel-1',
        direction: 'down',
        expectMaterialized: false,
      },
    });
  });

  it('reject is a no-op (no feedback event) when the proposal has no relationId', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    admin.rejectProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology' },
    });

    const res = await POST(req({ action: 'reject' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('dismiss never sends a feedback event', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });

    const res = await POST(req({ action: 'dismiss' }), ctx);

    expect(res.status).toBe(200);
    expect(inngest.send).not.toHaveBeenCalled();
  });
});

describe('POST /api/triage/relations/[id] — asserter outcome recording (C4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'u1' });
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: {
        id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1', discoveredBy: 'linker-agent',
      },
    });
    admin.rejectProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: {
        id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1', discoveredBy: 'auto-linker',
      },
    });
    admin.dismissProposedRelation.mockResolvedValue({ id: 'r1', sourceId: 'src1', sourceType: 'technology' });
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: true });
    inngest.send.mockResolvedValue(undefined);
    recordAsserterOutcome.mockResolvedValue(undefined);
  });

  it('records an "approved" outcome for the discovering agent (agent:<name> key)', async () => {
    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(recordAsserterOutcome).toHaveBeenCalledWith('agent:linker', 'approved');
  });

  it('records a "rejected" outcome for the discovering agent', async () => {
    const res = await POST(req({ action: 'reject' }), ctx);

    expect(res.status).toBe(200);
    expect(recordAsserterOutcome).toHaveBeenCalledWith('agent:auto-linker', 'rejected');
  });

  it("maps 'ai-assistant' discoveredBy to the 'agent:assistant' key", async () => {
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: {
        id: 'r1', sourceId: 'src1', sourceType: 'technology', relationId: 'rel-1', discoveredBy: 'ai-assistant',
      },
    });

    await POST(req({ action: 'approve' }), ctx);

    expect(recordAsserterOutcome).toHaveBeenCalledWith('agent:assistant', 'approved');
  });

  it('skips recording when the feedback flag is off', async () => {
    getDiscoveryConfig.mockReturnValue({ feedbackEnabled: false });

    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(recordAsserterOutcome).not.toHaveBeenCalled();
  });

  it('skips recording (no-op) when the proposal has no discoveredBy', async () => {
    admin.approveProposedRelationWithOutcome.mockResolvedValue({
      transitioned: true,
      proposal: { id: 'r1', sourceId: 'src1', sourceType: 'technology' },
    });

    const res = await POST(req({ action: 'approve' }), ctx);

    expect(res.status).toBe(200);
    expect(recordAsserterOutcome).not.toHaveBeenCalled();
  });

  it('a recording failure never breaks the triage response (still 200)', async () => {
    recordAsserterOutcome.mockRejectedValue(new Error('neo4j down'));

    const res = await POST(req({ action: 'approve' }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.relation).toMatchObject({ id: 'r1' });
  });

  it('dismiss never records an outcome', async () => {
    const res = await POST(req({ action: 'dismiss' }), ctx);

    expect(res.status).toBe(200);
    expect(recordAsserterOutcome).not.toHaveBeenCalled();
  });
});
