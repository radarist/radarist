/**
 * @file lib/__tests__/build-mission-context-resolvers.test.ts
 * @description BUILD-036 — pins the PRODUCTION resolver wiring behind
 * `resolveBuildContextForUser`.
 *
 * `build-mission-context.test.ts` covers the pure core with injected resolvers,
 * so it could never have caught the defect this file exists for: the real
 * `getDocument` resolver mapped `content: d.description`. A `Document`'s
 * `description` is optional metadata — for an uploaded PDF or a fetched URL it
 * is usually empty, while the document's actual text lives in its extracted
 * chunks. A live Limitless dispatch therefore requested and "resolved" 15 typed
 * refs of which 4/5 processed Document refs supplied ZERO content bytes, and
 * the manifest still counted them as resolved.
 *
 * Everything here is admin-SDK mocked: no emulator, no network, no spend.
 */

// firebase-admin itself is never loaded (it transitively pulls ESM jwks-rsa).
const mockDocGet = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => ({ doc: () => ({ get: mockDocGet }) }),
  },
  adminAuth: {},
  adminApp: {},
}));

jest.mock('@/lib/companies-admin', () => ({ adminGetCompanyById: jest.fn() }));
jest.mock('@/lib/document-admin', () => ({ adminGetDocumentById: jest.fn() }));
jest.mock('@/lib/reports', () => ({ getReportById: jest.fn() }));
jest.mock('@/lib/document-chunk-admin', () => ({ adminGetActiveChunksForDocument: jest.fn() }));

import { adminGetDocumentById } from '@/lib/document-admin';
import { adminGetActiveChunksForDocument } from '@/lib/document-chunk-admin';
import type { Document, DocumentChunk } from '@/lib/types';

import { resolveBuildContextForUser, isContextItemContentUnavailable } from '../build-mission-context';

const OWNER = 'user-1';

const mockGetDocument = jest.mocked(adminGetDocumentById);
const mockGetActiveChunks = jest.mocked(adminGetActiveChunksForDocument);

/** A processed document whose text exists ONLY as extracted chunks. */
function processedDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 'd1',
    title: 'Sensor Fusion Whitepaper',
    type: 'pdf',
    status: 'processed',
    storageUrl: 'documents/user-1/d1.pdf',
    uploadedBy: OWNER,
    chunkCount: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as Document;
}

function chunk(content: string, chunkIndex: number): DocumentChunk {
  return {
    id: `c${chunkIndex}`,
    documentId: 'd1',
    content,
    chunkIndex,
    metadata: { startChar: 0, endChar: content.length },
    createdAt: 1,
  } as DocumentChunk;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveChunks.mockResolvedValue([]);
  mockDocGet.mockResolvedValue({ exists: false, data: () => ({}) });
});

describe('resolveBuildContextForUser — document content (BUILD-036)', () => {
  it('supplies the extracted chunk text when the document carries no description', async () => {
    mockGetDocument.mockResolvedValue(processedDocument({ description: undefined }));
    mockGetActiveChunks.mockResolvedValue([
      chunk('Time-of-flight sensors dominate the low-cost tier.', 0),
      chunk('LiDAR remains the accuracy ceiling for outdoor rigs.', 1),
    ]);

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: 'd1' }]);

    expect(manifest.items).toHaveLength(1);
    const item = manifest.items[0];
    expect(item.bytes).toBeGreaterThan(0);
    expect(item.excerpt).toContain('Time-of-flight sensors');
    expect(item.excerpt).toContain('LiDAR remains the accuracy ceiling');
    expect(isContextItemContentUnavailable(item)).toBe(false);
    expect(manifest.counts.ready).toBe(1);
    expect(manifest.counts.degraded).toBe(0);
  });

  it('reads chunks only AFTER ownership passes, so a foreign document is never opened', async () => {
    mockGetDocument.mockResolvedValue(processedDocument({ uploadedBy: 'someone-else' }));

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: 'd1' }]);

    expect(manifest.items).toEqual([]);
    expect(manifest.omitted[0]?.reason).toBe('unauthorized');
    expect(mockGetActiveChunks).not.toHaveBeenCalled();
  });

  it('marks a document with neither description nor chunks as content-unavailable, not ready', async () => {
    mockGetDocument.mockResolvedValue(processedDocument({ description: undefined, chunkCount: 0 }));
    mockGetActiveChunks.mockResolvedValue([]);

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: 'd1' }]);

    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].bytes).toBe(0);
    expect(isContextItemContentUnavailable(manifest.items[0])).toBe(true);
    // Resolved, but NOT ready: zero-byte context must never read as usable.
    expect(manifest.counts.resolved).toBe(1);
    expect(manifest.counts.ready).toBe(0);
    expect(manifest.counts.degraded).toBe(1);
  });

  it('keeps the extracted text inside the per-item byte cap', async () => {
    mockGetDocument.mockResolvedValue(processedDocument({ description: undefined }));
    // Ten 1 KB chunks — far more than one item may disclose.
    mockGetActiveChunks.mockResolvedValue(Array.from({ length: 10 }, (_, i) => chunk('x'.repeat(1000), i)));

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: 'd1' }]);

    const item = manifest.items[0];
    expect(item.truncated).toBe(true);
    expect(item.bytes).toBeLessThanOrEqual(4_000);
    expect(item.bytes).toBe(Buffer.byteLength(item.excerpt, 'utf8'));
  });

  it('prefers the description AND the extracted text, not one or the other', async () => {
    mockGetDocument.mockResolvedValue(processedDocument({ description: 'Vendor-neutral sensor survey.' }));
    mockGetActiveChunks.mockResolvedValue([chunk('Body text that only the chunks carry.', 0)]);

    const manifest = await resolveBuildContextForUser(OWNER, [{ kind: 'document', id: 'd1' }]);

    expect(manifest.items[0].excerpt).toContain('Vendor-neutral sensor survey.');
    expect(manifest.items[0].excerpt).toContain('Body text that only the chunks carry.');
  });
});
