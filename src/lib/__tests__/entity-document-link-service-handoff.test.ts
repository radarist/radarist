/**
 * @file lib/__tests__/entity-document-link-service-handoff.test.ts
 * @description GRAPH-069 — the browser link service must route create AND
 * update through the one server-owned handoff and report the honest result.
 *
 * The regression these lock down: the service used to `inngest.send()` directly
 * from the page inside a bare `catch {}`, so the mutation resolved as a plain
 * success whether or not anything ever reached the graph.
 */

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => ({ __collection: true })),
  doc: jest.fn((_db: unknown, _c: string, id: string) => ({ __doc: id })),
  getDoc: jest.fn(),
  getDocs: jest.fn(),
  addDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn((...args: unknown[]) => args),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  runTransaction: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => 1_000 })),
    fromMillis: jest.fn((ms: number) => ({ toMillis: () => ms })),
  },
}));
jest.mock('../firebase', () => ({ db: {} }));
jest.mock('../fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('../document-service', () => ({
  getDocumentById: jest.fn(),
  updateDocument: jest.fn(),
  updateLinkedEntityCount: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const requestEntityDocumentLinkGraphHandoff = jest.fn();
jest.mock('@/lib/entity-document-link-handoff-client', () => ({
  requestEntityDocumentLinkGraphHandoff: (...args: unknown[]) => requestEntityDocumentLinkGraphHandoff(...args),
}));

// A direct browser send is the defect. Fail loudly if anything reintroduces it.
const directInngestSend = jest.fn(() => {
  throw new Error('the browser link service must not dispatch to Inngest directly');
});
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: directInngestSend } }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn(), send: directInngestSend },
}));

import { createEntityDocumentLink, updateEntityDocumentLink } from '../entity-document-link-service';
import { updateLinkedEntityCount } from '../document-service';

const firestore = jest.requireMock('firebase/firestore') as {
  getDoc: jest.Mock;
  getDocs: jest.Mock;
  addDoc: jest.Mock;
  updateDoc: jest.Mock;
};

const STORED = {
  workspaceId: 'default',
  entityType: 'technology',
  entityId: 'tech-1',
  documentId: 'doc-1',
  relationshipType: 'documentation',
  tags: [],
  relevance: 'medium',
  createdBy: 'user-1',
  createdAt: { toMillis: () => 1_000 },
  updatedAt: { toMillis: () => 1_000 },
  graphSyncStatus: 'pending',
};

const INPUT = {
  workspaceId: 'default',
  entityType: 'technology' as const,
  entityId: 'tech-1',
  documentId: 'doc-1',
  relationshipType: 'documentation' as const,
  tags: [],
  relevance: 'medium' as const,
  createdBy: 'user-1',
};

function docSnapshot(id: string) {
  return { exists: () => true, id, data: () => STORED };
}

beforeEach(() => {
  jest.clearAllMocks();
  requestEntityDocumentLinkGraphHandoff.mockResolvedValue({ status: 'acknowledged' });
  // findExistingLink -> no duplicate
  firestore.getDocs.mockResolvedValue({ empty: true, docs: [] });
  firestore.addDoc.mockResolvedValue({ id: 'edl-new' });
  firestore.getDoc.mockResolvedValue(docSnapshot('edl-new'));
  firestore.updateDoc.mockResolvedValue(undefined);
  (updateLinkedEntityCount as jest.Mock).mockResolvedValue(undefined);
});

describe('createEntityDocumentLink graph handoff', () => {
  it('hands the committed link to the server boundary and reports acknowledgement', async () => {
    const result = await createEntityDocumentLink(INPUT);

    expect(result.link.id).toBe('edl-new');
    expect(result.graphHandoff).toEqual({ status: 'acknowledged' });
    expect(requestEntityDocumentLinkGraphHandoff).toHaveBeenCalledWith(
      { linkId: 'edl-new', entityId: 'tech-1', documentId: 'doc-1' },
      'create'
    );
    expect(directInngestSend).not.toHaveBeenCalled();
  });

  it('reports pending-reconciliation instead of a plain success when the handoff fails', async () => {
    requestEntityDocumentLinkGraphHandoff.mockResolvedValue({
      status: 'pending-reconciliation',
      reason: 'queue unavailable',
      anchorRecorded: true,
    });

    const result = await createEntityDocumentLink(INPUT);

    // The link IS committed — this must never surface as a failed mutation…
    expect(result.link.id).toBe('edl-new');
    // …and must never surface as a completed graph projection either.
    expect(result.graphHandoff).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: true });
  });

  it('surfaces a refused handoff without pretending the graph is converging', async () => {
    requestEntityDocumentLinkGraphHandoff.mockResolvedValue({ status: 'refused', reason: 'endpoints changed' });

    const result = await createEntityDocumentLink(INPUT);

    expect(result.graphHandoff).toEqual({ status: 'refused', reason: 'endpoints changed' });
  });

  it('still rejects a duplicate link before any handoff is attempted', async () => {
    firestore.getDocs.mockResolvedValue({ empty: false, docs: [docSnapshot('edl-existing')] });

    await expect(createEntityDocumentLink(INPUT)).rejects.toThrow('Link already exists');
    expect(requestEntityDocumentLinkGraphHandoff).not.toHaveBeenCalled();
  });
});

describe('updateEntityDocumentLink graph handoff', () => {
  it('uses the same primitive as create, with the update operation', async () => {
    const result = await updateEntityDocumentLink('edl-new', { relevance: 'high' });

    expect(firestore.updateDoc).toHaveBeenCalled();
    expect(requestEntityDocumentLinkGraphHandoff).toHaveBeenCalledWith(
      { linkId: 'edl-new', entityId: 'tech-1', documentId: 'doc-1' },
      'update'
    );
    expect(result.graphHandoff).toEqual({ status: 'acknowledged' });
    expect(directInngestSend).not.toHaveBeenCalled();
  });

  it('reports pending-reconciliation when the update handoff is not acknowledged', async () => {
    requestEntityDocumentLinkGraphHandoff.mockResolvedValue({
      status: 'pending-reconciliation',
      reason: 'offline',
      anchorRecorded: false,
    });

    const result = await updateEntityDocumentLink('edl-new', { relevance: 'low' });

    expect(result.graphHandoff).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: false });
  });

  it('refuses the handoff when the row vanished between commit and read-back', async () => {
    firestore.getDoc.mockResolvedValue({ exists: () => false, id: 'edl-new', data: () => undefined });

    const result = await updateEntityDocumentLink('edl-new', { relevance: 'low' });

    expect(result.graphHandoff.status).toBe('refused');
    expect(requestEntityDocumentLinkGraphHandoff).not.toHaveBeenCalled();
  });
});
