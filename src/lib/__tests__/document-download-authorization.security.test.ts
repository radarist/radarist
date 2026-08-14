/**
 * @jest-environment node
 *
 * SEC-015 — the document-download authorization control, proved through the
 * REAL route handler, the REAL policy, the REAL repository, and the REAL
 * content layer. Only the two SDK boundaries (Firestore and Storage) are
 * mocked, so nothing about the decision itself is stubbed out.
 *
 * The companion `src/app/api/documents/download/__tests__/route.test.ts`
 * isolates the route with the repository mocked; this file exists because a
 * mocked authorization decision cannot prove that authorization happens.
 *
 * What is asserted here:
 *  - an owner receives their own bytes (Storage and Firestore-fallback variants)
 *  - a cross-owner request is refused, and neither backend is read
 *  - an ownerless legacy record is refused, and neither backend is read
 *  - absent / foreign / ownerless are byte-identical responses (no oracle)
 *  - a record that names another user's object is still refused
 *  - refusal logs carry no uid, owner, title, or storage path
 */
export {};

const OWNER_UID = 'owner-uid';
const ATTACKER_UID = 'attacker-uid';

process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'demo-radarist.appspot.com';

// ── logger: captured so refusal logging can be asserted ─────────────────────
const logWarn = jest.fn();
const logError = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: logWarn, error: logError, debug: jest.fn() }),
}));

// ── Firestore boundary ───────────────────────────────────────────────────────
type StoredDoc = Record<string, unknown> | null;

const documents = new Map<string, StoredDoc>();
const blobs = new Map<string, StoredDoc>();
const documentReads: string[] = [];
const blobReads: string[] = [];

function snapshot(id: string, data: StoredDoc) {
  return { exists: data !== null, id, data: () => data };
}

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => 'DELETE' },
  Timestamp: {
    now: () => ({ toMillis: () => 1_700_000_000_000 }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (collectionName: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (collectionName === 'documents') {
            documentReads.push(id);
            return snapshot(id, documents.get(id) ?? null);
          }
          if (collectionName === 'document_blobs') {
            blobReads.push(id);
            return snapshot(id, blobs.get(id) ?? null);
          }
          return snapshot(id, null);
        },
      }),
    }),
    runTransaction: jest.fn(),
  },
}));

// ── Storage boundary ─────────────────────────────────────────────────────────
interface StoredObject {
  bytes: Buffer;
  contentType: string;
  uploadedBy?: string;
}
const objects = new Map<string, StoredObject>();
const storageMetadataReads: string[] = [];
const storageDownloads: string[] = [];

jest.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (path: string) => ({
        exists: async () => [objects.has(path)],
        getMetadata: async () => {
          storageMetadataReads.push(path);
          const object = objects.get(path)!;
          return [
            {
              contentType: object.contentType,
              generation: '1',
              metadata: object.uploadedBy === undefined ? {} : { uploadedBy: object.uploadedBy },
            },
          ];
        },
        download: async () => {
          storageDownloads.push(path);
          return [objects.get(path)!.bytes];
        },
      }),
    }),
  }),
}));

// ── cascade collaborators: never reached by a read, kept out of the graph ────
jest.mock('@/lib/relations-cascade-admin', () => ({ adminDeleteRelationsForEntity: jest.fn() }));
jest.mock('@/lib/entity-document-link-delete-admin', () => ({ adminDeleteLinksForDocument: jest.fn() }));
jest.mock('@/lib/document-chunk-admin', () => ({ adminDeleteChunksForDocument: jest.fn() }));
jest.mock('@/lib/document-storage-service', () => ({ validateFile: jest.fn() }));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: jest.fn() } }));

// ── auth boundary ────────────────────────────────────────────────────────────
const authenticatedUid = { current: OWNER_UID as string | null };
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn(async () =>
    authenticatedUid.current === null
      ? { authenticated: false, error: 'Firebase ID token has expired.' }
      : { authenticated: true, uid: authenticatedUid.current, email: 'x@example.com' }
  ),
}));

import { NextRequest } from 'next/server';

