/**
 * @jest-environment node
 *
 * UX-036 — the ONE acknowledged reprocessing enqueue.
 *
 * What this route replaces: a client-SDK write of `status: 'uploaded'` that
 * emitted no event, called no API, and was reported to the user as "queued for
 * reprocessing". Nothing drains `uploaded` documents, so the work never
 * happened. The contract asserted below is therefore deliberately strict:
 * 202 ONLY after the queue acknowledges, and no half-states on refusal.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn().mockResolvedValue(undefined),
  // The claim is a Firestore TRANSACTION in production; here it is stubbed to
  // the contract the route depends on. Its atomicity is the point — a
  // read-then-check-then-write guard let two clicks both pass.
  adminClaimDocumentForProcessing: jest.fn(),
}));

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));

const { adminGetDocumentById, adminUpdateDocument, adminClaimDocumentForProcessing } =
  jest.requireMock('@/lib/document-admin');
const { inngest } = jest.requireMock('@/lib/inngest/client');

import { POST } from '../route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/documents/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

const FAILED_DOC = {
  id: 'doc-1',
  title: 'Broken URL doc',
  type: 'url',
  storageUrl: '',
  originalUrl: 'https://example.com/a',
  status: 'failed',
  errorMessage: 'Failed to fetch URL content: ECONNREFUSED',
  updatedAt: Date.now(),
};

describe('POST /api/documents/retry (UX-036)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminUpdateDocument.mockResolvedValue(undefined);
    inngest.send.mockResolvedValue({ ids: ['evt-1'] });
    // Default: the document is claimable. Individual tests override.
    adminClaimDocumentForProcessing.mockImplementation(
      async (_id: string, canClaim: (doc: unknown) => boolean, _requestedAt: number) => {
        const doc = await adminGetDocumentById();
        if (!doc) return { claimed: false, reason: 'not-found' };
        if (!canClaim(doc)) {
          return {
            claimed: false,
            reason: 'not-claimable',
            currentStatus: doc.status,
            currentRequestedAt: doc.processingRequestedAt ?? 0,
          };
        }
        return { claimed: true, previousStatus: doc.status, previousRequestedAt: doc.processingRequestedAt ?? 0 };
      }
    );
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const res = await POST(request({ documentId: 'doc-1' }));

    expect(res.status).toBe(401);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('returns 400 when documentId is missing', async () => {
    const res = await POST(request({}));

    expect(res.status).toBe(400);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown document', async () => {
    adminGetDocumentById.mockResolvedValue(null);

    const res = await POST(request({ documentId: 'nope' }));

    expect(res.status).toBe(404);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('enqueues the processing event and answers 202 with the acknowledged ids', async () => {
    adminGetDocumentById.mockResolvedValue(FAILED_DOC);

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toMatchObject({ accepted: true, documentId: 'doc-1', status: 'processing', eventIds: ['evt-1'] });
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/document.process.requested',
      data: expect.objectContaining({
        documentId: 'doc-1',
        requestedBy: 'user:test-user-123',
        trigger: 'retry',
      }),
    });
  });

  it('claims the document ATOMICALLY rather than reading, checking, then writing', async () => {
    adminGetDocumentById.mockResolvedValue(FAILED_DOC);

    await POST(request({ documentId: 'doc-1' }));

    // Regression: the guard was a read-then-check-then-write, so two clicks
    // inside that window both observed `failed`, both passed, and both
    // enqueued. The accepted-state write (including clearing the stale error
    // with '' rather than undefined) now happens inside the claim.
    expect(adminClaimDocumentForProcessing).toHaveBeenCalledWith('doc-1', expect.any(Function), expect.any(Number));
    expect(adminUpdateDocument).not.toHaveBeenCalled();
  });

  it('refuses BEFORE writing anything when there is nothing to reprocess from', async () => {
    // A deep-research artifact: created `processing`, no stored bytes, no
    // source URL, silent for minutes while its own pipeline polls. Enqueueing
    // could only mark healthy in-flight work failed.
    adminGetDocumentById.mockResolvedValue({
      id: 'doc-1',
      title: 'Deep research (running)',
      type: 'markdown',
      storageUrl: '',
      status: 'processing',
      updatedAt: Date.now() - 60 * 60 * 1000,
    });

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe('no-source');
    expect(adminClaimDocumentForProcessing).not.toHaveBeenCalled();
    expect(adminUpdateDocument).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('allows retrying a blocked document', async () => {
    adminGetDocumentById.mockResolvedValue({ ...FAILED_DOC, status: 'blocked' });

    const res = await POST(request({ documentId: 'doc-1' }));

    expect(res.status).toBe(202);
  });

  it('refuses to double-enqueue a live run', async () => {
    adminGetDocumentById.mockResolvedValue({
      ...FAILED_DOC,
      status: 'processing',
      processingRequestedAt: Date.now(),
    });

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.alreadyRunning).toBe(true);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('refuses a concurrent retry even when the first worker already terminalized', async () => {
    adminGetDocumentById.mockResolvedValue({
      ...FAILED_DOC,
      status: 'failed',
      processingRequestedAt: Date.now(),
    });

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.alreadyRunning).toBe(true);
    expect(json.error).toMatch(/accepted recently/i);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('does not claim a live run as "already running" when it simply has nothing to retry', async () => {
    adminGetDocumentById.mockResolvedValue({ ...FAILED_DOC, status: 'processed' });

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.alreadyRunning).toBe(false);
    expect(json.error).not.toMatch(/already running/i);
    expect(json.error).toMatch(/processed/);
  });

  it('allows recovery of a STALLED accepted run', async () => {
    adminGetDocumentById.mockResolvedValue({
      ...FAILED_DOC,
      status: 'processing',
      updatedAt: Date.now(),
      processingRequestedAt: Date.now() - 60 * 60 * 1000,
    });

    const res = await POST(request({ documentId: 'doc-1' }));

    expect(res.status).toBe(202);
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it('restores the previous status and answers 502 when the queue rejects the event', async () => {
    adminGetDocumentById.mockResolvedValue(FAILED_DOC);
    inngest.send.mockRejectedValueOnce(new Error('queue unreachable'));

    const res = await POST(request({ documentId: 'doc-1' }));
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error).toMatch(/did not accept/i);
    // Must NOT leave the document pretending to be in flight — and must also
    // restore the PREVIOUS accepted-run stamp. Leaving the fresh one behind
    // would make a document that was already stalled look live for another
    // staleness window, locking out the very recovery this route provides.
    expect(adminUpdateDocument).toHaveBeenLastCalledWith('doc-1', {
      status: 'failed',
      processingRequestedAt: 0,
      errorMessage: expect.stringMatching(/did not accept/i),
    });
  });

  it('treats an empty acknowledgement as a rejection', async () => {
    adminGetDocumentById.mockResolvedValue(FAILED_DOC);
    inngest.send.mockResolvedValueOnce({ ids: [] });

    const res = await POST(request({ documentId: 'doc-1' }));

    expect(res.status).toBe(502);
    expect(adminUpdateDocument).toHaveBeenLastCalledWith('doc-1', {
      status: 'failed',
      processingRequestedAt: 0,
      errorMessage: expect.stringMatching(/no acknowledgement/i),
    });
  });
});
