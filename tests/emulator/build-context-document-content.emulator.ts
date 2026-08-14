/**
 * BUILD-036 — real-Firestore acceptance for the build-context manifest's
 * document content and readiness truth.
 *
 * Why an emulator lane rather than the browser acceptance: resolving a context
 * manifest is a server-only admin-SDK path, and the only UI that triggers it is
 * a PAID build dispatch. This drives `resolveBuildContextForUser` directly
 * against real Firestore documents and chunks, so the manifest is proven end to
 * end at zero provider spend.
 *
 * The defect it pins: `getDocument` mapped `content: d.description`. A
 * `Document`'s `description` is optional metadata — empty for most uploaded files
 * and fetched URLs — while the real text lives in the extracted chunks, which
 * were never read. A live Limitless dispatch therefore requested and "resolved"
 * 15 typed refs while 4/5 processed Document refs supplied ZERO content bytes,
 * and the manifest still counted every one of them as resolved.
 *
 * All ids are run-scoped; cleanup is restricted to those ids.
 */

/** Lane-private project: nothing here may reach a developer's retained stack. */
const PROJECT_ID = 'demo-build-context';
const LOOPBACK_EMULATOR_HOST = /^(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+$/;
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const RUN_ACCEPTANCE = process.env.BUILD_CONTEXT_CONTENT_ACCEPTANCE_DISPOSABLE === 'true';

if (RUN_ACCEPTANCE) {
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
    throw new Error('build-context-document-content.emulator.ts requires emulator mode');
  }
  if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
    throw new Error(`build-context-document-content.emulator.ts requires project ${PROJECT_ID}`);
  }
  if (!emulatorHost || !LOOPBACK_EMULATOR_HOST.test(emulatorHost)) {
    throw new Error('build-context-document-content.emulator.ts requires a loopback Firestore emulator');
  }
}

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import {
  isContextItemContentUnavailable,
  renderContextManifestSection,
  resolveBuildContextForUser,
  summarizeContextReadiness,
  validateStoredBuildContextManifest,
} from '@/lib/build-mission-context';
import { BUILD_CONTEXT_MAX_ITEM_BYTES } from '@/lib/schemas/mission-build';

