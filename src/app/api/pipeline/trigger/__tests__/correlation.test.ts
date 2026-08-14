/**
 * @file trigger/__tests__/correlation.test.ts
 * @description OBS-003 — the pipeline trigger joins the existing correlation
 * contract instead of minting a private request identity.
 *
 * The retained `TEST-027` finding: a manually triggered daily pipeline completed,
 * but its accepted request identity was not available as one durable
 * browser → event → job → graph correlation. The cause was concrete — this route
 * minted a bare `randomUUID()` `requestId`, never read the correlation header,
 * never echoed one, and never put a `correlationId` on the event, so the
 * job-run middleware (which already persists `event.data.correlationId` as a
 * top-level queryable field) had nothing to record.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { CORRELATION_ID_HEADER, isCorrelationId } from '@/lib/observability/correlation';
import { POST } from '../route';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));

const { inngest } = jest.requireMock('@/lib/inngest/client');

const SUPPLIED = 'corr_3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function request(correlationId?: string): NextRequest {
  const headers: Record<string, string> = { Authorization: 'Bearer test-token' };
  if (correlationId !== undefined) headers[CORRELATION_ID_HEADER] = correlationId;
  return new NextRequest('http://localhost:3000/api/pipeline/trigger', { method: 'POST', headers });
}

/** The event payload handed to Inngest on the Nth send (0-indexed). */
function sentEvent(call = 0): { name: string; id?: string; data: Record<string, unknown> } {
  return inngest.send.mock.calls[call][0];
}

describe('POST /api/pipeline/trigger correlation (OBS-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    inngest.send.mockResolvedValue(undefined);
  });

  it('carries an accepted correlation ID onto the event the job-run middleware reads', async () => {
    const res = await POST(request(SUPPLIED));
    const json = await res.json();

    expect(res.status).toBe(200);
    // `event.data.correlationId` is the exact field `job-run-tracking` parses,
    // so this is the wire that makes the request identity queryable on the run.
    expect(sentEvent().data.correlationId).toBe(SUPPLIED);
    expect(json.correlationId).toBe(SUPPLIED);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(SUPPLIED);
  });

  it('mints a strict correlation ID when the caller supplies none', async () => {
    const res = await POST(request());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(isCorrelationId(json.correlationId)).toBe(true);
    expect(sentEvent().data.correlationId).toBe(json.correlationId);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(json.correlationId);
  });

  it('reports exactly one request identity', async () => {
    // Two ids for one request is the defect this row exists to close: a bare
    // `requestId` that nothing downstream could join on, beside a correlation
    // token that everything downstream already understood.
    const json = await (await POST(request(SUPPLIED))).json();

    expect(json.requestId).toBe(SUPPLIED);
    expect(sentEvent().data.requestId).toBe(SUPPLIED);
  });

  it('rejects a malformed correlation ID instead of rewriting it', async () => {
    const res = await POST(request('not-a-correlation-id'));

    expect(res.status).toBe(400);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('makes replay deterministic by keying the event on the accepted identity', async () => {
    // Inngest de-duplicates on event `id`, so re-POSTing an accepted identity
    // cannot start a second pipeline run.
    await POST(request(SUPPLIED));
    await POST(request(SUPPLIED));

    expect(inngest.send).toHaveBeenCalledTimes(2);
    expect(sentEvent(0).id).toBe(SUPPLIED);
    expect(sentEvent(1).id).toBe(SUPPLIED);
  });

  it('gives two distinct requests distinct event identities', async () => {
    await POST(request());
    await POST(request());

    expect(sentEvent(0).id).not.toBe(sentEvent(1).id);
  });

  it('echoes the correlation ID on a failure so a lost trigger stays traceable', async () => {
    inngest.send.mockRejectedValueOnce(new Error('Inngest service down'));

    const res = await POST(request(SUPPLIED));

    expect(res.status).toBe(500);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(SUPPLIED);
  });
});