const { GET } = require('@/app/api/documents/download/route') as {
  GET: (request: NextRequest) => Promise<Response>;
};

function download(id: string): Promise<Response> {
  const url = new URL('http://localhost:3000/api/documents/download');
  url.searchParams.set('id', id);
  return GET(new NextRequest(url, { method: 'GET', headers: { Authorization: 'Bearer token' } }));
}

/** Total reads that could have touched stored content. */
function contentReadCount(): number {
  return blobReads.length + storageMetadataReads.length + storageDownloads.length;
}

function seedDocument(id: string, data: Record<string, unknown>) {
  documents.set(id, data);
}

function seedStorageObject(path: string, object: StoredObject) {
  objects.set(path, object);
}

function seedFallbackBlob(path: string, data: { content: string; mimeType: string; userId?: string }) {
  blobs.set(path.replace(/\//g, '_'), {
    content: Buffer.from(data.content, 'utf8').toString('base64'),
    mimeType: data.mimeType,
    size: Buffer.byteLength(data.content, 'utf8'),
    storagePath: path,
    ...(data.userId === undefined ? {} : { userId: data.userId }),
  });
}

describe('SEC-015 document download authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    documents.clear();
    blobs.clear();
    objects.clear();
    documentReads.length = 0;
    blobReads.length = 0;
    storageMetadataReads.length = 0;
    storageDownloads.length = 0;
    authenticatedUid.current = OWNER_UID;
  });

  it('serves the owner their Storage-backed document', async () => {
    seedStorageObject('documents/owner-uid/1700-abcd-quarterly.pdf', {
      bytes: Buffer.from('%PDF-1.7 owner bytes'),
      contentType: 'application/pdf',
      uploadedBy: OWNER_UID,
    });
    seedDocument('doc-owned', {
      title: 'Quarterly',
      type: 'pdf',
      storageUrl: 'documents/owner-uid/1700-abcd-quarterly.pdf',
      uploadedBy: OWNER_UID,
    });

    const response = await download('doc-owned');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="quarterly.pdf"');
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('%PDF-1.7 owner bytes');
  });

  it('serves the owner their Firestore-fallback document (the seeded showcase variant)', async () => {
    // The seeded corpus deliberately uses a non-owner-scoped `documents/demo/…`
    // path, so this variant proves the gate reads ownership from Firestore.
    seedFallbackBlob('documents/demo/doc-brief.md', {
      content: '# Compliance brief',
      mimeType: 'text/markdown',
      userId: OWNER_UID,
    });
    seedDocument('doc-brief', {
      title: 'EU AI Act brief',
      type: 'markdown',
      storageUrl: 'documents/demo/doc-brief.md',
      uploadedBy: OWNER_UID,
    });

    const response = await download('doc-brief');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# Compliance brief');
  });

  it("refuses another owner's document without reading any content", async () => {
    seedStorageObject('documents/owner-uid/1700-abcd-secret.pdf', {
      bytes: Buffer.from('victim bytes'),
      contentType: 'application/pdf',
      uploadedBy: OWNER_UID,
    });
    seedFallbackBlob('documents/owner-uid/1700-abcd-secret.pdf', {
      content: 'victim fallback bytes',
      mimeType: 'application/pdf',
      userId: OWNER_UID,
    });
    seedDocument('doc-victim', {
      title: 'Board compensation',
      type: 'pdf',
      storageUrl: 'documents/owner-uid/1700-abcd-secret.pdf',
      uploadedBy: OWNER_UID,
    });
    authenticatedUid.current = ATTACKER_UID;

    const response = await download('doc-victim');
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'Document not found' });
    expect(body).not.toContain('Board compensation');
    expect(body).not.toContain('victim');
    // The document metadata read is required to KNOW the owner; nothing beyond
    // it may happen. Content is never touched.
    expect(documentReads).toEqual(['doc-victim']);
    expect(contentReadCount()).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '  '],
  ])('refuses an ownerless legacy record (%s uploader) without reading any content', async (_label, uploadedBy) => {
    seedFallbackBlob('documents/legacy/old.pdf', {
      content: 'legacy bytes',
      mimeType: 'application/pdf',
    });
    seedDocument('doc-legacy', {
      title: 'Legacy upload',
      type: 'pdf',
      storageUrl: 'documents/legacy/old.pdf',
      ...(uploadedBy === undefined ? {} : { uploadedBy }),
    });

    const response = await download('doc-legacy');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Document not found' });
    expect(contentReadCount()).toBe(0);
  });

  it('makes absent, foreign, and ownerless documents byte-identical (no existence oracle)', async () => {
    seedDocument('doc-foreign', { title: 'Foreign', type: 'pdf', storageUrl: 'x', uploadedBy: 'someone-else' });
    seedDocument('doc-ownerless', { title: 'Ownerless', type: 'pdf', storageUrl: 'x' });

    const responses = await Promise.all([download('doc-absent'), download('doc-foreign'), download('doc-ownerless')]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(responses.map((response) => response.headers.get('content-type'))).size).toBe(1);
  });

  it('refuses a machine-generated document that no user owns', async () => {
    seedDocument('doc-verdict', {
      title: 'Evaluation Verdict',
      type: 'markdown',
      storageUrl: '',
      uploadedBy: 'build-mission',
      visibility: 'workspace',
    });

    const response = await download('doc-verdict');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Document not found' });
    expect(contentReadCount()).toBe(0);
  });

  it("refuses an owned record that names another user's Storage object", async () => {
    // The emulator rules let a browser CREATE a document, so `storageUrl` is
    // caller-influenced data. Owning the RECORD must not grant the bytes.
    seedStorageObject('documents/owner-uid/1700-abcd-secret.pdf', {
      bytes: Buffer.from('victim bytes'),
      contentType: 'application/pdf',
      uploadedBy: OWNER_UID,
    });
    seedDocument('doc-forged', {
      title: 'Forged pointer',
      type: 'pdf',
      storageUrl: 'documents/owner-uid/1700-abcd-secret.pdf',
      uploadedBy: ATTACKER_UID,
    });
    authenticatedUid.current = ATTACKER_UID;

    const response = await download('doc-forged');

    expect(response.status).toBe(404);
    // The uploader contradiction is detected from metadata; the bytes are never
    // downloaded into this process.
    expect(storageDownloads).toEqual([]);
  });

  it("refuses an owned record that names another user's fallback blob", async () => {
    seedFallbackBlob('documents/owner-uid/1700-abcd-secret.md', {
      content: 'victim fallback bytes',
      mimeType: 'text/markdown',
      userId: OWNER_UID,
    });
    seedDocument('doc-forged-blob', {
      title: 'Forged pointer',
      type: 'markdown',
      storageUrl: 'documents/owner-uid/1700-abcd-secret.md',
      uploadedBy: ATTACKER_UID,
    });
    authenticatedUid.current = ATTACKER_UID;

    const response = await download('doc-forged-blob');

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('victim fallback bytes');
  });

  it('rejects an unauthenticated caller with a bounded body, before any read', async () => {
    seedDocument('doc-owned', { title: 'Owned', type: 'pdf', storageUrl: 'x', uploadedBy: OWNER_UID });
    authenticatedUid.current = null;

    const response = await download('doc-owned');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required' });
    expect(documentReads).toEqual([]);
    expect(contentReadCount()).toBe(0);
  });

  it('logs the refusal reason without the uid, owner, title, or storage path', async () => {
    seedDocument('doc-victim', {
      title: 'Board compensation',
      type: 'pdf',
      storageUrl: 'documents/owner-uid/1700-abcd-secret.pdf',
      uploadedBy: OWNER_UID,
    });
    authenticatedUid.current = ATTACKER_UID;

    await download('doc-victim');

    expect(logWarn).toHaveBeenCalledWith('Refused document content read', {
      id: 'doc-victim',
      reason: 'not-owner',
    });
    const logged = JSON.stringify(logWarn.mock.calls);
    expect(logged).not.toContain(OWNER_UID);
    expect(logged).not.toContain(ATTACKER_UID);
    expect(logged).not.toContain('Board compensation');
    expect(logged).not.toContain('documents/owner-uid');
  });
});
