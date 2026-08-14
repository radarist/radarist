/**
 * Release-critical Firebase integration contracts.
 *
 * This file deliberately does not match the root Jest `*.test.ts` pattern.
 * Run it through `npm run test:emulator`, which owns ephemeral Auth,
 * Firestore, and Storage emulators, seeds Firestore with Neo4j explicitly
 * disabled, and executes this file by path.
 */

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
  terminate,
  type Firestore,
} from 'firebase/firestore';
import {
  connectStorageEmulator,
  deleteObject,
  getBytes,
  getMetadata,
  getStorage,
  ref as storageRef,
  uploadBytes,
  type FirebaseStorage,
  type StorageReference,
} from 'firebase/storage';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';
import { Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

import { POST as createReport } from '@/app/api/reports/route';
import { resolveBackgroundAutomationPolicy } from '@/lib/background-automation-policy';
import { db as adminDb } from '@/lib/firebase-admin';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { finalizeBuildSessionAccounting, reserveBuildSessionBudget } from '@/lib/missions';

const PROJECT_ID = 'demo-radarist';
const STORAGE_BUCKET = 'demo-radarist.appspot.com';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const STORAGE_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199';

const [firestoreHostname, firestorePortText] = FIRESTORE_HOST.split(':');
const firestorePort = Number(firestorePortText);
const [storageHostname, storagePortText] = STORAGE_HOST.split(':');
const storagePort = Number(storagePortText);

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('release-contracts.emulator.ts must run with NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`release-contracts.emulator.ts requires project ${PROJECT_ID}`);
}
if (
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST
) {
  throw new Error('Auth, Firestore, and Storage emulator hosts must be supplied by firebase emulators:exec');
}
if (!firestoreHostname || !Number.isInteger(firestorePort)) {
  throw new Error(`Invalid FIRESTORE_EMULATOR_HOST: ${FIRESTORE_HOST}`);
}
if (!storageHostname || !Number.isInteger(storagePort)) {
  throw new Error(`Invalid FIREBASE_STORAGE_EMULATOR_HOST: ${STORAGE_HOST}`);
}
if (process.env.NEO4J_URI) {
  throw new Error('test:emulator must keep NEO4J_URI empty');
}

// This lane owns Firebase emulators only. Acknowledge the graph handoff at
// the explicit boundary so it can never auto-discover a developer's Inngest
// server; real Firestore -> Inngest -> Neo4j behavior belongs to the guarded
// disposable graph integration lanes.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['release-emulator-graph-handoff'] }) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['release-emulator-graph-handoff'] }) },
}));

let clientDb: Firestore;
let rulesApp: FirebaseApp;
let rulesDb: Firestore;
let rulesStorage: FirebaseStorage;
let getSystemConfig: typeof import('@/lib/system-config').getSystemConfig;
let updateBackgroundAutomationConfig: typeof import('@/lib/system-config').updateBackgroundAutomationConfig;
let uploadDocument: typeof import('@/lib/document-storage-service').uploadDocument;
let getDocumentContent: typeof import('@/lib/document-storage-service').getDocumentContent;
let getDocumentMetadata: typeof import('@/lib/document-storage-service').getDocumentMetadata;
let deleteStoredDocument: typeof import('@/lib/document-storage-service').deleteStoredDocument;
let adminUploadDocument: typeof import('@/lib/document-storage-admin').adminUploadDocument;
let adminGetDocumentContent: typeof import('@/lib/document-storage-admin').adminGetDocumentContent;
let uploadImage: typeof import('@/lib/storage').uploadImage;
let companyNotes: typeof import('@/lib/company-notes');
let jobObservability: typeof import('@/lib/inngest/observability');
let approveProposedRelation: typeof import('@/lib/proposed-relations-admin').approveProposedRelation;
let approveProposedRelationAsMachine: typeof import('@/lib/proposed-relations-admin').approveProposedRelationAsMachine;
let createdReportId: string | undefined;
const storageCleanup = new Set<StorageReference>();
const adminStorageCleanup = new Set<string>();
const firestoreCleanup = new Set<string>();