const RUN = `bctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `user-${RUN}`;
const STRANGER = `stranger-${RUN}`;

const DOCUMENT_IDS = new Set<string>();
const CHUNK_IDS = new Set<string>();

const AVAILABLE_ID = `${RUN}-available`;
const EMPTY_ID = `${RUN}-empty`;
const FOREIGN_ID = `${RUN}-foreign`;
const BIG_ID = `${RUN}-big`;

const CHUNK_BODY = `Extracted body for ${RUN} that exists only as a document chunk.`;

async function seedDocument(
  id: string,
  fields: { uploadedBy: string; description?: string; chunkCount?: number }
): Promise<void> {
  DOCUMENT_IDS.add(id);
  await db
    .collection('documents')
    .doc(id)
    .set({
      id,
      title: `Context document ${id}`,
      type: 'pdf',
      status: 'processed',
      storageUrl: `documents/${id}.pdf`,
      uploadedBy: fields.uploadedBy,
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      chunkCount: fields.chunkCount ?? 0,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
}

async function seedChunks(documentId: string, contents: string[]): Promise<void> {
  for (const [index, content] of contents.entries()) {
    const id = `${documentId}-chunk-${index}`;
    CHUNK_IDS.add(id);
    await db
      .collection('documentChunks')
      .doc(id)
      .set({
        id,
        documentId,
        content,
        chunkIndex: index,
        tokenCount: 16,
        metadata: { startChar: 0, endChar: content.length },
        createdAt: Timestamp.now(),
        // Deliberately NO `archived` field — the shape the processing pipeline
        // actually writes, and the shape an index-backed filter would miss.
      });
  }
}

afterAll(async () => {
  for (const id of CHUNK_IDS) await db.collection('documentChunks').doc(id).delete();
  for (const id of DOCUMENT_IDS) await db.collection('documents').doc(id).delete();

  // Exact-residue proof: nothing carrying this run's prefix may survive.
  const documents = await db.collection('documents').get();
  expect(documents.docs.filter((doc) => doc.id.includes(RUN)).map((doc) => doc.id)).toEqual([]);
  const chunks = await db.collection('documentChunks').get();
  expect(
    chunks.docs
      .filter((doc) => doc.id.includes(RUN) || String(doc.data().documentId ?? '').includes(RUN))
      .map((doc) => doc.id)
  ).toEqual([]);
});

(RUN_ACCEPTANCE ? describe : describe.skip)('BUILD-036 build-context document content (real Firestore)', () => {
  it('resolves a processed document to its extracted chunk text', async () => {
    await seedDocument(AVAILABLE_ID, { uploadedBy: OWNER, chunkCount: 2 });
    await seedChunks(AVAILABLE_ID, [CHUNK_BODY, `${CHUNK_BODY} Second part.`]);

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: AVAILABLE_ID }]);

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].excerpt).toContain('Extracted body for');
    expect(manifest.items[0].bytes).toBeGreaterThan(0);
    expect(isContextItemContentUnavailable(manifest.items[0])).toBe(false);
    expect(manifest.counts.ready).toBe(1);
    expect(manifest.counts.degraded).toBe(0);
  });

  it('distinguishes an available document from an empty one in the SAME manifest', async () => {
    await seedDocument(AVAILABLE_ID, { uploadedBy: OWNER, chunkCount: 2 });
    await seedChunks(AVAILABLE_ID, [CHUNK_BODY]);
    // Processed but genuinely empty: no description, no chunks. This is the 4/5
    // shape the live dispatch hit, and it must not read as usable context.
    await seedDocument(EMPTY_ID, { uploadedBy: OWNER, chunkCount: 0 });

    const manifest = await resolveBuildContextForUser(OWNER, [
      { kind: 'document', id: AVAILABLE_ID },
      { kind: 'document', id: EMPTY_ID },
    ]);

    expect(manifest.counts.requested).toBe(2);
    expect(manifest.counts.resolved).toBe(2);
    // Resolved is NOT ready — the whole point of the row.
    expect(manifest.counts.ready).toBe(1);
    expect(manifest.counts.degraded).toBe(1);
    expect(summarizeContextReadiness(manifest)).toEqual({ ready: 1, degraded: 1 });

    const byId = new Map(manifest.items.map((item) => [item.refId, item]));
    expect(isContextItemContentUnavailable(byId.get(AVAILABLE_ID)!)).toBe(false);
    expect(isContextItemContentUnavailable(byId.get(EMPTY_ID)!)).toBe(true);

    // The sandbox's MISSION.md must SAY so, not render a bullet ending in a bare
    // em dash that reads like content beginning with a blank.
    const section = renderContextManifestSection(manifest);
    expect(section).toContain('no readable content');
    expect(section).toMatch(/1 of 2 resolved reference\(s\) carry readable content; 1 are empty/);
  });

  it('never opens a foreign document, and reports it as unauthorized', async () => {
    await seedDocument(FOREIGN_ID, { uploadedBy: STRANGER, chunkCount: 1 });
    await seedChunks(FOREIGN_ID, ['Content the requesting user must never receive.']);

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: FOREIGN_ID }]);

    expect(manifest.items).toEqual([]);
    expect(manifest.omitted).toEqual([{ kind: 'document', refId: FOREIGN_ID, reason: 'unauthorized' }]);
    // Not a single byte of the stranger's text may appear anywhere.
    expect(JSON.stringify(manifest)).not.toContain('must never receive');
  });

  it('keeps a large document inside the per-item byte cap and marks it truncated', async () => {
    await seedDocument(BIG_ID, { uploadedBy: OWNER, chunkCount: 10 });
    await seedChunks(
      BIG_ID,
      Array.from({ length: 10 }, (_, index) => `${'y'.repeat(1_000)} chunk ${index}`)
    );

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: BIG_ID }]);

    expect(manifest.items[0].truncated).toBe(true);
    expect(manifest.items[0].bytes).toBeLessThanOrEqual(BUILD_CONTEXT_MAX_ITEM_BYTES);
    expect(manifest.items[0].bytes).toBe(Buffer.byteLength(manifest.items[0].excerpt, 'utf8'));
  });

  it('produces a manifest the worker boundary accepts unchanged', async () => {
    await seedDocument(AVAILABLE_ID, { uploadedBy: OWNER, description: 'Survey metadata.', chunkCount: 1 });
    await seedChunks(AVAILABLE_ID, [CHUNK_BODY]);
    await seedDocument(EMPTY_ID, { uploadedBy: OWNER, chunkCount: 0 });

    const manifest = await resolveBuildContextForUser(OWNER, [
      { kind: 'document', id: AVAILABLE_ID },
      { kind: 'document', id: EMPTY_ID },
    ]);

    // Round-trip through Firestore so the check runs on what the supervisor
    // would actually read back, not on the in-memory object.
    const missionRef = db.collection('missions').doc(`${RUN}-mission`);
    await missionRef.set({ contextManifest: manifest });
    const stored = (await missionRef.get()).data()!.contextManifest;
    await missionRef.delete();

    const validated = validateStoredBuildContextManifest(stored);
    expect(validated.digest).toBe(manifest.digest);
    expect(validated.counts.ready).toBe(1);
    expect(validated.counts.degraded).toBe(1);
    // Both fields carry the document's own description AND its chunk text.
    const available = validated.items.find((item) => item.refId === AVAILABLE_ID)!;
    expect(available.excerpt).toContain('Survey metadata.');
    expect(available.excerpt).toContain('Extracted body for');
  });
});
