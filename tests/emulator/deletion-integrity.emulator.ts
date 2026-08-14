/**
 * Lane A deletion-integrity contracts (UX-012 / UX-013).
 *
 * This suite runs only against the disposable Firestore emulator project. It
 * mocks delivery at the Inngest boundary, but exercises the real Admin SDK
 * queries, transactions, subcollection cleanup, and write batches used by the
 * production deletion services.
 */

const PROJECT_ID = 'demo-radarist';
const LOOPBACK_EMULATOR_HOST = /^(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+$/;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('deletion-integrity.emulator.ts requires NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`deletion-integrity.emulator.ts requires project ${PROJECT_ID}`);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('deletion-integrity.emulator.ts requires FIRESTORE_EMULATOR_HOST');
}
if (!LOOPBACK_EMULATOR_HOST.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  throw new Error('deletion-integrity.emulator.ts requires a loopback Firestore emulator');
}
if (!AUTH_HOST || !LOOPBACK_EMULATOR_HOST.test(AUTH_HOST)) {
  throw new Error('deletion-integrity.emulator.ts requires a loopback Auth emulator');
}

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn() },
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));
jest.mock('@/lib/graph/neo4j-graph-service', () => ({
  getNeo4jGraphService: () => ({ isHealthy: jest.fn().mockResolvedValue(false) }),
}));

import { NextRequest } from 'next/server';
import { POST as deleteCompanies } from '@/app/api/companies/bulk-delete/route';
import { db as adminDb } from '@/lib/firebase-admin';
import { adminDeleteDocument, SYSTEM_DOCUMENT_DELETE_PRINCIPAL } from '@/lib/document-admin';
import { inngest as requiredGraphInngest } from '@/lib/inngest/send-client';
import { inngest as workerGraphInngest } from '@/lib/inngest/client';

interface InngestEvent {
  name: string;
  data: Record<string, unknown>;
}

const requiredGraphSend = requiredGraphInngest.send as unknown as jest.Mock<
  Promise<{ ids: string[] }>,
  [InngestEvent]
>;
const workerGraphSend = workerGraphInngest.send as unknown as jest.Mock<
  Promise<{ ids: string[] }>,
  [InngestEvent]
>;

