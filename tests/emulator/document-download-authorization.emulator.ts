/**
 * SEC-015 — end-to-end acceptance for the authenticated document download route
 * against the real Firebase Auth + Firestore + Storage emulators.
 *
 * This file deliberately does not match the root Jest `*.test.ts` pattern.
 * Run it through `npm run test:emulator`, which owns ephemeral Auth,
 * Firestore, and Storage emulators, seeds Firestore with Neo4j explicitly
 * disabled, and executes this file by path.
 *
 * Unlike the mocked route and security suites, every control here runs against
 * real infrastructure: real ID tokens verified by the Auth emulator, a real
 * owner-scoped Storage object carrying real uploader metadata, a real
 * `document_blobs` fallback record, and the real production route handler.
 *
 * It proves, in that environment:
 *  - owner success for BOTH content variants (Storage object, fallback blob)
 *  - cross-owner denial, ownerless denial, and absent-document denial, all
 *    byte-identical (no existence oracle)
 *  - ZERO content reads after any refusal — counted at the content boundary,
 *    which is call-through to the real implementation, so the owner cases prove
 *    the counter is not vacuous
 *  - a record that names another user's real object is still refused
 */

import { NextRequest } from 'next/server';

import { db as adminDb } from '@/lib/firebase-admin';

const PROJECT_ID = 'demo-radarist';
const STORAGE_BUCKET = 'demo-radarist.appspot.com';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('document-download-authorization.emulator.ts must run with NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`document-download-authorization.emulator.ts requires project ${PROJECT_ID}`);
}
if (
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST
) {
  throw new Error('Auth, Firestore, and Storage emulator hosts must be supplied by firebase emulators:exec');
}
if (process.env.NEO4J_URI) {
  throw new Error('test:emulator must keep NEO4J_URI empty');
}

// The content reader resolves the configured bucket by name (the Admin app is
// initialised with only a projectId). The emulator bucket is deterministic.
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = STORAGE_BUCKET;

/**
 * Every storage path the route asked the content layer to resolve. The mock
 * calls THROUGH to the real implementation, so this counts real reads rather
 * than replacing them — an owner download still hits the emulator.
 */
const contentReads: string[] = [];

jest.mock('@/lib/document-storage-admin', () => {
  const actual = jest.requireActual('@/lib/document-storage-admin');
  return {
    ...actual,
    adminGetOwnedDocumentContent: (storagePath: string, ownerId: string) => {
      contentReads.push(storagePath);
      return actual.adminGetOwnedDocumentContent(storagePath, ownerId);
    },
  };
});

// This lane owns Firebase emulators only; never auto-discover a developer's
// Inngest dev server through a transitive service import.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['sec015-noop'] }) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['sec015-noop'] }) },
}));

let GET: typeof import('@/app/api/documents/download/route').GET;

const firestoreCleanup = new Set<string>();
const storageCleanup = new Set<string>();

// ── emulator helpers ──────────────────────────────────────────────────────────

