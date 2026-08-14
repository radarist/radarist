/**
 * Technology cascade integration contract (UX-012 / UX-015).
 *
 * Uses only disposable, per-run documents in the Firestore emulator. The
 * Inngest boundary is acknowledged in-process so this test can exercise the
 * real Admin SDK queries, cursor pagination, transactions, and write batches
 * without a graph or Inngest development server.
 */

const PROJECT_ID = 'demo-radarist';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('technology-deletion.emulator.ts requires NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`technology-deletion.emulator.ts requires project ${PROJECT_ID}`);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('technology-deletion.emulator.ts requires FIRESTORE_EMULATOR_HOST');
}

jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['technology-deletion-emulator-event'] }) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['technology-deletion-emulator-event'] }) },
}));
jest.mock('@/lib/graph/neo4j-graph-service', () => ({
  getNeo4jGraphService: () => ({ isHealthy: jest.fn().mockResolvedValue(false) }),
}));

import { db as adminDb } from '@/lib/firebase-admin';
import { adminDeleteTechnologiesCompletely } from '@/lib/technology-admin';

const RUN = `technology-delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TECHNOLOGY_ID = `tech-${RUN}`;
const OTHER_TECHNOLOGY_ID = `tech-${RUN}-retained`;
const DOCUMENT_ID = `document-${RUN}`;
const LINK_ID = `link-${RUN}`;
const SEEDED_PATHS: string[] = [];

async function seedDocuments(
  entries: readonly { path: string; data: Record<string, unknown> }[]
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += 450) {
    const chunk = entries.slice(offset, offset + 450);
    const batch = adminDb.batch();
    for (const entry of chunk) {
      batch.set(adminDb.doc(entry.path), entry.data);
    }
    await batch.commit();
    SEEDED_PATHS.push(...chunk.map(({ path }) => path));
  }
}

afterAll(async () => {
  try {
    for (let offset = 0; offset < SEEDED_PATHS.length; offset += 450) {
      const batch = adminDb.batch();
      for (const path of SEEDED_PATHS.slice(offset, offset + 450)) batch.delete(adminDb.doc(path));
      await batch.commit();
    }
  } finally {
    await adminDb.terminate();
  }
});

describe('Technology complete deletion', () => {
  it('cursor-pages 451 references, removes all reverse fields and links, then deletes the parent', async () => {
    const now = Date.now();
    const prototypes = Array.from({ length: 451 }, (_, index) => ({
      path: `prototypes/${RUN}-prototype-${index.toString().padStart(3, '0')}`,
      data: {
        id: `${RUN}-prototype-${index}`,
        linkedTechnologies: [TECHNOLOGY_ID, OTHER_TECHNOLOGY_ID],
      },
    }));
    const useCasePath = `use-cases/${RUN}-use-case`;
    const painPointPath = `painPoints/${RUN}-pain-point`;

    await seedDocuments([
      {
        path: `technologies/${TECHNOLOGY_ID}`,
        data: {
          id: TECHNOLOGY_ID,
          name: `Deletion contract ${RUN}`,
          description: 'Disposable emulator Technology',
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
      },
      ...prototypes,
      {
        path: useCasePath,
        data: { id: `${RUN}-use-case`, radarTechnologyIds: [TECHNOLOGY_ID, OTHER_TECHNOLOGY_ID] },
      },
      {
        path: painPointPath,
        data: { id: `${RUN}-pain-point`, linkedTechnologyIds: [TECHNOLOGY_ID, OTHER_TECHNOLOGY_ID] },
      },
      {
        path: `documents/${DOCUMENT_ID}`,
        data: { id: DOCUMENT_ID, title: `Deletion document ${RUN}`, linkedEntityCount: 1, createdAt: now, updatedAt: now },
      },
      {
        path: `entityDocumentLinks/${LINK_ID}`,
        data: {
          id: LINK_ID,
          workspaceId: 'default',
          entityType: 'technology',
          entityId: TECHNOLOGY_ID,
          documentId: DOCUMENT_ID,
          relationshipType: 'documentation',
          tags: [],
          relevance: 'high',
          aiSuggested: false,
          createdAt: now,
          createdBy: 'emulator-contract',
          updatedAt: now,
          graphSyncStatus: 'pending',
        },
      },
    ]);

    const result = await adminDeleteTechnologiesCompletely([TECHNOLOGY_ID]);

    expect(result).toMatchObject({ succeeded: 1, failed: [] });
    expect((await adminDb.doc(`technologies/${TECHNOLOGY_ID}`).get()).exists).toBe(false);
    expect((await adminDb.doc(`entityDocumentLinks/${LINK_ID}`).get()).exists).toBe(false);
    expect((await adminDb.doc(`documents/${DOCUMENT_ID}`).get()).data()?.linkedEntityCount).toBe(0);

    const [prototypeReferences, useCaseReferences, painPointReferences] = await Promise.all([
      adminDb.collection('prototypes').where('linkedTechnologies', 'array-contains', TECHNOLOGY_ID).get(),
      adminDb.collection('use-cases').where('radarTechnologyIds', 'array-contains', TECHNOLOGY_ID).get(),
      adminDb.collection('painPoints').where('linkedTechnologyIds', 'array-contains', TECHNOLOGY_ID).get(),
    ]);
    expect(prototypeReferences.empty).toBe(true);
    expect(useCaseReferences.empty).toBe(true);
    expect(painPointReferences.empty).toBe(true);

    expect((await adminDb.doc(prototypes[0].path).get()).data()?.linkedTechnologies).toEqual([
      OTHER_TECHNOLOGY_ID,
    ]);
    expect((await adminDb.doc(useCasePath).get()).data()?.radarTechnologyIds).toEqual([OTHER_TECHNOLOGY_ID]);
    expect((await adminDb.doc(painPointPath).get()).data()?.linkedTechnologyIds).toEqual([OTHER_TECHNOLOGY_ID]);
  });
});
