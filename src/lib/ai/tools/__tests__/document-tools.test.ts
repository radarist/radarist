/**
 * @jest-environment node
 *
 * @file ai/tools/__tests__/document-tools.test.ts
 * @description Unit tests for the mission-scoped `draftDocument` executor. The
 * admin write path (Storage upload, Firestore create, chunking, sync event) is
 * fully mocked so no Firebase/Inngest is hit.
 */

const mockAdminUploadDocument = jest.fn();
const mockAdminCreateDocument = jest.fn();
const mockProcessDocumentFromContent = jest.fn();
const mockInngestSend = jest.fn();

jest.mock('@/lib/document-storage-admin', () => ({
  adminUploadDocument: (...a: unknown[]) => mockAdminUploadDocument(...a),
}));
jest.mock('@/lib/document-admin', () => ({
  adminCreateDocument: (...a: unknown[]) => mockAdminCreateDocument(...a),
  adminGetDocuments: jest.fn(),
  adminGetDocumentById: jest.fn(),
}));
jest.mock('@/lib/document-processing-service', () => ({
  processDocumentFromContent: (...a: unknown[]) => mockProcessDocumentFromContent(...a),
}));
jest.mock('@/lib/document-chunk-admin', () => ({
  adminGetChunksForDocument: jest.fn(),
  adminGetChunkById: jest.fn(),
  adminSearchChunksSimple: jest.fn(),
}));
const mockBuildEntitySnapshot = jest.fn();
jest.mock('@/lib/relations-admin', () => ({
  adminCreateRelation: jest.fn(),
  buildEntitySnapshot: (...a: unknown[]) => mockBuildEntitySnapshot(...a),
}));
const mockAdminFindExistingLink = jest.fn();
const mockAdminCreateEntityDocumentLink = jest.fn();
jest.mock('@/lib/entity-document-link-admin', () => ({
  adminFindExistingLink: (...a: unknown[]) => mockAdminFindExistingLink(...a),
  adminCreateEntityDocumentLink: (...a: unknown[]) => mockAdminCreateEntityDocumentLink(...a),
}));
const mockSearchEntityCandidatesByName = jest.fn();
jest.mock('../entity-creation', () => ({
  searchEntityCandidatesByName: (...a: unknown[]) => mockSearchEntityCandidatesByName(...a),
  normalizeEntityReferenceName: (value: string) =>
    value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
}));
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => mockInngestSend(...a) } }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { executeDraftDocument, executeLinkDocumentToEntity } from '../document-tools';
import { adminGetDocumentById, adminGetDocuments } from '@/lib/document-admin';

const CTX = { missionId: 'mission-1', userId: 'user-1' };
const BODY = '# Patent Landscape\n\nA sufficiently long markdown body to pass the length gate.';

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminUploadDocument.mockResolvedValue({ success: true, storageUrl: 'documents/user-1/123-x.md', size: 42 });
  mockAdminCreateDocument.mockResolvedValue({ id: 'doc-1', title: 'Patent Landscape: Vector Databases' });
  mockProcessDocumentFromContent.mockResolvedValue({ success: true, chunkCount: 3 });
  mockInngestSend.mockResolvedValue(undefined);
});