beforeAll(async () => {
  // `firebase.ts` keeps Firestore eager in browsers so Auth credentials are
  // registered before onAuthStateChanged fires. Give this Node integration
  // process the same initialization ordering without requiring a DOM runtime.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {},
  });
  const firebaseModule = await import('@/lib/firebase');
  const systemConfigModule = await import('@/lib/system-config');
  const documentStorageModule = await import('@/lib/document-storage-service');
  const documentStorageAdminModule = await import('@/lib/document-storage-admin');
  const imageStorageModule = await import('@/lib/storage');
  const companyNotesModule = await import('@/lib/company-notes');
  const jobObservabilityModule = await import('@/lib/inngest/observability');
  const proposedRelationsAdminModule = await import('@/lib/proposed-relations-admin');
  clientDb = firebaseModule.db;
  getSystemConfig = systemConfigModule.getSystemConfig;
  updateBackgroundAutomationConfig = systemConfigModule.updateBackgroundAutomationConfig;
  uploadDocument = documentStorageModule.uploadDocument;
  getDocumentContent = documentStorageModule.getDocumentContent;
  getDocumentMetadata = documentStorageModule.getDocumentMetadata;
  deleteStoredDocument = documentStorageModule.deleteStoredDocument;
  adminUploadDocument = documentStorageAdminModule.adminUploadDocument;
  adminGetDocumentContent = documentStorageAdminModule.adminGetDocumentContent;
  uploadImage = imageStorageModule.uploadImage;
  companyNotes = companyNotesModule;
  jobObservability = jobObservabilityModule;
  approveProposedRelation = proposedRelationsAdminModule.approveProposedRelation;
  approveProposedRelationAsMachine = proposedRelationsAdminModule.approveProposedRelationAsMachine;

  // Create the rules-only client after the app module has initialized the
  // default Firebase app; firebase.ts intentionally reuses that default app.
  rulesApp = initializeApp(
    {
      projectId: PROJECT_ID,
      apiKey: 'emulator-only-key',
      authDomain: `${PROJECT_ID}.firebaseapp.com`,
      storageBucket: STORAGE_BUCKET,
    },
    'release-emulator-rules-client'
  );
  rulesDb = getFirestore(rulesApp);
  connectFirestoreEmulator(rulesDb, firestoreHostname, firestorePort);
  rulesStorage = getStorage(rulesApp);
  connectStorageEmulator(rulesStorage, storageHostname, storagePort);
});

