/**
 * Real Firestore acceptance for atomic server-side entity-document-link
 * creation. All IDs are run-scoped and cleanup is restricted to those IDs.
 */

const PROJECT_ID = 'demo-radarist';
const LOOPBACK_EMULATOR_HOST = /^(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+$/;
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('entity-document-link-admin-create.emulator.ts requires emulator mode');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`entity-document-link-admin-create.emulator.ts requires project ${PROJECT_ID}`);
}
if (!emulatorHost || !LOOPBACK_EMULATOR_HOST.test(emulatorHost)) {
  throw new Error('entity-document-link-admin-create.emulator.ts requires a loopback Firestore emulator');
}

const mockInngestSend = jest.fn();
// GRAPH-069 moved link dispatch onto the shared server primitive, which uses the
// middleware-free send client. Both are stubbed so a regression back to the old
// lane surfaces as an unexpected call rather than a silent pass — and so a real
// unacknowledged send cannot leave a recovery anchor this suite never cleans up.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { adminCreateEntityDocumentLink } from '@/lib/entity-document-link-admin';
import type { CreateEntityDocumentLinkInput } from '@/lib/types';

const RUN = `atomic-edl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CREATED_BY = `emulator:${RUN}`;
const DOCUMENT_IDS = new Set<string>();

function documentId(label: string): string {
  const id = `${RUN}-${label}`;
  DOCUMENT_IDS.add(id);
  return id;
}

function input(documentIdValue: string, entityId: string): CreateEntityDocumentLinkInput {
  return {
    workspaceId: 'default',
    entityType: 'technology',
    entityId,
    documentId: documentIdValue,
    relationshipType: 'documentation',
    tags: [],
    relevance: 'high',
    aiSuggested: false,
    createdBy: CREATED_BY,
  };
}

async function seedDocument(id: string): Promise<void> {
  await db.collection('documents').doc(id).set({
    id,
    title: `Atomic link contract ${id}`,
    linkedEntityCount: 0,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

async function linksFor(documentIdValue: string) {
  return db.collection('entityDocumentLinks').where('documentId', '==', documentIdValue).get();
}

beforeEach(() => {
  mockInngestSend.mockReset();
  mockInngestSend.mockResolvedValue({ ids: [`sync-${RUN}`] });
});

afterAll(async () => {
  const links = await db.collection('entityDocumentLinks').where('createdBy', '==', CREATED_BY).get();
  const batch = db.batch();
  for (const link of links.docs) batch.delete(link.ref);
  for (const id of DOCUMENT_IDS) batch.delete(db.collection('documents').doc(id));
  await batch.commit();
});

describe('adminCreateEntityDocumentLink against Firestore emulator', () => {
  it('commits one identical concurrent link, one count increment, and one sync', async () => {
    const docId = documentId('identical');
    await seedDocument(docId);
    const createInput = input(docId, `${RUN}-tech-identical`);

    const outcomes = await Promise.allSettled([
      adminCreateEntityDocumentLink(createInput),
      adminCreateEntityDocumentLink(createInput),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toEqual(expect.objectContaining({ message: expect.stringContaining('Link already exists') }));
    expect((await linksFor(docId)).size).toBe(1);
    expect((await db.collection('documents').doc(docId).get()).data()?.linkedEntityCount).toBe(1);
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
  });

  it('preserves both counter increments for distinct concurrent links', async () => {
    const docId = documentId('distinct');
    await seedDocument(docId);

    await Promise.all([
      adminCreateEntityDocumentLink(input(docId, `${RUN}-tech-a`)),
      adminCreateEntityDocumentLink(input(docId, `${RUN}-tech-b`)),
    ]);

    expect((await linksFor(docId)).size).toBe(2);
    expect((await db.collection('documents').doc(docId).get()).data()?.linkedEntityCount).toBe(2);
    expect(mockInngestSend).toHaveBeenCalledTimes(2);
  });

  it('does not leave a link when the counter target is missing', async () => {
    const missingDocumentId = `${RUN}-missing`;

    await expect(
      adminCreateEntityDocumentLink(input(missingDocumentId, `${RUN}-tech-missing`))
    ).rejects.toThrow('Cannot link missing document');

    expect((await linksFor(missingDocumentId)).size).toBe(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('recognizes and preserves a legacy random-ID link', async () => {
    const docId = documentId('legacy');
    await seedDocument(docId);
    const createInput = input(docId, `${RUN}-tech-legacy`);
    const legacyId = `${RUN}-legacy-random-link`;
    await db.collection('entityDocumentLinks').doc(legacyId).set({
      ...createInput,
      graphSyncStatus: 'pending',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    await expect(adminCreateEntityDocumentLink(createInput)).rejects.toThrow(
      `Link already exists between technology:${RUN}-tech-legacy and document:${docId} (ID: ${legacyId})`
    );
    expect((await linksFor(docId)).size).toBe(1);
    expect((await db.collection('documents').doc(docId).get()).data()?.linkedEntityCount).toBe(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
