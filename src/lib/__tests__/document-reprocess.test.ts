/**
 * @jest-environment node
 *
 * UX-036 — the ONE type-correct "make this document processed" operation.
 *
 * The split it replaces: `/api/documents/process` always ran the stored-file
 * path (so URL documents 422'd), `/api/documents/reprocess-url` held the only
 * URL-aware implementation and had zero callers, and the Inngest worker picked
 * its path from the EVENT payload rather than the document — so a bare retry
 * drove URL documents into the failing file path.
 */

jest.mock('@/lib/document-admin', () => ({
  adminGetDocumentById: jest.fn(),
  adminUpdateDocument: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/document-processing-service', () => ({
  processDocument: jest.fn(),
  processDocumentFromContent: jest.fn(),
}));

jest.mock('@/lib/tdm-policy', () => ({ checkTdmPolicy: jest.fn() }));
jest.mock('@/lib/firecrawl-fetch', () => ({ fetchUrlContentReceipted: jest.fn() }));

const { adminGetDocumentById, adminUpdateDocument } = jest.requireMock('@/lib/document-admin');
const { processDocument, processDocumentFromContent } = jest.requireMock('@/lib/document-processing-service');
const { checkTdmPolicy } = jest.requireMock('@/lib/tdm-policy');
const { fetchUrlContentReceipted } = jest.requireMock('@/lib/firecrawl-fetch');

import { reprocessDocumentContent, reprocessDocuments, requiresSourceUrlFetch } from '../document-reprocess';

const OPTS = { owner: 'user:u1', correlationId: 'corr-1' };

const FILE_DOC = { id: 'doc-1', title: 'Report', type: 'pdf', storageUrl: 'documents/doc-1.pdf' };
const URL_DOC = {
  id: 'doc-1',
  title: 'Article',
  type: 'url',
  storageUrl: '',
  originalUrl: 'https://example.com/a',
};

