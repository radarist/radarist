/**
 * AI-021 — generated-document contract against REAL Firestore + Storage
 * emulators (no live research spend: the Gemini deep-research client is
 * replaced with deterministic fixtures; everything else is the real code).
 *
 * Runs via `npm run test:emulator` (which owns emulator lifecycle), or
 * standalone through `firebase emulators:exec --only auth,firestore,storage`.
 *
 * Proven here (manual-validation items):
 * - Assistant-created research transitions processing → processed, with
 *   nonempty canonical storage content and chunk rows.
 * - A simulated research failure ends `failed`, never processed/uploaded.
 * - A rejected job dispatch ends `failed` and the tool THROWS (no fake
 *   "I've started..." success).
 * - Replaying the job steps converges (retry safety, no duplicate chunks).
 */

const mockSentEvents: Array<{ name: string; data: Record<string, unknown> }> = [];
let mockAcceptDispatch = true;

jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: {
    createFunction: jest.fn(
      (
        _config: unknown,
        _trigger: unknown,
        handler: (input: {
          event: { data: unknown };
          step: {
            run: <T>(name: string, operation: () => T | Promise<T>) => Promise<T>;
            sleep: (name: string, duration: string) => Promise<void>;
          };
        }) => Promise<unknown>
      ) => ({
        execute: (data: unknown) =>
          handler({
            event: { data },
            step: {
              run: async <T>(_name: string, operation: () => T | Promise<T>) => operation(),
              sleep: async () => undefined,
            },
          }),
      })
    ),
    send: jest.fn(async (event: { name: string; data: Record<string, unknown> }) => {
      mockSentEvents.push(event);
      return { ids: ['deep-research-emulator-ack'] };
    }),
  },
  safeSendEvent: jest.fn(async (event: { name: string; data: Record<string, unknown> }) => {
    if (!mockAcceptDispatch) return false;
    mockSentEvents.push(event);
    return true;
  }),
}));

// Deterministic research fixtures — NO live Gemini calls.
const mockStartDeepResearch = jest.fn();
const mockPollDeepResearch = jest.fn();
jest.mock('@/lib/ai/deep-research-client', () => ({
  __esModule: true,
  startDeepResearch: (...args: unknown[]) => mockStartDeepResearch(...args),
  pollDeepResearch: (...args: unknown[]) => mockPollDeepResearch(...args),
}));

import { adminGetDocumentById } from '@/lib/document-admin';
import { adminGetDocumentContent } from '@/lib/document-storage-admin';
import { DeepResearchDispatchError, dispatchDeepResearchDocument } from '@/lib/deep-research-document-admin';
import { runDocumentDeepResearchJob } from '@/lib/inngest/functions/run-document-deep-research';
import { db as adminDb } from '@/lib/firebase-admin';
import { getStorage as getAdminStorage } from 'firebase-admin/storage';

if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
  throw new Error('deep-research-contract.emulator.ts must run against the Firebase emulators');
}
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  throw new Error('Firestore and Storage emulator hosts must be supplied by firebase emulators:exec');
}
if (process.env.NEO4J_URI) {
  throw new Error('This lane owns Firebase emulators only; NEO4J_URI must be empty');
}

const RUN_PREFIX = `test017b-${Date.now()}`;
const USER_ID = `${RUN_PREFIX}-user`;
const RESEARCH_TEXT = [
  '# Post-Quantum Cryptography Adoption',
  '',
  'Deterministic emulator fixture content. '.repeat(60),
  '',
  'A second section so chunking produces multiple rows. '.repeat(60),
].join('\n');

interface ExecutableJob {
  execute(data: Record<string, unknown>): Promise<unknown>;
}

const documentIds: string[] = [];

afterAll(async () => {
  // Guaranteed cleanup: documents, chunks, and storage objects.
  for (const documentId of documentIds) {
    const chunks = await adminDb.collection('documentChunks').where('documentId', '==', documentId).get();
    const batch = adminDb.batch();
    for (const chunk of chunks.docs) batch.delete(chunk.ref);
    batch.delete(adminDb.collection('documents').doc(documentId));
    await batch.commit();
  }
  const [files] = await getAdminStorage()
    .bucket(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET)
    .getFiles({ prefix: 'documents/' });
  for (const file of files) {
    if (file.name.includes('deep-research-') && documentIds.some((id) => file.name.includes(id))) {
      await file.delete();
    }
  }
  // Residue check: nothing owned by this run remains.
  for (const documentId of documentIds) {
    expect((await adminDb.collection('documents').doc(documentId).get()).exists).toBe(false);
    expect((await adminDb.collection('documentChunks').where('documentId', '==', documentId).get()).empty).toBe(true);
  }
});

beforeEach(() => {
  mockSentEvents.length = 0;
  mockAcceptDispatch = true;
  mockStartDeepResearch.mockReset();
  mockPollDeepResearch.mockReset();
});