describe('executeDraftDocument', () => {
  it('uploads → creates (type:markdown, storageUrl, sourceMissionId) → chunks → sync; returns id+url', async () => {
    const res = await executeDraftDocument(
      { title: 'Patent Landscape: Vector Databases', markdownBody: BODY, tags: ['patents'], summary: 'A summary.' },
      CTX
    );
    expect(res).toEqual({ success: true, documentId: 'doc-1', url: '/library/documents' });

    // upload: real Buffer of the body, markdown mime, uploader id
    expect(mockAdminUploadDocument).toHaveBeenCalledTimes(1);
    const [buf, fileName, mime, uid] = mockAdminUploadDocument.mock.calls[0] as [Buffer, string, string, string];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toBe(BODY);
    expect(fileName).toMatch(/\.md$/);
    expect(mime).toBe('text/markdown');
    expect(uid).toBe('user-1');

    // create: the storageUrl comes from the upload result, provenance from the mission
    expect(mockAdminCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Patent Landscape: Vector Databases',
        type: 'markdown',
        storageUrl: 'documents/user-1/123-x.md',
        uploadedBy: 'user-1',
        sourceMissionId: 'mission-1',
        mimeType: 'text/markdown',
        tags: ['patents'],
        description: 'A summary.',
      })
    );

    // chunk + best-effort graph sync
    expect(mockProcessDocumentFromContent).toHaveBeenCalledWith('doc-1', BODY);
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'app/document.sync.requested',
      data: { documentId: 'doc-1', operation: 'create' },
    });
  });

  it('normalizes long decorated titles to the same bounded storage slug', async () => {
    const title = `${'-'.repeat(20_000)}Patent Landscape${'-'.repeat(20_000)}`;
    const res = await executeDraftDocument({ title, markdownBody: BODY }, CTX);

    expect(res.success).toBe(true);
    expect(mockAdminUploadDocument).toHaveBeenCalledWith(expect.any(Buffer), 'patent-landscape.md', 'text/markdown', 'user-1');
  });

  it('rejects when missionId is not bound — and does not touch storage', async () => {
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, { userId: 'user-1' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/missionId not bound/);
    expect(mockAdminUploadDocument).not.toHaveBeenCalled();
  });

  it('rejects when userId is missing', async () => {
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, { missionId: 'mission-1' });
    expect(res.success).toBe(false);
    expect(mockAdminUploadDocument).not.toHaveBeenCalled();
  });

  it('rejects an empty/too-short body without uploading', async () => {
    const res = await executeDraftDocument({ title: 'X', markdownBody: '  ' }, CTX);
    expect(res.success).toBe(false);
    expect(mockAdminUploadDocument).not.toHaveBeenCalled();
  });

  it('surfaces a storage-upload failure (a return value, not a throw) and does not create', async () => {
    mockAdminUploadDocument.mockResolvedValue({ success: false, error: 'bucket missing' });
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, CTX);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Storage upload failed/);
    expect(mockAdminCreateDocument).not.toHaveBeenCalled();
  });

  it('never throws — a Firestore create error becomes a typed failure', async () => {
    mockAdminCreateDocument.mockRejectedValue(new Error('firestore down'));
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, CTX);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/firestore down/);
  });

  it('treats a chunking failure as non-fatal — the document still persists', async () => {
    mockProcessDocumentFromContent.mockResolvedValue({ success: false, error: 'extract failed', stage: 'chunk' });
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, CTX);
    expect(res).toEqual({ success: true, documentId: 'doc-1', url: '/library/documents' });
  });

  it('treats a graph-sync dispatch failure as non-fatal', async () => {
    mockInngestSend.mockRejectedValue(new Error('inngest unavailable'));
    const res = await executeDraftDocument({ title: 'X', markdownBody: BODY }, CTX);
    expect(res.success).toBe(true);
    expect(res.documentId).toBe('doc-1');
  });
});