async function signUpUser(): Promise<{ idToken: string; uid: string }> {
  const email = `sec015-${Date.now()}-${Math.random().toString(36).slice(2)}@radarist.local`;
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'sec015-password-123', returnSecureToken: true }),
    }
  );
  const body = (await response.json()) as { idToken?: string; localId?: string; error?: unknown };
  if (!response.ok || !body.idToken || !body.localId) {
    throw new Error(`Auth emulator sign-up failed (${response.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  return { idToken: body.idToken, uid: body.localId };
}

/** Upload a real Storage object with the uploader metadata both upload paths write. */
async function putStorageObject(opts: {
  path: string;
  bytes: Buffer;
  contentType: string;
  uploadedBy?: string;
}): Promise<string> {
  const { getStorage } = await import('firebase-admin/storage');
  const { adminApp } = await import('@/lib/firebase-admin');
  const file = getStorage(adminApp).bucket(STORAGE_BUCKET).file(opts.path);
  await file.save(opts.bytes, {
    contentType: opts.contentType,
    metadata: {
      contentType: opts.contentType,
      metadata: opts.uploadedBy === undefined ? {} : { uploadedBy: opts.uploadedBy },
    },
  });
  storageCleanup.add(opts.path);
  return opts.path;
}

/** Write a real `document_blobs` fallback record (same shape as the upload path). */
async function putFallbackBlob(opts: {
  path: string;
  content: string;
  mimeType: string;
  userId?: string;
}): Promise<string> {
  const id = opts.path.replace(/\//g, '_');
  await adminDb
    .collection('document_blobs')
    .doc(id)
    .set({
      content: Buffer.from(opts.content, 'utf8').toString('base64'),
      mimeType: opts.mimeType,
      fileName: opts.path.split('/').pop(),
      storagePath: opts.path,
      size: Buffer.byteLength(opts.content, 'utf8'),
      createdAt: Date.now(),
      ...(opts.userId === undefined ? {} : { userId: opts.userId }),
    });
  firestoreCleanup.add(`document_blobs/${id}`);
  return opts.path;
}

/** Write a real `documents` record straight through the Admin SDK. */
async function seedDocument(fields: Record<string, unknown>): Promise<string> {
  const id = `doc-sec015-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await adminDb
    .collection('documents')
    .doc(id)
    .set({
      title: 'SEC-015 acceptance document',
      type: 'pdf',
      status: 'processed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...fields,
    });
  firestoreCleanup.add(`documents/${id}`);
  return id;
}

function downloadRequest(id: string, token?: string): Promise<Response> {
  const url = new URL(`http://localhost/api/documents/download?id=${encodeURIComponent(id)}`);
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return GET(new NextRequest(url, { method: 'GET', headers })) as unknown as Promise<Response>;
}

// ── suite ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  GET = (await import('@/app/api/documents/download/route')).GET;
});

beforeEach(() => {
  contentReads.length = 0;
});

afterAll(async () => {
  const { getStorage } = await import('firebase-admin/storage');
  const { adminApp } = await import('@/lib/firebase-admin');
  const bucket = getStorage(adminApp).bucket(STORAGE_BUCKET);
  await Promise.all(
    [...storageCleanup].map((path) =>
      bucket
        .file(path)
        .delete({ ignoreNotFound: true })
        .catch(() => undefined)
    )
  );
  await Promise.all(
    [...firestoreCleanup].map((path) =>
      adminDb
        .doc(path)
        .delete()
        .catch(() => undefined)
    )
  );
  await adminDb.terminate();
});

