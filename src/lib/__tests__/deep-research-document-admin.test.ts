/**
 * @jest-environment node
 *
 * AI-021 — the ONE supported generated-document contract.
 */

const mockCreateDocument = jest.fn();
const mockUpdateDocument = jest.fn();
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminCreateDocument: (...args: unknown[]) => mockCreateDocument(...args),
  adminUpdateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
}));

const mockSafeSendEvent = jest.fn();
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  safeSendEvent: (...args: unknown[]) => mockSafeSendEvent(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { DeepResearchDispatchError, dispatchDeepResearchDocument } from '../deep-research-document-admin';
import { MAX_RESEARCH_TITLE_LENGTH } from '../research/primary-evidence';

describe('dispatchDeepResearchDocument', () => {
  const baseRequest = { query: 'Post-quantum cryptography adoption', userId: 'user-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateDocument.mockResolvedValue({ id: 'doc-1', status: 'processing' });
    mockSafeSendEvent.mockResolvedValue(true);
  });

  it('creates the document in a truthful processing state with provenance', async () => {
    const document = await dispatchDeepResearchDocument({ ...baseRequest, tags: ['pqc'] });

    expect(document.id).toBe('doc-1');
    expect(mockCreateDocument).toHaveBeenCalledWith(
      {
        title: baseRequest.query,
        type: 'markdown',
        description: `Deep research: ${baseRequest.query}`,
        storageUrl: '',
        uploadedBy: 'user-1',
        tags: ['pqc', 'deep-research'],
        mimeType: 'text/markdown',
        visibility: 'workspace',
      },
      { initialStatus: 'processing' }
    );
  });

  it('dispatches the background job with query, owner, and artifact linkage', async () => {
    await dispatchDeepResearchDocument({
      ...baseRequest,
      tags: ['pqc'],
      proposedArtifactId: 'artifact-9',
      logPrefix: '[ArtifactGen]',
    });

    expect(mockSafeSendEvent).toHaveBeenCalledWith(
      {
        name: 'app/document.deep-research.requested',
        data: {
          query: baseRequest.query,
          documentId: 'doc-1',
          userId: 'user-1',
          tags: ['pqc'],
          proposedArtifactId: 'artifact-9',
        },
      },
      { logPrefix: '[ArtifactGen]' }
    );
  });

  it('uses an explicit title when provided and trims the query', async () => {
    await dispatchDeepResearchDocument({
      query: '  spatial computing  ',
      userId: 'user-1',
      title: 'Spatial computing brief',
    });

    expect(mockCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Spatial computing brief',
        description: 'Deep research: spatial computing',
      }),
      expect.any(Object)
    );
  });

  // The title defaults to the query, which may contain a whole research brief.
  it('bounds a runaway title while preserving the full query for the job', async () => {
    const runawayQuery = `Research the quantum patent landscape. ${'Consider every filing and assignee. '.repeat(40)}`;
    expect(runawayQuery.length).toBeGreaterThan(1_000);

    await dispatchDeepResearchDocument({ query: runawayQuery, userId: 'user-1' });

    const [created] = mockCreateDocument.mock.calls[0] as [{ title: string; description: string }];
    expect(created.title.length).toBeLessThanOrEqual(MAX_RESEARCH_TITLE_LENGTH);
    expect(created.title.startsWith('Research the quantum patent landscape.')).toBe(true);
    // Nothing is lost: the full query still rides on the description and the event.
    expect(created.description).toBe(`Deep research: ${runawayQuery.trim()}`);
    expect(mockSafeSendEvent.mock.calls[0][0].data.query).toBe(runawayQuery.trim());
  });

  it('bounds an explicitly supplied runaway title too', async () => {
    await dispatchDeepResearchDocument({
      query: 'spatial computing',
      userId: 'user-1',
      title: 'A '.repeat(400),
    });

    const [created] = mockCreateDocument.mock.calls[0] as [{ title: string }];
    expect(created.title.length).toBeLessThanOrEqual(MAX_RESEARCH_TITLE_LENGTH);
  });

  it('rejects an empty query before any write or dispatch', async () => {
    await expect(dispatchDeepResearchDocument({ query: '   ', userId: 'user-1' })).rejects.toThrow('non-empty query');
    expect(mockCreateDocument).not.toHaveBeenCalled();
    expect(mockSafeSendEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing user before any write or dispatch', async () => {
    await expect(dispatchDeepResearchDocument({ query: 'x-topic', userId: '' })).rejects.toThrow('authenticated user');
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it('marks the document failed and throws DeepResearchDispatchError on rejected dispatch', async () => {
    mockSafeSendEvent.mockResolvedValue(false);

    await expect(dispatchDeepResearchDocument(baseRequest)).rejects.toBeInstanceOf(DeepResearchDispatchError);
    expect(mockUpdateDocument).toHaveBeenCalledWith('doc-1', {
      status: 'failed',
      errorMessage: expect.stringMatching(/could not be started/i),
    });
  });

  it('carries the documentId on the dispatch error for honest caller reporting', async () => {
    mockSafeSendEvent.mockResolvedValue(false);

    await expect(dispatchDeepResearchDocument(baseRequest)).rejects.toMatchObject({
      documentId: 'doc-1',
    });
  });

  it('still throws even when the failure-marking write itself fails', async () => {
    mockSafeSendEvent.mockResolvedValue(false);
    mockUpdateDocument.mockRejectedValue(new Error('Firestore unavailable'));

    await expect(dispatchDeepResearchDocument(baseRequest)).rejects.toBeInstanceOf(DeepResearchDispatchError);
  });

  it('never sends empty tags on the event', async () => {
    await dispatchDeepResearchDocument({ ...baseRequest, tags: [] });

    const eventPayload = mockSafeSendEvent.mock.calls[0][0];
    expect(eventPayload.data).not.toHaveProperty('tags');
  });
});