describe('reprocessDocumentContent (UX-036)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminUpdateDocument.mockResolvedValue(undefined);
    checkTdmPolicy.mockResolvedValue({ allowed: true });
  });

  describe('source selection', () => {
    it('uses stored bytes when they exist, even for a url-typed document', () => {
      // Deep-research artifacts are `type: 'url'` yet gain a stored file.
      expect(requiresSourceUrlFetch({ type: 'url', storageUrl: 'documents/x.md', originalUrl: 'https://a' })).toBe(
        false
      );
    });

    it('uses the source URL when there are no stored bytes', () => {
      expect(requiresSourceUrlFetch({ type: 'url', storageUrl: '', originalUrl: 'https://a' })).toBe(true);
      // Not keyed on `type`: a mistyped document with a URL is still recoverable.
      expect(requiresSourceUrlFetch({ type: 'pdf', storageUrl: '', originalUrl: 'https://a' })).toBe(true);
    });

    it('is false when neither source exists', () => {
      expect(requiresSourceUrlFetch({ type: 'pdf', storageUrl: '', originalUrl: '' })).toBe(false);
    });
  });

  it('returns not-found for an unknown document without touching Firestore', async () => {
    adminGetDocumentById.mockResolvedValue(null);

    const outcome = await reprocessDocumentContent('missing', OPTS);

    expect(outcome).toMatchObject({ ok: false, code: 'not-found', httpStatus: 404 });
    expect(adminUpdateDocument).not.toHaveBeenCalled();
  });

  it('processes supplied content directly without fetching or TDM-gating', async () => {
    adminGetDocumentById.mockResolvedValue(URL_DOC);
    processDocumentFromContent.mockResolvedValue({ success: true, chunkCount: 3, textLength: 300 });

    const outcome = await reprocessDocumentContent('doc-1', { ...OPTS, content: 'already fetched' });

    expect(outcome).toMatchObject({ ok: true, source: 'supplied-content', chunkCount: 3 });
    expect(checkTdmPolicy).not.toHaveBeenCalled();
    expect(fetchUrlContentReceipted).not.toHaveBeenCalled();
  });

  /** THE UX-036b regression: a URL document must never take the file path. */
  it('re-fetches a URL document instead of downloading a file that does not exist', async () => {
    adminGetDocumentById.mockResolvedValue(URL_DOC);
    fetchUrlContentReceipted.mockResolvedValue({ success: true, content: 'body text', usedFirecrawl: false });
    processDocumentFromContent.mockResolvedValue({ success: true, chunkCount: 2, textLength: 9 });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: true, source: 'source-url', chunkCount: 2 });
    expect(processDocument).not.toHaveBeenCalled();
    expect(fetchUrlContentReceipted).toHaveBeenCalledWith('https://example.com/a', OPTS);
  });

  it('applies the TDM gate on every real re-fetch and records the reason as blocked', async () => {
    adminGetDocumentById.mockResolvedValue(URL_DOC);
    checkTdmPolicy.mockResolvedValue({ allowed: false, reason: 'TDM opt-out: ai.txt' });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: false, code: 'tdm-blocked', httpStatus: 403 });
    expect(fetchUrlContentReceipted).not.toHaveBeenCalled();
    // `blocked`, not `failed` — a rights reservation is deliberate and permanent.
    expect(adminUpdateDocument).toHaveBeenCalledWith('doc-1', {
      status: 'blocked',
      fetchError: 'TDM opt-out: ai.txt',
      errorMessage: 'TDM opt-out: ai.txt',
    });
  });

  it('persists the fetch failure REASON, not just the failed status', async () => {
    adminGetDocumentById.mockResolvedValue(URL_DOC);
    fetchUrlContentReceipted.mockResolvedValue({ success: false, error: 'ECONNREFUSED', usedFirecrawl: false });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: false, code: 'fetch-failed', httpStatus: 400 });
    expect(adminUpdateDocument).toHaveBeenCalledWith('doc-1', {
      status: 'failed',
      errorMessage: expect.stringContaining('ECONNREFUSED'),
      fetchError: 'ECONNREFUSED',
    });
    expect(processDocumentFromContent).not.toHaveBeenCalled();
  });

  it('treats a successful fetch that returned no content as a fetch failure', async () => {
    adminGetDocumentById.mockResolvedValue(URL_DOC);
    fetchUrlContentReceipted.mockResolvedValue({ success: true, content: undefined, usedFirecrawl: false });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: false, code: 'fetch-failed' });
    expect(processDocumentFromContent).not.toHaveBeenCalled();
  });

  it('runs the stored-file path for a file-backed document', async () => {
    adminGetDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({ success: true, chunkCount: 7, textLength: 900, pageCount: 3 });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: true, source: 'stored-file', chunkCount: 7, pageCount: 3 });
    expect(fetchUrlContentReceipted).not.toHaveBeenCalled();
  });

  it('names the real problem when a document has neither bytes nor a source URL', async () => {
    adminGetDocumentById.mockResolvedValue({ id: 'doc-1', title: 'Orphan', type: 'pdf', storageUrl: '' });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    // The old behavior was a download attempt against an empty path, reported
    // as "Failed to download file from " with the path missing.
    expect(outcome).toMatchObject({ ok: false, code: 'no-source', httpStatus: 400 });
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('does NOT write a terminal status for `no-source` — the document is left as found', async () => {
    // A deep-research artifact sits in `processing` with no bytes and no URL
    // while its own pipeline works. "We were asked to reprocess something with
    // no source" is a refusal of the REQUEST, not a fact about the document;
    // writing `failed` here destroyed healthy in-flight work.
    adminGetDocumentById.mockResolvedValue({
      id: 'doc-1',
      title: 'Deep research (running)',
      type: 'markdown',
      storageUrl: '',
      status: 'processing',
    });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({ ok: false, code: 'no-source' });
    expect(adminUpdateDocument).not.toHaveBeenCalled();
  });

  it('maps a processing-pipeline failure to 422 and preserves the stage', async () => {
    adminGetDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({ success: false, error: 'Corrupt PDF', stage: 'extraction' });

    const outcome = await reprocessDocumentContent('doc-1', OPTS);

    expect(outcome).toMatchObject({
      ok: false,
      code: 'processing-failed',
      httpStatus: 422,
      error: 'Corrupt PDF',
      stage: 'extraction',
    });
  });

  it('threads chunk options through to the processing pipeline', async () => {
    adminGetDocumentById.mockResolvedValue(FILE_DOC);
    processDocument.mockResolvedValue({ success: true, chunkCount: 1, textLength: 1 });

    await reprocessDocumentContent('doc-1', { ...OPTS, chunkSize: 500, chunkOverlap: 50, replaceExisting: false });

    expect(processDocument).toHaveBeenCalledWith('doc-1', {
      chunkSize: 500,
      chunkOverlap: 50,
      replaceExisting: false,
    });
  });

  /**
   * The batch branch of `/api/documents/process` used to call
   * `processDocuments`, which loops over the unconditional stored-file path —
   * so a URL document in a batch still failed with a download error even after
   * the single-document branch was made type-correct.
   */
  it('reprocessDocuments applies the same source selection to every item', async () => {
    adminGetDocumentById.mockImplementation(async (id: string) => (id === 'doc-url' ? { ...URL_DOC, id } : FILE_DOC));
    fetchUrlContentReceipted.mockResolvedValue({ success: true, content: 'body', usedFirecrawl: false });
    processDocumentFromContent.mockResolvedValue({ success: true, chunkCount: 1, textLength: 4 });
    processDocument.mockResolvedValue({ success: true, chunkCount: 2, textLength: 8 });

    const outcomes = await reprocessDocuments(['doc-url', 'doc-file'], OPTS);

    expect(outcomes.map((o) => (o.ok ? o.source : o.code))).toEqual(['source-url', 'stored-file']);
  });
});
