/** @jest-environment node */

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/entity-document-link-sync-server', () => ({
  requestEntityDocumentLinkGraphDeletionsServer: jest.fn(),
}));
jest.mock('@/lib/entity-document-link-admin', () => ({ adminGetEntityDocumentLinkById: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { requestEntityDocumentLinkGraphDeletionsServer } = jest.requireMock(
  '@/lib/entity-document-link-sync-server'
) as { requestEntityDocumentLinkGraphDeletionsServer: jest.Mock };
const { adminGetEntityDocumentLinkById } = jest.requireMock('@/lib/entity-document-link-admin') as {
  adminGetEntityDocumentLinkById: jest.Mock;
};

const links = [
  { linkId: 'link-1', entityId: 'entity-1', documentId: 'document-1' },
  { linkId: 'link-2', entityId: 'entity-2', documentId: 'document-2' },
];

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/graph/entity-document-link-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/graph/entity-document-link-sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1' });
    requestEntityDocumentLinkGraphDeletionsServer.mockResolvedValue({
      acknowledged: links.map(({ linkId }) => linkId),
      failed: [],
    });
    adminGetEntityDocumentLinkById.mockImplementation(async (linkId: string) => {
      const target = links.find((link) => link.linkId === linkId)!;
      return { id: target.linkId, entityId: target.entityId, documentId: target.documentId };
    });
  });

  it('rejects unauthenticated destructive handoffs', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const response = await POST(request({ operation: 'delete', links }));

    expect(response.status).toBe(401);
    expect(requestEntityDocumentLinkGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it.each([
    ['extra fields', { operation: 'delete', links, unsafe: true }],
    ['wrong operation', { operation: 'update', links }],
    ['duplicate IDs', { operation: 'delete', links: [links[0], links[0]] }],
    ['empty batch', { operation: 'delete', links: [] }],
    [
      'over-limit batch',
      {
        operation: 'delete',
        links: Array.from({ length: 201 }, (_, index) => ({
          linkId: `link-${index}`,
          entityId: `entity-${index}`,
          documentId: `document-${index}`,
        })),
      },
    ],
    [
      'untrimmed endpoint',
      { operation: 'delete', links: [{ linkId: ' link-1', entityId: 'entity-1', documentId: 'document-1' }] },
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(requestEntityDocumentLinkGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it('passes one exact validated chunk to the server dispatcher', async () => {
    const response = await POST(request({ operation: 'delete', links }));

    expect(response.status).toBe(202);
    expect(requestEntityDocumentLinkGraphDeletionsServer).toHaveBeenCalledTimes(1);
    expect(requestEntityDocumentLinkGraphDeletionsServer).toHaveBeenCalledWith(links);
  });

  it('rejects client-supplied endpoints that differ from authoritative Firestore data', async () => {
    adminGetEntityDocumentLinkById.mockResolvedValueOnce({
      id: 'link-1',
      entityId: 'different-entity',
      documentId: 'document-1',
    });

    const response = await POST(request({ operation: 'delete', links }));

    expect(response.status).toBe(409);
    expect(requestEntityDocumentLinkGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it('reports partial server acceptance without hiding failed link IDs', async () => {
    requestEntityDocumentLinkGraphDeletionsServer.mockResolvedValueOnce({
      acknowledged: ['link-1'],
      failed: [{ linkId: 'link-2', error: new Error('queue unavailable') }],
    });

    const response = await POST(request({ operation: 'delete', links }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: false,
      acknowledged: ['link-1'],
      failed: ['link-2'],
    });
  });
});