async function signUpEmulatorUser(): Promise<{ idToken: string; localId: string }> {
  const email = `release-contract-${Date.now()}@radarist.local`;
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'release-contract-password-123',
        returnSecureToken: true,
      }),
    }
  );
  const body = (await response.json()) as { idToken?: string; localId?: string; error?: unknown };
  if (!response.ok || !body.idToken || !body.localId) {
    throw new Error(`Auth emulator sign-up failed (${response.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  return { idToken: body.idToken, localId: body.localId };
}

afterAll(async () => {
  await Promise.all([...storageCleanup].map((objectRef) => deleteObject(objectRef).catch(() => undefined)));
  await Promise.all(
    [...adminStorageCleanup].map((objectPath) =>
      getAdminStorage().bucket(STORAGE_BUCKET).file(objectPath).delete({ ignoreNotFound: true })
    )
  );
  if (createdReportId) {
    await adminDb.collection('reports').doc(createdReportId).delete();
  }
  await Promise.all(
    [...firestoreCleanup].map((path) =>
      adminDb
        .doc(path)
        .delete()
        .catch(() => undefined)
    )
  );
  await deleteDoc(doc(clientDb, 'system-config', 'global')).catch(() => undefined);
  await terminate(clientDb);
  await adminDb.terminate();
  await terminate(rulesDb);
  await deleteApp(rulesApp);
  Reflect.deleteProperty(globalThis, 'window');
});

describe('ephemeral demo seed', () => {
  it('persists the release showcase collections and their critical references', async () => {
    const requiredCollections = [
      'radars',
      'technologies',
      'companies',
      'signals',
      'strategies',
      'relations',
      'reports',
      'visualizations',
      'radarPlacements',
      'proposedRelations',
      'missions',
      'agentRuns',
      'documents',
      'document_blobs',
      'documentChunks',
      'proposedAssessments',
      'proposedArtifacts',
    ] as const;

    const snapshots = await Promise.all(
      requiredCollections.map((collectionName) => getDocs(collection(rulesDb, collectionName)))
    );
    const counts = Object.fromEntries(
      requiredCollections.map((collectionName, index) => [collectionName, snapshots[index].size])
    );

    for (const collectionName of requiredCollections) {
      expect(counts[collectionName]).toBeGreaterThan(0);
    }

    const radar = snapshots[0].docs[0]?.data();
    expect(radar?.quadrants).toHaveLength(4);

    const technologyIds = new Set(snapshots[1].docs.map((entry) => entry.id));
    const placements = snapshots[8].docs.map((entry) => entry.data());
    expect(placements).toHaveLength(technologyIds.size);
    expect(placements.every((placement) => technologyIds.has(String(placement.technologyId)))).toBe(true);

    const placementsById = new Map(snapshots[8].docs.map((entry) => [entry.id, entry.data()]));
    const pairLocks = await adminDb.collection('radarPlacementPairs').get();
    expect(pairLocks.size).toBe(placementsById.size);
    for (const lockDocument of pairLocks.docs) {
      const lock = lockDocument.data();
      const placement = placementsById.get(String(lock.placementId));
      expect(placement).toBeDefined();
      expect(lock.radarId).toBe(placement?.radarId);
      expect(lock.technologyId).toBe(placement?.technologyId);
    }

    const reports = snapshots[6].docs.map((entry) => entry.data());
    expect(reports.some((report) => report.shared === true)).toBe(true);
    expect(reports.every((report) => report.ownerId === 'demo-user' && String(report.html).length > 100)).toBe(true);

    const documentIds = new Set(snapshots[12].docs.map((entry) => entry.id));
    const chunks = snapshots[14].docs.map((entry) => entry.data());
    expect(chunks.every((chunk) => documentIds.has(String(chunk.documentId)) && chunk.archived === false)).toBe(true);

    const missions = snapshots[10].docs.map((entry) => entry.data());
    const agentRuns = snapshots[11].docs.map((entry) => entry.data());
    expect(missions.every((mission) => mission.userId === 'demo-user')).toBe(true);
    expect(agentRuns.every((run) => run.userId === 'demo-user')).toBe(true);
  });
});

describe('Firestore rules', () => {
  it('permits the documented emulator-only workspace access', async () => {
    const ref = doc(rulesDb, 'releaseContractChecks', 'workspace-access');
    await setDoc(ref, { ok: true });
    await expect(getDoc(ref)).resolves.toMatchObject({ exists: expect.any(Function) });
    expect((await getDoc(ref)).data()).toEqual({ ok: true });
    await deleteDoc(ref);
  });

  it('denies direct client access to API-key records', async () => {
    const ref = doc(rulesDb, 'apiKeys', 'must-remain-admin-only');
    await expect(setDoc(ref, { hash: 'not-a-real-key', scopes: ['admin'] })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('denies unauthenticated client read, write, delete, and list of operationReceipts (ARUN-022 server-owned ledger)', async () => {
    // Live emulator + firestore.rules proof that the additive wide-open fallback
    // does not re-grant this server-owned collection to a browser client.
    const ref = doc(rulesDb, 'operationReceipts', 'must-remain-admin-only');
    await expect(setDoc(ref, { correlation: { owner: 'attacker' } })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(getDocs(collection(rulesDb, 'operationReceipts'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('GRAPH-066 #11 — denies direct client access to the server-owned radarPlacementPairs lock + delete tombstone', async () => {
    for (const serverOnly of ['radarPlacementPairs', 'radarPlacementDeleteOutbox', 'placementParentDeletionLeases']) {
      const ref = doc(rulesDb, serverOnly, 'must-remain-server-owned');
      await expect(setDoc(ref, { placementId: 'p1' })).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(getDocs(collection(rulesDb, serverOnly))).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('GRAPH-060 #11 — keeps radarPlacements client-readable but denies direct client writes (server-routed)', async () => {
    // A placement seeded via the Admin SDK (bypasses rules) is readable by the UI...
    const ref = doc(rulesDb, 'radarPlacements', 'rules-placement-1');
    await adminDb.doc('radarPlacements/rules-placement-1').set({ technologyId: 't1', radarId: 'r1', ring: 'Trial' });
    await expect(getDoc(ref)).resolves.toMatchObject({ exists: expect.any(Function) });
    // ...but a direct browser create/update/delete is denied (mutations go
    // through the authenticated /api/radar-placements handoff instead).
    await expect(setDoc(doc(rulesDb, 'radarPlacements', 'rules-placement-2'), { radarId: 'r1' })).rejects.toMatchObject(
      {
        code: 'permission-denied',
      }
    );
    await expect(setDoc(ref, { ring: 'Adopt' }, { merge: true })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
    await adminDb.doc('radarPlacements/rules-placement-1').delete();
  });

  it('denies an authenticated non-admin client CRUD, list, and nested-path access to operationReceipts', async () => {
    // Being signed in as a normal user must not unlock the server-owned ledger.
    const authedApp = initializeApp(
      {
        projectId: PROJECT_ID,
        apiKey: 'emulator-only-key',
        authDomain: `${PROJECT_ID}.firebaseapp.com`,
        storageBucket: STORAGE_BUCKET,
      },
      `operation-receipts-authed-client-${Date.now()}`
    );
    const authedAuth = getAuth(authedApp);
    connectAuthEmulator(authedAuth, `http://${AUTH_HOST}`, { disableWarnings: true });
    const authedDb = getFirestore(authedApp);
    connectFirestoreEmulator(authedDb, firestoreHostname, firestorePort);
    try {
      await createUserWithEmailAndPassword(
        authedAuth,
        `operation-receipts-${Date.now()}@radarist.local`,
        'operation-receipts-password-123'
      );
      expect(authedAuth.currentUser).not.toBeNull();

      const ref = doc(authedDb, 'operationReceipts', 'authed-denied');
      await expect(getDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(setDoc(ref, { correlation: { owner: 'attacker' } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(setDoc(ref, { note: 'update' }, { merge: true })).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(getDocs(collection(authedDb, 'operationReceipts'))).rejects.toMatchObject({
        code: 'permission-denied',
      });

      // A nested subcollection path is denied too — no rule grants it and the
      // additive fallback excludes the operationReceipts collection segment.
      const nestedRef = doc(authedDb, 'operationReceipts', 'r1', 'children', 'c1');
      await expect(getDoc(nestedRef)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(setDoc(nestedRef, { note: 'nested' })).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(getDocs(collection(authedDb, 'operationReceipts', 'r1', 'children'))).rejects.toMatchObject({
        code: 'permission-denied',
      });
    } finally {
      await terminate(authedDb).catch(() => undefined);
      await deleteApp(authedApp).catch(() => undefined);
    }
  });

  it('makes document identity client-immutable and blocks browser writes while server deletion is leased', async () => {
    const documentId = `deletion-lease-${Date.now()}`;
    const documentPath = `documents/${documentId}`;
    const leasePath = `documentDeletionLeases/${documentId}`;
    const ref = doc(rulesDb, documentPath);
    firestoreCleanup.add(documentPath);
    firestoreCleanup.add(leasePath);

    await setDoc(ref, {
      title: 'Lease contract',
      type: 'pdf',
      uploadedBy: 'owner-a',
      storageUrl: 'documents/owner-a/lease-contract.pdf',
    });
    await expect(setDoc(ref, { uploadedBy: 'owner-b' }, { merge: true })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(setDoc(ref, { storageUrl: 'documents/owner-b/foreign.pdf' }, { merge: true })).rejects.toMatchObject({
      code: 'permission-denied',
    });

    await adminDb.doc(leasePath).set({
      leaseId: 'server-only-lease',
      documentId,
      ownerId: 'owner-a',
      storagePath: 'documents/owner-a/lease-contract.pdf',
      createdAt: Timestamp.now(),
    });

    await expect(setDoc(ref, { title: 'raced mutation' }, { merge: true })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(deleteDoc(ref)).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await getDoc(ref)).data()?.title).toBe('Lease contract');
    await expect(getDoc(doc(rulesDb, leasePath))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('build-session accounting transactions', () => {
  it('serializes concurrent reservations so only one can consume the remaining mission cap', async () => {
    const missionId = `release-accounting-${Date.now()}`;
    const missionPath = `missions/${missionId}`;
    firestoreCleanup.add(missionPath);
    await adminDb.doc(missionPath).set({ costUsd: 0, tokenUsage: { input: 0, output: 0 }, sessions: [] });

    const startedAt = '2026-07-15T10:00:00.000Z';
    const attempts = await Promise.all([
      reserveBuildSessionBudget(
        missionId,
        {
          index: 0,
          role: 'builder',
          objective: 'first concurrent launch',
          model: 'claude-opus-4-8',
          startedAt,
          reservedCostUsd: 6,
        },
        6
      ),
      reserveBuildSessionBudget(
        missionId,
        {
          index: 1,
          role: 'builder',
          objective: 'second concurrent launch',
          model: 'claude-opus-4-8',
          startedAt,
          reservedCostUsd: 6,
        },
        6
      ),
    ]);

    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(['budget-exceeded', 'reserved']);
    const acceptedIndex = attempts.findIndex((attempt) => attempt.status === 'reserved');
    const snapshot = await adminDb.doc(missionPath).get();
    expect(snapshot.data()).toMatchObject({ costUsd: 6 });
    expect(snapshot.data()?.sessions).toHaveLength(1);

    const finalized = await finalizeBuildSessionAccounting(
      missionId,
      {
        index: acceptedIndex,
        role: 'builder',
        objective: '',
        model: 'claude-opus-4-8',
        startedAt,
        endedAt: '2026-07-15T10:10:00.000Z',
        turns: 5,
        costUsd: 2,
        exitReason: 'completed',
        failingChecksHash: null,
      },
      { input: 100, output: 25 }
    );
    expect(finalized).toMatchObject({ applied: true, missionCostUsd: 2 });

    const reconciled = (await adminDb.doc(missionPath).get()).data();
    expect(reconciled).toMatchObject({ costUsd: 2, tokenUsage: { input: 100, output: 25 } });
    expect(reconciled?.sessions).toHaveLength(2);
  });
});

describe('Storage workflows and rules', () => {
  it('round-trips server image upload through rules-enforced client read and delete', async () => {
    const payload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>contract</text></svg>');
    const objectPath = 'visualizations/release-contract/image-contract.svg';
    const downloadUrl = await uploadImage(
      payload,
      'release-contract',
      'image/svg+xml',
      'visualizations',
      'image-contract.svg'
    );
    adminStorageCleanup.add(objectPath);
    expect(downloadUrl).toContain(`http://${STORAGE_HOST}/v0/b/${STORAGE_BUCKET}/o/`);

    const objectRef = storageRef(rulesStorage, objectPath);
    expect(Buffer.from(await getBytes(objectRef)).equals(payload)).toBe(true);
    await expect(getMetadata(objectRef)).resolves.toMatchObject({
      contentType: 'image/svg+xml',
      customMetadata: {
        uploadedBy: 'release-contract',
        originalName: 'image-contract.svg',
      },
    });

    await deleteObject(objectRef);
    adminStorageCleanup.delete(objectPath);
    await expect(getMetadata(objectRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
  });

  it('round-trips the Admin SDK upload/read path used by API routes and workers', async () => {
    const payload = Buffer.from('Admin Storage emulator contract.\n');
    const result = await adminUploadDocument(payload, 'admin-contract.txt', 'text/plain', 'release-contract-admin');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    adminStorageCleanup.add(result.path);
    expect(result.path).toMatch(/^documents\/release-contract-admin\/\d+-[a-z0-9]+-admin-contract\.txt$/);
    expect(result.downloadUrl).toContain(`http://${STORAGE_HOST}/v0/b/${STORAGE_BUCKET}/o/`);

    const downloaded = await adminGetDocumentContent(result.path);
    expect(downloaded?.mimeType).toBe('text/plain');
    expect(downloaded?.content.equals(payload)).toBe(true);
    const response = await fetch(result.downloadUrl);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe(payload.toString());

    await getAdminStorage().bucket(STORAGE_BUCKET).file(result.path).delete();
    adminStorageCleanup.delete(result.path);
  });

  it('round-trips the document client upload, download, metadata, and delete path', async () => {
    const payload = Buffer.from('# Emulator evidence\n\nStorage integration contract.\n');
    const result = await uploadDocument(payload, 'release contract.md', 'text/markdown', 'release-contract-user');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);

    const objectRef = storageRef(rulesStorage, result.path);
    storageCleanup.add(objectRef);
    expect(result.path).toMatch(/^documents\/release-contract-user\/\d+-[a-z0-9]+-release_contract\.md$/);
    expect(result.downloadUrl).toContain(encodeURIComponent(result.path));

    await expect(getDocumentMetadata(result.path)).resolves.toMatchObject({
      size: payload.length,
      mimeType: 'text/markdown',
      originalName: 'release contract.md',
    });
    const downloaded = await getDocumentContent(result.path);
    expect(downloaded?.mimeType).toBe('text/markdown');
    expect(downloaded?.content.equals(payload)).toBe(true);

    await deleteStoredDocument(result.path);
    storageCleanup.delete(objectRef);
    await expect(getMetadata(objectRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
  });

  it.each(['documents', 'infographics', 'visualizations'] as const)(
    'permits the documented emulator-only %s asset lifecycle',
    async (prefix) => {
      const objectRef = storageRef(rulesStorage, `${prefix}/release-contract/asset.txt`);
      storageCleanup.add(objectRef);

      await uploadBytes(objectRef, new TextEncoder().encode(`${prefix}-asset`), {
        contentType: 'text/plain',
      });
      expect(new TextDecoder().decode(await getBytes(objectRef))).toBe(`${prefix}-asset`);
      await expect(getMetadata(objectRef)).resolves.toMatchObject({ contentType: 'text/plain' });

      await deleteObject(objectRef);
      storageCleanup.delete(objectRef);
      await expect(getMetadata(objectRef)).rejects.toMatchObject({ code: 'storage/object-not-found' });
    }
  );

  it('denies client reads, writes, and deletes outside the documented local prefixes', async () => {
    const objectRef = storageRef(rulesStorage, 'private/release-contract/blocked.txt');

    await expect(uploadBytes(objectRef, new TextEncoder().encode('blocked'))).rejects.toMatchObject({
      code: 'storage/unauthorized',
    });
    await expect(getBytes(objectRef)).rejects.toMatchObject({ code: 'storage/unauthorized' });
    await expect(deleteObject(objectRef)).rejects.toMatchObject({ code: 'storage/unauthorized' });
  });
});

describe('local checkpoint write barrier', () => {
  const barrierPath = '__radaristRuntime/checkpointBarrier';

  afterEach(async () => {
    await adminDb
      .doc(barrierPath)
      .delete()
      .catch(() => undefined);
  });

  it('keeps reads available while direct Firestore and Storage writes fail closed', async () => {
    const firestorePath = 'checkpoint-contract/readable';
    const storagePath = 'documents/checkpoint-contract/readable.txt';
    const adminObject = getAdminStorage().bucket(STORAGE_BUCKET).file(storagePath);
    await adminDb.doc(firestorePath).set({ state: 'before-barrier' });
    firestoreCleanup.add(firestorePath);
    await adminObject.save(Buffer.from('before-barrier'), { contentType: 'text/plain' });
    adminStorageCleanup.add(storagePath);
    await adminDb.doc(barrierPath).set({
      active: true,
      profile: 'default',
      owner: 'checkpoint-contract',
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
    });

    const readable = await getDoc(doc(rulesDb, firestorePath));
    expect(readable.data()).toEqual({ state: 'before-barrier' });
    expect(Buffer.from(await getBytes(storageRef(rulesStorage, storagePath))).toString()).toBe('before-barrier');
    await expect(setDoc(doc(rulesDb, 'checkpoint-contract/blocked'), { state: 'blocked' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      uploadBytes(
        storageRef(rulesStorage, 'documents/checkpoint-contract/blocked.txt'),
        new TextEncoder().encode('blocked')
      )
    ).rejects.toMatchObject({ code: 'storage/unauthorized' });
    await expect(getDoc(doc(rulesDb, barrierPath))).rejects.toMatchObject({
      code: 'permission-denied',
    });

    // The launcher uses the Admin SDK and must retain its own control path.
    await expect(adminDb.doc('checkpoint-contract/admin-writer').set({ state: 'allowed' })).resolves.toBeDefined();
    firestoreCleanup.add('checkpoint-contract/admin-writer');
  });

  it('expires automatically so an interrupted launcher cannot strand writes', async () => {
    await adminDb.doc(barrierPath).set({
      active: true,
      profile: 'default',
      owner: 'checkpoint-contract-expired',
      expiresAt: Timestamp.fromMillis(Date.now() - 1_000),
    });
    const firestorePath = 'checkpoint-contract/after-expiry';
    const storagePath = 'documents/checkpoint-contract/after-expiry.txt';

    await expect(setDoc(doc(rulesDb, firestorePath), { state: 'allowed' })).resolves.toBeUndefined();
    firestoreCleanup.add(firestorePath);
    const objectRef = storageRef(rulesStorage, storagePath);
    await expect(
      uploadBytes(objectRef, new TextEncoder().encode('allowed'), { contentType: 'text/plain' })
    ).resolves.toBeDefined();
    storageCleanup.add(objectRef);
  });
});

describe('background automation persistence', () => {
  it('round-trips Settings writes into the policy read by server workers', async () => {
    await deleteDoc(doc(clientDb, 'system-config', 'global')).catch(() => undefined);

    const initial = await getSystemConfig();
    expect(initial.sweep).toEqual({ enabled: false, maxActionsPerSweep: 10 });
    expect(initial.linkerAgent?.enabled).toBe(false);

    await updateBackgroundAutomationConfig({ enabled: true, maxActionsPerSweep: 7 }, true);

    const clientReload = await getSystemConfig();
    expect(clientReload.sweep).toEqual({ enabled: true, maxActionsPerSweep: 7 });
    expect(clientReload.linkerAgent?.enabled).toBe(true);

    const workerSnapshot = await adminDb.collection('system-config').doc('global').get();
    const runningPolicy = resolveBackgroundAutomationPolicy(workerSnapshot.data());
    expect(runningPolicy).toMatchObject({
      enabled: true,
      impulseSweepEnabled: true,
      signalFetchEnabled: true,
      linkerEnabled: true,
      discoveryEnabled: true,
      maxActionsPerSweep: 7,
    });

    await updateBackgroundAutomationConfig({ enabled: false, maxActionsPerSweep: 4 }, true);
    const pausedSnapshot = await adminDb.collection('system-config').doc('global').get();
    expect(resolveBackgroundAutomationPolicy(pausedSnapshot.data())).toMatchObject({
      enabled: false,
      impulseSweepEnabled: false,
      signalFetchEnabled: false,
      linkerEnabled: false,
      discoveryEnabled: false,
      maxActionsPerSweep: 4,
    });
  });
});

describe('release-fix persistence contracts', () => {
  it('transactionally unions provenance from concurrent duplicate approvals without downgrading curation', async () => {
    const now = Date.now();
    const sourceId = 'tech-release-contract-provenance-source';
    const targetId = 'tech-release-contract-provenance-target';
    const relationId = 'release-contract-provenance-relation';
    const humanProposalId = 'release-contract-provenance-human';
    const machineProposalId = 'release-contract-provenance-machine';
    const paths = [
      `technologies/${sourceId}`,
      `technologies/${targetId}`,
      `relations/${relationId}`,
      `proposedRelations/${humanProposalId}`,
      `proposedRelations/${machineProposalId}`,
    ];
    paths.forEach((path) => firestoreCleanup.add(path));

    await Promise.all([
      adminDb.doc(`technologies/${sourceId}`).set({ id: sourceId, name: 'Provenance Source' }),
      adminDb.doc(`technologies/${targetId}`).set({ id: targetId, name: 'Provenance Target' }),
      adminDb.doc(`relations/${relationId}`).set({
        id: relationId,
        relationType: 'uses',
        sourceSnapshot: { id: sourceId, type: 'technology', name: 'Provenance Source', snapshotAt: now },
        targetSnapshot: { id: targetId, type: 'technology', name: 'Provenance Target', snapshotAt: now },
        notes: '',
        confidence: 90,
        aiSuggested: true,
        claimStatus: 'proposed',
        evidenceRefs: [],
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    const proposalBase = {
      sourceType: 'technology',
      sourceId,
      sourceSnapshot: { id: sourceId, type: 'technology', name: 'Provenance Source', snapshotAt: now },
      targetType: 'technology',
      targetId,
      targetSnapshot: { id: targetId, type: 'technology', name: 'Provenance Target', snapshotAt: now },
      relationType: 'uses',
      confidence: 90,
      status: 'pending',
      discoveredBy: 'ai-assistant',
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      adminDb.doc(`proposedRelations/${humanProposalId}`).set({
        ...proposalBase,
        id: humanProposalId,
        reasoning: 'Human-reviewed rationale',
        evidence: [
          {
            sourceType: 'web',
            sourceId: 'web-human',
            location: { url: 'https://example.test/human', fetchedAt: now },
            snippet: 'Independent web evidence',
            snippetHash: 'human-hash',
            extractedAt: now,
          },
        ],
      }),
      adminDb.doc(`proposedRelations/${machineProposalId}`).set({
        ...proposalBase,
        id: machineProposalId,
        reasoning: 'Machine rationale',
        evidence: [
          {
            sourceType: 'signal',
            sourceId: 'signal-machine',
            location: { field: 'summary' },
            snippet: 'Signal evidence',
            snippetHash: 'machine-hash',
            extractedAt: now,
          },
        ],
      }),
    ]);

    await Promise.all([
      approveProposedRelation(humanProposalId, 'release-contract-reviewer'),
      approveProposedRelationAsMachine(machineProposalId, 'release-contract-autopilot'),
    ]);

    const committed = (await adminDb.doc(`relations/${relationId}`).get()).data();
    expect(committed?.claimStatus).toBe('curated');
    expect(committed?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `proposal:${humanProposalId}:web:web-human:human-hash` }),
        expect.objectContaining({ id: `proposal:${humanProposalId}:reasoning` }),
        expect.objectContaining({ id: `proposal:${machineProposalId}:signal:signal-machine:machine-hash` }),
        expect.objectContaining({ id: `proposal:${machineProposalId}:reasoning` }),
      ])
    );
    await expect(adminDb.doc(`proposedRelations/${humanProposalId}`).get()).resolves.toMatchObject({
      exists: true,
    });
    expect((await adminDb.doc(`proposedRelations/${humanProposalId}`).get()).data()).toMatchObject({
      status: 'approved',
      relationId,
    });
    expect((await adminDb.doc(`proposedRelations/${machineProposalId}`).get()).data()).toMatchObject({
      status: 'approved',
      relationId,
    });
  });

  it('round-trips an edited company note through client and Admin SDK reads', async () => {
    const companyId = 'release-contract-company-notes';
    const companyPath = `companies/${companyId}`;
    firestoreCleanup.add(companyPath);
    await setDoc(doc(clientDb, 'companies', companyId), {
      id: companyId,
      name: 'Release Contract Company',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const created = await companyNotes.createNote(companyId, {
      content: 'Original emulator note',
      type: 'General',
      userId: 'release-contract-user',
    });
    const notePath = `${companyPath}/notes/${created.id}`;
    firestoreCleanup.add(notePath);

    await companyNotes.updateNote(companyId, created.id, { content: 'Edited emulator note' });

    const reloaded = await companyNotes.getNotesByCompanyId(companyId);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      id: created.id,
      companyId,
      content: 'Edited emulator note',
      type: 'General',
      createdAt: created.createdAt,
    });

    const adminSnapshot = await adminDb.doc(notePath).get();
    expect(adminSnapshot.data()).toMatchObject({
      id: created.id,
      content: 'Edited emulator note',
      createdAt: created.createdAt,
    });

    await companyNotes.deleteNote(companyId, created.id);
    firestoreCleanup.delete(notePath);
    await deleteDoc(doc(clientDb, 'companies', companyId));
    firestoreCleanup.delete(companyPath);
  });

  it('persists a complete job lifecycle without undefined Firestore fields', async () => {
    const runId = 'release-contract-job-run';
    const runPath = `job-runs/${runId}`;
    firestoreCleanup.add(runPath);

    await jobObservability.recordJobStart('release-contract', 'Release contract', undefined, runId);
    let persisted = (await adminDb.doc(runPath).get()).data();
    expect(persisted).toMatchObject({
      id: runId,
      functionId: 'release-contract',
      functionName: 'Release contract',
      status: 'running',
      retryCount: 0,
    });
    expect(persisted).not.toHaveProperty('input');
    expect(persisted?.startedAt.toMillis()).toBeGreaterThan(0);

    const failure = new Error('emulator lifecycle failure') as Error & { code?: string };
    Object.defineProperty(failure, 'stack', { value: undefined });
    failure.code = undefined;
    await jobObservability.recordJobFailure(runId, failure);
    persisted = (await adminDb.doc(runPath).get()).data();
    expect(persisted).toMatchObject({
      status: 'failed',
      retryCount: 0,
      error: { message: 'emulator lifecycle failure' },
    });
    expect(persisted?.error).not.toHaveProperty('stack');
    expect(persisted?.error).not.toHaveProperty('code');
    const failedAt = persisted?.completedAt.toMillis() as number;
    expect(failedAt).toBeGreaterThan(0);

    await jobObservability.recordJobComplete(runId);
    persisted = (await adminDb.doc(runPath).get()).data();
    expect(persisted).toMatchObject({ status: 'completed', retryCount: 0 });
    expect(persisted).not.toHaveProperty('error');
    expect(persisted).not.toHaveProperty('output');
    expect(persisted).not.toHaveProperty('metadata');
    expect(persisted?.completedAt.toMillis()).toBeGreaterThanOrEqual(failedAt);

    await adminDb.doc(runPath).delete();
    firestoreCleanup.delete(runPath);
  });
});

describe('Auth-backed API ownership', () => {
  it('accepts a real emulator token and stamps the authenticated report owner', async () => {
    const { idToken, localId } = await signUpEmulatorUser();
    const authRequest = new NextRequest('http://localhost/api/reports', {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    await expect(getAuthenticatedUser(authRequest)).resolves.toMatchObject({
      authenticated: true,
      uid: localId,
    });

    const response = await createReport(
      new NextRequest('http://localhost/api/reports', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Emulator ownership contract',
          html: '<!doctype html><html><body>owned by the signed-in user</body></html>',
          createdBy: 'user',
          ownerId: 'body-supplied-owner-must-not-win',
          entityIds: [],
          metadata: {
            description: 'Ephemeral Auth and Firestore emulator contract',
            dataSnapshotAt: new Date().toISOString(),
          },
          shared: false,
        }),
      })
    );

    expect(response.status).toBe(201);
    const report = (await response.json()) as { id: string; ownerId: string };
    createdReportId = report.id;
    expect(report.ownerId).toBe(localId);

    const persisted = await adminDb.collection('reports').doc(report.id).get();
    expect(persisted.data()?.ownerId).toBe(localId);

    const unauthenticated = await createReport(
      new NextRequest('http://localhost/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect(unauthenticated.status).toBe(401);
  });
});
