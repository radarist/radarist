/** @jest-environment node */

/**
 * GRAPH-069 — the authenticated server-owned create/update handoff boundary.
 *
 * The delete branch of this route keeps its own suite (`route.test.ts`). This
 * one covers the branch the row added: a committed link asking the server to
 * hand its projection to Inngest, with authorization, owner provenance,
 * conflicting-replay refusal, and an honest committed-versus-pending answer.
 */

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/entity-document-link-sync-server', () => ({
  requestEntityDocumentLinkGraphDeletionsServer: jest.fn(),
  requestEntityDocumentLinkGraphSyncServer: jest.fn(),
}));
jest.mock('@/lib/entity-document-link-admin', () => ({ adminGetEntityDocumentLinkById: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';
import {
  ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT,
  ENTITY_DOCUMENT_LINK_HANDOFF_ERROR,
  EntityDocumentLinkSyncDispatchError,
  parseEntityDocumentLinkAnchorRecordedResponse,
} from '@/lib/entity-document-link-handoff';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as { getAuthenticatedUser: jest.Mock };
const { requestEntityDocumentLinkGraphSyncServer } = jest.requireMock('@/lib/entity-document-link-sync-server') as {
  requestEntityDocumentLinkGraphSyncServer: jest.Mock;
};
const { adminGetEntityDocumentLinkById } = jest.requireMock('@/lib/entity-document-link-admin') as {
  adminGetEntityDocumentLinkById: jest.Mock;
};

const LINK = { linkId: 'edl1_link', entityId: 'tech-1', documentId: 'doc-1' };

const authoritative = {
  id: LINK.linkId,
  entityType: 'technology',
  entityId: LINK.entityId,
  documentId: LINK.documentId,
  relationshipType: 'documentation',
  relevance: 'medium',
  tags: [],
  createdBy: 'user-1',
  updatedAt: 42,
};

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/graph/entity-document-link-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1' });
  adminGetEntityDocumentLinkById.mockResolvedValue(authoritative);
  requestEntityDocumentLinkGraphSyncServer.mockResolvedValue(undefined);
});

describe('POST /api/graph/entity-document-link-sync (create/update)', () => {
  it('rejects an unauthenticated handoff', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(401);
    expect(requestEntityDocumentLinkGraphSyncServer).not.toHaveBeenCalled();
  });

  it.each([
    ['extra top-level fields', { operation: 'create', link: LINK, unsafe: true }],
    ['extra link fields', { operation: 'create', link: { ...LINK, entityType: 'technology' } }],
    ['missing link', { operation: 'update' }],
    ['untrimmed endpoint', { operation: 'create', link: { ...LINK, entityId: ' tech-1' } }],
    ['delete smuggled into the single-link shape', { operation: 'delete', link: LINK }],
    ['a link batch on the create branch', { operation: 'create', links: [LINK] }],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(requestEntityDocumentLinkGraphSyncServer).not.toHaveBeenCalled();
  });

  it('dispatches through the shared server primitive and answers 202 acknowledged', async () => {
    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      handoff: 'acknowledged',
      operation: 'create',
      linkId: LINK.linkId,
    });
    expect(requestEntityDocumentLinkGraphSyncServer).toHaveBeenCalledWith(authoritative, 'create');
  });

  it('uses the same primitive for update', async () => {
    const response = await POST(request({ operation: 'update', link: LINK }));

    expect(response.status).toBe(202);
    expect(requestEntityDocumentLinkGraphSyncServer).toHaveBeenCalledWith(authoritative, 'update');
  });

  it('fails closed when the asserted endpoints no longer match Firestore', async () => {
    adminGetEntityDocumentLinkById.mockResolvedValueOnce({ ...authoritative, entityId: 'tech-moved' });

    const response = await POST(request({ operation: 'update', link: LINK }));

    expect(response.status).toBe(409);
    expect(requestEntityDocumentLinkGraphSyncServer).not.toHaveBeenCalled();
  });

  it('fails closed when the link no longer exists', async () => {
    adminGetEntityDocumentLinkById.mockResolvedValueOnce(null);

    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(409);
    expect(requestEntityDocumentLinkGraphSyncServer).not.toHaveBeenCalled();
  });

  it('refuses a cross-owner handoff', async () => {
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'someone-else' });

    const response = await POST(request({ operation: 'update', link: LINK }));

    expect(response.status).toBe(403);
    expect(requestEntityDocumentLinkGraphSyncServer).not.toHaveBeenCalled();
  });

  it('lets any authenticated caller hand off a system-owned link', async () => {
    adminGetEntityDocumentLinkById.mockResolvedValue({ ...authoritative, createdBy: 'system' });
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'someone-else' });

    const response = await POST(request({ operation: 'update', link: LINK }));

    expect(response.status).toBe(202);
  });

  it('lets any authenticated caller hand off a link with no recorded owner', async () => {
    adminGetEntityDocumentLinkById.mockResolvedValue({ ...authoritative, createdBy: undefined });
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'someone-else' });

    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(202);
  });

  it('answers 503 with a parseable anchor receipt when dispatch is refused', async () => {
    requestEntityDocumentLinkGraphSyncServer.mockRejectedValueOnce(
      new EntityDocumentLinkSyncDispatchError(LINK.linkId, new Error('queue unavailable'), true, 'create')
    );

    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe(ENTITY_DOCUMENT_LINK_HANDOFF_ERROR);
    expect(body.recovery.contract).toBe(ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT);
    expect(parseEntityDocumentLinkAnchorRecordedResponse(body, { target: LINK, operation: 'create' })).not.toBeNull();
  });

  it('does not claim an anchor the server failed to persist', async () => {
    requestEntityDocumentLinkGraphSyncServer.mockRejectedValueOnce(
      new EntityDocumentLinkSyncDispatchError(LINK.linkId, new Error('queue unavailable'), false, 'create')
    );

    const response = await POST(request({ operation: 'create', link: LINK }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.recovery).toBeUndefined();
    expect(body.error).toBe(ENTITY_DOCUMENT_LINK_HANDOFF_ERROR);
  });

  it('does not leak internal errors from an unexpected dispatch failure', async () => {
    requestEntityDocumentLinkGraphSyncServer.mockRejectedValueOnce(new Error('secret internal detail'));

    const response = await POST(request({ operation: 'update', link: LINK }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: ENTITY_DOCUMENT_LINK_HANDOFF_ERROR });
  });
});