describe('SEC-015 document download — real Auth + Firestore + Storage emulators', () => {
  it('serves the owner their exact Storage-backed bytes', async () => {
    const owner = await signUpUser();
    const bytes = Buffer.from('%PDF-1.7 owned acceptance bytes');
    const path = await putStorageObject({
      path: `documents/${owner.uid}/1700000000-abcdef-quarterly.pdf`,
      bytes,
      contentType: 'application/pdf',
      uploadedBy: owner.uid,
    });
    const id = await seedDocument({ title: 'Quarterly', storageUrl: path, uploadedBy: owner.uid });

    const response = await downloadRequest(id, owner.idToken);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="quarterly.pdf"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    // The counter is real: an authorized owner DOES reach the content layer.
    expect(contentReads).toEqual([path]);
  });

  it('serves the owner their Firestore-fallback bytes under a non-owner-scoped path', async () => {
    const owner = await signUpUser();
    // The seeded showcase corpus stores content under a fixed `documents/demo/…`
    // path, so a path-shape ownership rule would refuse the demo operator.
    const path = await putFallbackBlob({
      path: 'documents/demo/sec015-brief.md',
      content: '# SEC-015 fallback brief',
      mimeType: 'text/markdown',
      userId: owner.uid,
    });
    const id = await seedDocument({
      title: 'Fallback brief',
      type: 'markdown',
      storageUrl: path,
      uploadedBy: owner.uid,
    });

    const response = await downloadRequest(id, owner.idToken);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# SEC-015 fallback brief');
  });

  it("refuses another user's document and reads no content at all", async () => {
    const owner = await signUpUser();
    const attacker = await signUpUser();
    const secret = Buffer.from('%PDF-1.7 board compensation');
    const path = await putStorageObject({
      path: `documents/${owner.uid}/1700000000-secret-comp.pdf`,
      bytes: secret,
      contentType: 'application/pdf',
      uploadedBy: owner.uid,
    });
    const id = await seedDocument({ title: 'Board compensation', storageUrl: path, uploadedBy: owner.uid });

    const response = await downloadRequest(id, attacker.idToken);
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'Document not found' });
    expect(body).not.toContain('Board compensation');
    expect(body).not.toContain('compensation');
    expect(contentReads).toEqual([]);

    // The refusal is non-destructive: the owner's object is untouched.
    const { getStorage } = await import('firebase-admin/storage');
    const { adminApp } = await import('@/lib/firebase-admin');
    const [exists] = await getStorage(adminApp).bucket(STORAGE_BUCKET).file(path).exists();
    expect(exists).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '  '],
  ])('refuses an ownerless legacy record (%s uploader) and reads no content', async (_label, uploadedBy) => {
    const caller = await signUpUser();
    const path = await putFallbackBlob({
      path: `documents/legacy/sec015-${Math.random().toString(36).slice(2, 8)}.md`,
      content: 'legacy ownerless bytes',
      mimeType: 'text/markdown',
    });
    const id = await seedDocument({
      title: 'Legacy record',
      type: 'markdown',
      storageUrl: path,
      ...(uploadedBy === undefined ? {} : { uploadedBy }),
    });

    const response = await downloadRequest(id, caller.idToken);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Document not found' });
    expect(contentReads).toEqual([]);
  });

  it('answers absent, foreign, and ownerless identically', async () => {
    const owner = await signUpUser();
    const caller = await signUpUser();
    const foreignId = await seedDocument({ storageUrl: 'documents/x/y.pdf', uploadedBy: owner.uid });
    const ownerlessId = await seedDocument({ storageUrl: 'documents/x/y.pdf' });

    const responses = [
      await downloadRequest('doc-sec015-definitely-absent', caller.idToken),
      await downloadRequest(foreignId, caller.idToken),
      await downloadRequest(ownerlessId, caller.idToken),
    ];
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
    expect(contentReads).toEqual([]);
  });

  it("refuses an owned record that points at another user's real object", async () => {
    const victim = await signUpUser();
    const attacker = await signUpUser();
    const secret = Buffer.from('%PDF-1.7 victim only');
    const path = await putStorageObject({
      path: `documents/${victim.uid}/1700000000-victim-only.pdf`,
      bytes: secret,
      contentType: 'application/pdf',
      uploadedBy: victim.uid,
    });
    // The attacker owns the RECORD; the record names the victim's object.
    const id = await seedDocument({ title: 'Forged pointer', storageUrl: path, uploadedBy: attacker.uid });

    const response = await downloadRequest(id, attacker.idToken);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('victim only');
  });

  it('rejects an unauthenticated caller with a bounded body', async () => {
    const owner = await signUpUser();
    const id = await seedDocument({ storageUrl: 'documents/x/y.pdf', uploadedBy: owner.uid });

    const response = await downloadRequest(id);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required' });
    expect(contentReads).toEqual([]);
  });

  it('tells the owner honestly when their own document has no stored file', async () => {
    const owner = await signUpUser();
    const id = await seedDocument({ title: 'No file', type: 'markdown', storageUrl: '', uploadedBy: owner.uid });

    const response = await downloadRequest(id, owner.idToken);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Document file not found in storage' });
  });
});