describe('executeLinkDocumentToEntity (AI-023)', () => {
  const DOC = { id: 'doc-1', title: 'Q3 Architecture Review' };
  const HUMAN_CTX = {
    userId: 'user-1',
    principal: 'human' as const,
    confirmationText: 'Link "Q3 Architecture Review" to Acme Corp',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (adminGetDocumentById as jest.Mock).mockResolvedValue(DOC);
    (adminGetDocuments as jest.Mock).mockResolvedValue([DOC, { id: 'doc-2', title: 'Unrelated Notes' }]);
    mockBuildEntitySnapshot.mockResolvedValue({ type: 'company', id: 'comp-1', name: 'Acme Corp', snapshotAt: 1 });
    mockSearchEntityCandidatesByName.mockResolvedValue([{ id: 'comp-1', name: 'Acme Corp' }]);
    mockAdminFindExistingLink.mockResolvedValue(null);
    // GRAPH-069: the admin create now returns the committed row alongside the
    // honest state of its graph handoff.
    mockAdminCreateEntityDocumentLink.mockResolvedValue({
      link: { id: 'link-1', entityId: 'comp-1', documentId: 'doc-1' },
      graphHandoff: { status: 'acknowledged' },
    });
  });

  it('refuses a machine principal without touching the link service', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      { userId: 'user-1', principal: 'machine', confirmationText: HUMAN_CTX.confirmationText }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/explicit/i);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses when no authenticated user is present', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      { principal: 'human', confirmationText: HUMAN_CTX.confirmationText }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/authenticated user/i);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('creates the link through the canonical admin service for an explicit id-addressed instruction', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      HUMAN_CTX
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ created: true, linkId: 'link-1' });
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledTimes(1);
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledWith({
      workspaceId: 'default',
      entityType: 'company',
      entityId: 'comp-1',
      documentId: 'doc-1',
      relationshipType: 'documentation',
      relevance: 'medium',
      tags: [],
      aiSuggested: false,
      createdBy: 'user-1',
    });
  });

  it('resolves exact names to ids when the instruction addresses both by name', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentTitle: 'Q3 Architecture Review', entityType: 'company', entityName: 'Acme Corp' },
      HUMAN_CTX
    );

    expect(res.success).toBe(true);
    expect(mockSearchEntityCandidatesByName).toHaveBeenCalledWith('company', 'Acme Corp', {
      prioritizeNormalizedExact: true,
    });
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'comp-1', documentId: 'doc-1' })
    );
  });

  it('resolves a unique normalized exact title and name despite case, compatibility, and whitespace differences', async () => {
    (adminGetDocuments as jest.Mock).mockResolvedValue([
      { id: 'doc-1', title: 'Q3 Architecture Review' },
      { id: 'doc-partial', title: 'Q3 Architecture Review Appendix' },
    ]);
    mockSearchEntityCandidatesByName.mockResolvedValue([
      { id: 'comp-1', name: 'Acme Corp' },
      { id: 'comp-partial', name: 'Acme Corp Holdings' },
    ]);

    const res = await executeLinkDocumentToEntity(
      {
        documentTitle: '  q3   architecture review  ',
        entityType: 'company',
        entityName: 'ＡCME   CORP',
      },
      HUMAN_CTX
    );

    expect(res.success).toBe(true);
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'comp-1', documentId: 'doc-1' })
    );
  });

  it('refuses a lone partial document-title match even when the current turn names the full document', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentTitle: 'Q3 Architecture', entityType: 'company', entityId: 'comp-1' },
      HUMAN_CTX
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exact document title/i);
    expect(res.data?.matchingDocuments).toEqual([{ id: 'doc-1', title: 'Q3 Architecture Review' }]);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses a lone partial entity-name match even when the current turn names the full entity', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityName: 'Acme' },
      HUMAN_CTX
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exact company name/i);
    expect(res.data?.matchingEntities).toEqual([{ id: 'comp-1', name: 'Acme Corp' }]);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses ambiguous document titles, listing the candidates, and writes nothing', async () => {
    (adminGetDocuments as jest.Mock).mockResolvedValue([
      { id: 'doc-3', title: 'Roadmap 2026 H1' },
      { id: 'doc-4', title: 'Roadmap 2026 H2' },
    ]);

    const res = await executeLinkDocumentToEntity(
      { documentTitle: 'Roadmap 2026', entityType: 'company', entityId: 'comp-1' },
      { ...HUMAN_CTX, confirmationText: 'Link "Roadmap 2026" to Acme Corp' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Multiple documents/i);
    expect(res.error).toContain('doc-3');
    expect(res.error).toContain('doc-4');
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses duplicate normalized exact document titles even behind more than five partial hints', async () => {
    (adminGetDocuments as jest.Mock).mockResolvedValue([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `doc-partial-${index}`,
        title: `Roadmap 2026 appendix ${index}`,
      })),
      { id: 'doc-exact-1', title: 'Roadmap 2026' },
      { id: 'doc-exact-2', title: '  ROADMAP   2026  ' },
    ]);

    const res = await executeLinkDocumentToEntity(
      { documentTitle: 'Roadmap 2026', entityType: 'company', entityId: 'comp-1' },
      { ...HUMAN_CTX, confirmationText: 'Link "Roadmap 2026" to Acme Corp' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/multiple documents.*exact/i);
    expect(res.data?.matchingDocuments).toEqual([
      { id: 'doc-exact-1', title: 'Roadmap 2026' },
      { id: 'doc-exact-2', title: '  ROADMAP   2026  ' },
    ]);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses ambiguous entity names, listing the candidates, and writes nothing', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([
      { id: 'comp-1', name: 'Acme Corporation' },
      { id: 'comp-2', name: 'Acme Corp Holdings' },
    ]);

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityName: 'Acme' },
      { ...HUMAN_CTX, confirmationText: 'Link "Q3 Architecture Review" to Acme' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Multiple compan/i);
    expect(res.error).toContain('comp-1');
    expect(res.error).toContain('comp-2');
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses duplicate normalized exact entity names and never chooses the first duplicate', async () => {
    mockSearchEntityCandidatesByName.mockResolvedValue([
      { id: 'comp-1', name: 'Acme Corp' },
      { id: 'comp-2', name: 'ＡCME   CORP' },
      { id: 'comp-partial', name: 'Acme Corp Holdings' },
    ]);

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityName: 'acme corp' },
      HUMAN_CTX
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/multiple company.*exact/i);
    expect(res.data?.matchingEntities).toEqual([
      { id: 'comp-1', name: 'Acme Corp' },
      { id: 'comp-2', name: 'ＡCME   CORP' },
    ]);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('reports a clear error when no document matches the title', async () => {
    (adminGetDocuments as jest.Mock).mockResolvedValue([{ id: 'doc-2', title: 'Unrelated Notes' }]);

    const res = await executeLinkDocumentToEntity(
      { documentTitle: 'Ghost Paper', entityType: 'company', entityId: 'comp-1' },
      { ...HUMAN_CTX, confirmationText: 'Link "Ghost Paper" to Acme Corp' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No document found/i);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('surfaces a missing entity id as an error instead of writing a ghost link', async () => {
    mockBuildEntitySnapshot.mockRejectedValue(new Error('Company not found: comp-404'));

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-404' },
      HUMAN_CTX
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('Company not found');
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('converges on the existing link without re-creating (retry idempotence, pre-check)', async () => {
    mockAdminFindExistingLink.mockResolvedValue({ id: 'link-9', entityId: 'comp-1', documentId: 'doc-1' });

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      HUMAN_CTX
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ created: false, linkId: 'link-9' });
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('converges when a concurrent create loses the race to the already-exists guard', async () => {
    mockAdminFindExistingLink.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'link-9',
      entityId: 'comp-1',
      documentId: 'doc-1',
    });
    mockAdminCreateEntityDocumentLink.mockRejectedValue(
      new Error('Link already exists between company:comp-1 and document:doc-1 (ID: link-9)')
    );

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      HUMAN_CTX
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ created: false, linkId: 'link-9' });
  });

  it('refuses discovery-flavored phrasing so inferred links stay proposals', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      { ...HUMAN_CTX, confirmationText: 'Maybe you could link "Q3 Architecture Review" to Acme Corp?' }
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not authorized|explicit/i);
    expect(res.data?.message ?? res.error).toMatch(/proposeVerifiedRelation/);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('refuses when the current turn does not name the endpoints at all', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1' },
      { ...HUMAN_CTX, confirmationText: 'Please tidy up the library.' }
    );

    expect(res.success).toBe(false);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('rejects unknown entity types', async () => {
    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'radar', entityId: 'radar-1' },
      HUMAN_CTX
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/entityType/);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });

  it('rejects providing both id and name for the same endpoint', async () => {
    const byDoc = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', documentTitle: 'Q3 Architecture Review', entityType: 'company', entityId: 'comp-1' },
      HUMAN_CTX
    );
    expect(byDoc.success).toBe(false);
    expect(byDoc.error).toMatch(/not both/i);

    const byEntity = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1', entityName: 'Acme Corp' },
      HUMAN_CTX
    );
    expect(byEntity.success).toBe(false);
    expect(byEntity.error).toMatch(/not both/i);
  });

  it('maps camelCase org units onto the transformation vocabulary', async () => {
    mockBuildEntitySnapshot.mockResolvedValue({
      type: 'orgUnit',
      id: 'org-1',
      name: 'Platform Engineering',
      snapshotAt: 1,
    });

    const res = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'orgUnit', entityId: 'org-1', relationshipType: 'technical_spec' },
      { ...HUMAN_CTX, confirmationText: 'Link "Q3 Architecture Review" to Platform Engineering' }
    );

    expect(res.success).toBe(true);
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'org_unit', entityId: 'org-1', relationshipType: 'technical_spec' })
    );
  });

  it('passes an optional note through and rejects invalid relationship types', async () => {
    const ok = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1', note: 'Primary architecture source' },
      HUMAN_CTX
    );
    expect(ok.success).toBe(true);
    expect(mockAdminCreateEntityDocumentLink).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Primary architecture source' })
    );

    mockAdminCreateEntityDocumentLink.mockClear();
    const bad = await executeLinkDocumentToEntity(
      { documentId: 'doc-1', entityType: 'company', entityId: 'comp-1', relationshipType: 'blogpost' },
      HUMAN_CTX
    );
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/relationshipType/);
    expect(mockAdminCreateEntityDocumentLink).not.toHaveBeenCalled();
  });
});

describe('linkDocumentToEntity registration (AI-023)', () => {
  it('is declared in DOCUMENT_TOOLS with an explicit-instruction contract', () => {
    const { DOCUMENT_TOOLS } = jest.requireActual('../document-tools');
    const decl = (DOCUMENT_TOOLS as Array<{ name: string; description?: string }>).find(
      (t) => t.name === 'linkDocumentToEntity'
    );
    expect(decl).toBeDefined();
    expect(decl?.description).toMatch(/current message|explicitly/i);
    expect(decl?.description).toMatch(/proposeVerifiedRelation/);
  });

  it('is mapped to entityDocumentLink + document cache invalidation', () => {
    const { TOOL_ENTITY_MAP } = jest.requireActual('@/lib/ai/mutation-tracking');
    expect(TOOL_ENTITY_MAP.linkDocumentToEntity).toEqual(
      expect.arrayContaining(['entityDocumentLink', 'document'])
    );
  });
});