const RUN = `lane-a-delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SEEDED_PATHS = new Set<string>();
let authIdToken: string;

function disposableId(label: string): string {
  return `${RUN}-${label}`;
}

function assertDisposablePath(path: string): void {
  if (!path.includes(RUN)) {
    throw new Error(`Refusing to seed or clean a non-disposable path: ${path}`);
  }
}

async function seedDocuments(
  entries: readonly { path: string; data: Record<string, unknown> }[]
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += 450) {
    const chunk = entries.slice(offset, offset + 450);
    const batch = adminDb.batch();
    for (const entry of chunk) {
      assertDisposablePath(entry.path);
      SEEDED_PATHS.add(entry.path);
      batch.set(adminDb.doc(entry.path), entry.data);
    }
    await batch.commit();
  }
}

function linkFixture(
  id: string,
  entityType: 'company' | 'document',
  entityId: string,
  documentId: string
): { path: string; data: Record<string, unknown> } {
  const now = Date.now();
  return {
    path: `entityDocumentLinks/${id}`,
    data: {
      id,
      workspaceId: 'default',
      entityType,
      entityId,
      documentId,
      relationshipType: 'documentation',
      tags: [],
      relevance: 'high',
      aiSuggested: false,
      createdAt: now,
      createdBy: `emulator-${RUN}`,
      updatedAt: now,
      graphSyncStatus: 'pending',
    },
  };
}

function documentFixture(
  id: string,
  linkedEntityCount: number,
  marker: string
): { path: string; data: Record<string, unknown> } {
  const now = Date.now();
  return {
    path: `documents/${id}`,
    data: {
      id,
      title: `Deletion contract ${id}`,
      type: 'url',
      status: 'ready',
      tags: [],
      linkedEntityCount,
      marker,
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function signUpEmulatorUser(): Promise<string> {
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${RUN}@radarist.local`,
        password: `emulator-password-${RUN}`,
        returnSecureToken: true,
      }),
    }
  );
  const body = (await response.json()) as { idToken?: string; error?: unknown };
  if (!response.ok || !body.idToken) {
    throw new Error(`Auth emulator sign-up failed (${response.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  return body.idToken;
}

beforeAll(async () => {
  authIdToken = await signUpEmulatorUser();
});

beforeEach(() => {
  requiredGraphSend.mockReset();
  workerGraphSend.mockReset();
  requiredGraphSend.mockResolvedValue({ ids: [`required-graph-${RUN}`] });
  workerGraphSend.mockResolvedValue({ ids: [`worker-graph-${RUN}`] });
});

afterAll(async () => {
  try {
    const paths = [...SEEDED_PATHS];
    for (let offset = 0; offset < paths.length; offset += 450) {
      const batch = adminDb.batch();
      for (const path of paths.slice(offset, offset + 450)) {
        assertDisposablePath(path);
        batch.delete(adminDb.doc(path));
      }
      await batch.commit();
    }

    const leftovers = (
      await Promise.all(paths.map(async (path) => ((await adminDb.doc(path).get()).exists ? path : null)))
    ).filter((path): path is string => path !== null);
    if (leftovers.length > 0) {
      throw new Error(`Deletion-integrity emulator cleanup left fixtures: ${leftovers.join(', ')}`);
    }
  } finally {
    try {
      if (authIdToken) {
        const response = await fetch(
          `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:delete?key=emulator-only-key`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: authIdToken }),
          }
        );
        if (!response.ok) {
          throw new Error(`Auth emulator cleanup failed (${response.status})`);
        }
      }
    } finally {
      await adminDb.terminate();
    }
  }
});

describe('Company bulk deletion integrity', () => {
  it('retains only the company whose link handoff fails and leaves unrelated fixtures unchanged', async () => {
    const failedCompanyId = disposableId('company-link-failure');
    const deletedCompanyId = disposableId('company-deleted');
    const unrelatedCompanyId = disposableId('company-unrelated');
    const failedDocumentId = disposableId('document-link-failure');
    const deletedDocumentId = disposableId('document-link-deleted');
    const unrelatedDocumentId = disposableId('document-unrelated');
    const failedLinkId = disposableId('link-failure');
    const deletedLinkId = disposableId('link-deleted');
    const unrelatedLinkId = disposableId('link-unrelated');
    const failedNoteId = disposableId('note-link-failure');
    const deletedNoteId = disposableId('note-deleted');
    const unrelatedNoteId = disposableId('note-unrelated');
    const now = Date.now();

    await seedDocuments([
      {
        path: `companies/${failedCompanyId}`,
        data: { id: failedCompanyId, name: 'Retained company', marker: 'failed-parent', createdAt: now, updatedAt: now },
      },
      {
        path: `companies/${deletedCompanyId}`,
        data: { id: deletedCompanyId, name: 'Deleted company', marker: 'deleted-parent', createdAt: now, updatedAt: now },
      },
      {
        path: `companies/${unrelatedCompanyId}`,
        data: { id: unrelatedCompanyId, name: 'Unrelated company', marker: 'unrelated-parent', createdAt: now, updatedAt: now },
      },
      {
        path: `companies/${failedCompanyId}/notes/${failedNoteId}`,
        data: { id: failedNoteId, content: 'Must remain', marker: 'failed-note' },
      },
      {
        path: `companies/${deletedCompanyId}/notes/${deletedNoteId}`,
        data: { id: deletedNoteId, content: 'Must be deleted', marker: 'deleted-note' },
      },
      {
        path: `companies/${unrelatedCompanyId}/notes/${unrelatedNoteId}`,
        data: { id: unrelatedNoteId, content: 'Must remain unrelated', marker: 'unrelated-note' },
      },
      documentFixture(failedDocumentId, 1, 'failed-document'),
      documentFixture(deletedDocumentId, 1, 'deleted-document'),
      documentFixture(unrelatedDocumentId, 1, 'unrelated-document'),
      linkFixture(failedLinkId, 'company', failedCompanyId, failedDocumentId),
      linkFixture(deletedLinkId, 'company', deletedCompanyId, deletedDocumentId),
      linkFixture(unrelatedLinkId, 'company', unrelatedCompanyId, unrelatedDocumentId),
    ]);

    requiredGraphSend.mockImplementation(async (event) => {
      if (
        event.name === 'app/entity-document-link.sync.requested' &&
        event.data.operation === 'delete' &&
        event.data.linkId === failedLinkId
      ) {
        throw new Error(`intentional handoff failure for ${failedLinkId}`);
      }
      return { ids: [`accepted-${RUN}`] };
    });

    const response = await deleteCompanies(
      new NextRequest('http://localhost/api/companies/bulk-delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authIdToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: [failedCompanyId, deletedCompanyId] }),
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: false,
      deleted: 1,
      failed: [failedCompanyId],
      relationsDeleted: 0,
    });

    const [failedParent, failedNote, failedLink, failedDocument] = await Promise.all([
      adminDb.doc(`companies/${failedCompanyId}`).get(),
      adminDb.doc(`companies/${failedCompanyId}/notes/${failedNoteId}`).get(),
      adminDb.doc(`entityDocumentLinks/${failedLinkId}`).get(),
      adminDb.doc(`documents/${failedDocumentId}`).get(),
    ]);
    expect(failedParent.data()?.marker).toBe('failed-parent');
    expect(failedNote.data()?.marker).toBe('failed-note');
    expect(failedLink.exists).toBe(true);
    expect(failedDocument.data()?.linkedEntityCount).toBe(1);

    const [deletedParent, deletedNote, deletedLink, deletedDocument] = await Promise.all([
      adminDb.doc(`companies/${deletedCompanyId}`).get(),
      adminDb.doc(`companies/${deletedCompanyId}/notes/${deletedNoteId}`).get(),
      adminDb.doc(`entityDocumentLinks/${deletedLinkId}`).get(),
      adminDb.doc(`documents/${deletedDocumentId}`).get(),
    ]);
    expect(deletedParent.exists).toBe(false);
    expect(deletedNote.exists).toBe(false);
    expect(deletedLink.exists).toBe(false);
    expect(deletedDocument.data()?.linkedEntityCount).toBe(0);

    const [unrelatedParent, unrelatedNote, unrelatedLink, unrelatedDocument] = await Promise.all([
      adminDb.doc(`companies/${unrelatedCompanyId}`).get(),
      adminDb.doc(`companies/${unrelatedCompanyId}/notes/${unrelatedNoteId}`).get(),
      adminDb.doc(`entityDocumentLinks/${unrelatedLinkId}`).get(),
      adminDb.doc(`documents/${unrelatedDocumentId}`).get(),
    ]);
    expect(unrelatedParent.data()?.marker).toBe('unrelated-parent');
    expect(unrelatedNote.data()?.marker).toBe('unrelated-note');
    expect(unrelatedLink.exists).toBe(true);
    expect(unrelatedDocument.data()).toMatchObject({ marker: 'unrelated-document', linkedEntityCount: 1 });
  });
});

describe('Document endpoint deletion integrity', () => {
  it('unions inbound and outgoing links, deduplicates a self-link, and decrements surviving counters once', async () => {
    const deletedDocumentId = disposableId('document-endpoint-deleted');
    const survivingDocumentId = disposableId('document-endpoint-survivor');
    const unrelatedDocumentId = disposableId('document-endpoint-unrelated');
    const inboundCompanyId = disposableId('company-document-inbound');
    const unrelatedCompanyId = disposableId('company-document-unrelated');
    const outgoingLinkId = disposableId('link-document-outgoing');
    const inboundLinkId = disposableId('link-document-inbound');
    const selfLinkId = disposableId('link-document-self');
    const unrelatedLinkId = disposableId('link-document-endpoint-unrelated');

    await seedDocuments([
      documentFixture(deletedDocumentId, 2, 'deleted-endpoint-document'),
      documentFixture(survivingDocumentId, 1, 'surviving-endpoint-document'),
      documentFixture(unrelatedDocumentId, 1, 'unrelated-endpoint-document'),
      {
        path: `companies/${inboundCompanyId}`,
        data: { id: inboundCompanyId, name: 'Inbound link company', marker: 'inbound-company' },
      },
      {
        path: `companies/${unrelatedCompanyId}`,
        data: { id: unrelatedCompanyId, name: 'Unrelated link company', marker: 'unrelated-company' },
      },
      linkFixture(outgoingLinkId, 'document', deletedDocumentId, survivingDocumentId),
      linkFixture(inboundLinkId, 'company', inboundCompanyId, deletedDocumentId),
      linkFixture(selfLinkId, 'document', deletedDocumentId, deletedDocumentId),
      linkFixture(unrelatedLinkId, 'company', unrelatedCompanyId, unrelatedDocumentId),
    ]);

    await adminDeleteDocument(deletedDocumentId, SYSTEM_DOCUMENT_DELETE_PRINCIPAL);

    const [deletedDocument, survivingDocument, unrelatedDocument] = await Promise.all([
      adminDb.doc(`documents/${deletedDocumentId}`).get(),
      adminDb.doc(`documents/${survivingDocumentId}`).get(),
      adminDb.doc(`documents/${unrelatedDocumentId}`).get(),
    ]);
    expect(deletedDocument.exists).toBe(false);
    expect(survivingDocument.data()).toMatchObject({
      marker: 'surviving-endpoint-document',
      linkedEntityCount: 0,
    });
    expect(unrelatedDocument.data()).toMatchObject({
      marker: 'unrelated-endpoint-document',
      linkedEntityCount: 1,
    });

    const [outgoingLink, inboundLink, selfLink, unrelatedLink] = await Promise.all([
      adminDb.doc(`entityDocumentLinks/${outgoingLinkId}`).get(),
      adminDb.doc(`entityDocumentLinks/${inboundLinkId}`).get(),
      adminDb.doc(`entityDocumentLinks/${selfLinkId}`).get(),
      adminDb.doc(`entityDocumentLinks/${unrelatedLinkId}`).get(),
    ]);
    expect(outgoingLink.exists).toBe(false);
    expect(inboundLink.exists).toBe(false);
    expect(selfLink.exists).toBe(false);
    expect(unrelatedLink.exists).toBe(true);

    const linkDeleteIds = requiredGraphSend.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.name === 'app/entity-document-link.sync.requested' && event.data.operation === 'delete'
      )
      .map((event) => event.data.linkId);
    expect(linkDeleteIds).toHaveLength(3);
    expect(linkDeleteIds).toEqual(expect.arrayContaining([outgoingLinkId, inboundLinkId, selfLinkId]));
    expect(linkDeleteIds.filter((id) => id === selfLinkId)).toHaveLength(1);
    expect(linkDeleteIds).not.toContain(unrelatedLinkId);

    expect(workerGraphSend).toHaveBeenCalledWith({
      name: 'app/document.sync.requested',
      data: { documentId: deletedDocumentId, operation: 'delete' },
    });
  });
});