describe('deep-research generated-document contract (AI-021, real emulators)', () => {
  it('dispatches in a truthful processing state and completes processing → processed with stored content and chunks', async () => {
    const document = await dispatchDeepResearchDocument({
      query: `${RUN_PREFIX} post-quantum cryptography adoption`,
      userId: USER_ID,
      tags: ['pqc'],
    });
    documentIds.push(document.id);

    // Truthful initial state: processing, nothing claimed as uploaded.
    expect(document.status).toBe('processing');
    expect(document.storageUrl).toBe('');
    expect(document.tags).toEqual(expect.arrayContaining(['pqc', 'deep-research']));
    expect(document.description).toContain('Deep research:');
    expect(document.uploadedBy).toBe(USER_ID);

    const dispatched = mockSentEvents.find((e) => e.name === 'app/document.deep-research.requested');
    expect(dispatched?.data).toMatchObject({ documentId: document.id, userId: USER_ID });

    // Run the REAL job handler with deterministic research output.
    mockStartDeepResearch.mockResolvedValue({ interactionId: `${RUN_PREFIX}-interaction` });
    mockPollDeepResearch.mockResolvedValue({ status: 'completed', text: RESEARCH_TEXT });
    const job = runDocumentDeepResearchJob as unknown as ExecutableJob;
    await job.execute(dispatched!.data);

    const processed = await adminGetDocumentById(document.id);
    expect(processed?.status).toBe('processed');
    expect(processed?.storageUrl).toBeTruthy();
    expect(processed?.chunkCount).toBeGreaterThan(1);
    expect(processed?.researchEvidence?.verdict).toBe('insufficient');

    // Canonical storage readback: the metadata describes the exact persisted
    // AI-038 annotated artifact, not the raw provider response.
    const content = await adminGetDocumentContent(processed!.storageUrl);
    expect(content).not.toBeNull();
    const persistedText = content!.content.toString('utf-8');
    expect(processed?.fileSize).toBe(Buffer.byteLength(persistedText, 'utf-8'));
    expect(persistedText).toContain('Evidence review — insufficient primary evidence');
    expect(persistedText).toContain('Treat every claim below as UNVERIFIED');
    expect(persistedText).toContain('Post-Quantum Cryptography');

    // Chunk rows exist in Firestore.
    const chunks = await adminDb.collection('documentChunks').where('documentId', '==', document.id).get();
    expect(chunks.size).toBe(processed?.chunkCount);
    expect(chunks.docs.some((chunk) => String(chunk.data().content).includes('Treat every claim below as UNVERIFIED'))).toBe(
      true
    );

    // Graph handoff was requested for this document.
    expect(
      mockSentEvents.some((e) => e.name === 'app/document.sync.requested' && e.data.documentId === document.id)
    ).toBe(true);

    // Retry safety: replaying the job converges — same terminal state, no
    // duplicate chunk rows.
    await job.execute(dispatched!.data);
    const replayed = await adminGetDocumentById(document.id);
    expect(replayed?.status).toBe('processed');
    const chunksAfterReplay = await adminDb.collection('documentChunks').where('documentId', '==', document.id).get();
    expect(chunksAfterReplay.size).toBe(processed?.chunkCount);
  });

  it('a simulated research failure ends failed — never processed, no storage claim', async () => {
    const document = await dispatchDeepResearchDocument({
      query: `${RUN_PREFIX} failing research topic`,
      userId: USER_ID,
    });
    documentIds.push(document.id);

    const dispatched = mockSentEvents.find(
      (e) => e.name === 'app/document.deep-research.requested' && e.data.documentId === document.id
    );
    mockStartDeepResearch.mockResolvedValue({ interactionId: `${RUN_PREFIX}-fail-interaction` });
    mockPollDeepResearch.mockResolvedValue({
      status: 'failed',
      reason: 'Deep research requires action: quota exhausted',
    });

    const job = runDocumentDeepResearchJob as unknown as ExecutableJob;
    await expect(job.execute(dispatched!.data)).rejects.toThrow('quota exhausted');

    const failed = await adminGetDocumentById(document.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toContain('quota exhausted');
    expect(failed?.storageUrl).toBe('');
    expect(failed?.processedAt).toBeUndefined();
  });

  it('a rejected dispatch marks the document failed and throws — no fake started-success', async () => {
    mockAcceptDispatch = false;

    let thrown: unknown;
    try {
      await dispatchDeepResearchDocument({
        query: `${RUN_PREFIX} undispatchable topic`,
        userId: USER_ID,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeepResearchDispatchError);
    const documentId = (thrown as DeepResearchDispatchError).documentId;
    documentIds.push(documentId);

    const failed = await adminGetDocumentById(documentId);
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toMatch(/could not be started/i);
  });
});
