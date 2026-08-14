/**
 * @file chunk-mentions.test.ts
 * @description Unit tests for linkChunkMentions + helpers.
 *
 * GRAPH-064 changed the trust contract: a mention edge no longer mints a fixed
 * curated/100, it derives its trust from the parent Document's provenance and
 * review state. The confidence assertions below pin the DERIVED values.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

import * as neo4jClient from '../neo4j-client';
import {
  linkChunkMentions,
  applyMentionTrustForDocument,
  countUnlinkedChunks,
  listChunksWithoutMentions,
} from '../chunk-mentions';
import { REVIEWED_MENTION_CONFIDENCE, UNREVIEWED_MENTION_CONFIDENCE } from '../mention-trust';

const mockedRead = neo4jClient.runReadTransaction as jest.Mock;
const mockedWrite = neo4jClient.runWriteTransaction as jest.Mock;

/** The source lookup linkChunkMentions performs before it writes anything. */
function mockSourceDocument(contentProvenance: string | null, contentReviewedAt: number | null = null): void {
  mockedRead.mockResolvedValue({ records: [{ contentProvenance, contentReviewedAt }] });
}

describe('linkChunkMentions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSourceDocument('external');
  });

  it('calls write Cypher with the chunk id, min-length, and word-boundary regex', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 3, linksExisting: 1 }] });
    const result = await linkChunkMentions('chunk-123');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MATCH (c:Chunk {id: $chunkId})');
    expect(cypher).toContain('size(e.name) >= $minLen');
    expect(cypher).toContain('haystack CONTAINS toLower(e.name)');
    // Word-boundary regex pre-filter prevents "Intel" from matching "intelligence"
    expect(cypher).toContain("haystack =~ ('(?s).*(^|[^a-z0-9])'");
    expect(cypher).toContain('MERGE (c)-[r:MENTIONS]->(e)');
    expect(params.chunkId).toBe('chunk-123');
    expect(params.minLen).toBeGreaterThanOrEqual(5);

    expect(result).toMatchObject({ chunkId: 'chunk-123', linksCreated: 3, linksExisting: 1 });
  });

  it('handles 0-row results gracefully', async () => {
    mockedWrite.mockResolvedValue({ records: [] });
    const result = await linkChunkMentions('chunk-empty');
    expect(result).toMatchObject({ chunkId: 'chunk-empty', linksCreated: 0, linksExisting: 0 });
  });

  it('filters by all three embeddable labels (Technology, Company, Signal)', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    await linkChunkMentions('chunk-1');
    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain("'Technology' IN labels(e)");
    expect(cypher).toContain("'Company' IN labels(e)");
    expect(cypher).toContain("'Signal' IN labels(e)");
  });

  it('reads the parent document before writing anything', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    await linkChunkMentions('chunk-1');
    const [readCypher] = mockedRead.mock.calls[0];
    expect(readCypher).toContain('OPTIONAL MATCH (d:Document {id: c.documentId})');
    expect(readCypher).toContain('d.contentProvenance AS contentProvenance');
  });

  it('mints curated/100 for externally-sourced content (0-100 contract)', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    const result = await linkChunkMentions('chunk-1');
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('r.confidence = $confidence');
    expect(params.confidence).toBe(REVIEWED_MENTION_CONFIDENCE);
    expect(params.claimStatus).toBe('curated');
    expect(result.trust.sourceProvenance).toBe('external');
  });

  // The GRAPH-064 defect: a weak deep-research draft used to mint curated/100.
  it('mints unverified/50 for an unreviewed machine-generated source', async () => {
    mockSourceDocument('machine-generated');
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 1, linksExisting: 0 }] });

    const result = await linkChunkMentions('chunk-draft');

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.claimStatus).toBe('unverified');
    expect(params.confidence).toBe(UNREVIEWED_MENTION_CONFIDENCE);
    expect(params.aiSuggested).toBe(true);
    expect(result.trust).toMatchObject({
      claimStatus: 'unverified',
      sourceProvenance: 'machine-generated',
      sourceReviewState: 'unreviewed',
    });
  });

  it('promotes to curated once the source document is reviewed', async () => {
    mockSourceDocument('machine-generated', 1_700_000_000_000);
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 1 }] });

    const result = await linkChunkMentions('chunk-draft');

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.claimStatus).toBe('curated');
    expect(params.confidence).toBe(REVIEWED_MENTION_CONFIDENCE);
    expect(result.trust.sourceReviewState).toBe('reviewed');
  });

  it('fails closed to unverified when the chunk has no reachable document', async () => {
    mockedRead.mockResolvedValue({ records: [] });
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 1, linksExisting: 0 }] });

    const result = await linkChunkMentions('orphan-chunk');

    expect(result.trust).toMatchObject({ claimStatus: 'unverified', sourceProvenance: 'unknown' });
  });

  it('mints assertedConfidence and effectiveConfidence from the same derived value (B0)', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    await linkChunkMentions('chunk-1');
    const [cypher] = mockedWrite.mock.calls[0];
    const onCreateBlock = cypher.split('ON CREATE SET')[1].split('ON MATCH SET')[0];
    expect(onCreateBlock).toContain('r.assertedConfidence = $confidence');
    expect(onCreateBlock).toContain('r.effectiveConfidence = $confidence');
  });

  // Without this, a demoted edge keeps its old effectiveConfidence of 100 and
  // every reader that orders on coalesce(effectiveConfidence, confidence) still
  // ranks it as a top-trust claim.
  it('re-derives trust on ON MATCH so an existing edge converges', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 1 }] });
    await linkChunkMentions('chunk-1');
    const [cypher] = mockedWrite.mock.calls[0];
    const onMatchBlock = cypher.split('ON MATCH SET')[1];
    expect(onMatchBlock).toContain('r.claimStatus = $claimStatus');
    expect(onMatchBlock).toContain('r.effectiveConfidence = $confidence');
  });
});

describe('applyMentionTrustForDocument', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-derives every text-match mention under one document', async () => {
    mockedWrite.mockResolvedValue({ records: [{ edgesUpdated: 8 }] });

    const result = await applyMentionTrustForDocument('doc-1', 'machine-generated', 'reviewed');

    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MATCH (:Document {id: $documentId})-[:CONTAINS]->(:Chunk)-[r:MENTIONS]->()');
    // Curated document-level links written by other paths must not be rewritten.
    expect(cypher).toContain("r.linkedBy = 'text-match'");
    expect(params.claimStatus).toBe('curated');
    expect(result).toMatchObject({ documentId: 'doc-1', edgesUpdated: 8 });
  });

  it('demotes when a review is withdrawn', async () => {
    mockedWrite.mockResolvedValue({ records: [{ edgesUpdated: 8 }] });

    await applyMentionTrustForDocument('doc-1', 'machine-generated', 'unreviewed');

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.claimStatus).toBe('unverified');
    expect(params.confidence).toBe(UNREVIEWED_MENTION_CONFIDENCE);
  });
});

describe('countUnlinkedChunks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns count from single-row result', async () => {
    mockedRead.mockResolvedValue({ records: [{ count: 42 }] });
    expect(await countUnlinkedChunks()).toBe(42);
  });

  it('returns 0 for empty result', async () => {
    mockedRead.mockResolvedValue({ records: [] });
    expect(await countUnlinkedChunks()).toBe(0);
  });
});

describe('linkChunkMentions — robustness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSourceDocument('external');
  });

  it('returns 0/0 when chunk content is missing (archived or null)', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    const result = await linkChunkMentions('archived-chunk');
    expect(result).toMatchObject({ chunkId: 'archived-chunk', linksCreated: 0, linksExisting: 0 });
  });

  it('filters archived chunks via the WHERE clause', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    await linkChunkMentions('chunk-x');
    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('c.archived = false OR c.archived IS NULL');
  });

  it('sets mentionsProcessedAt unconditionally (chunks with 0 matches stay out of backfill)', async () => {
    mockedWrite.mockResolvedValue({ records: [{ linksCreated: 0, linksExisting: 0 }] });
    await linkChunkMentions('chunk-y');
    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('SET c.mentionsProcessedAt = timestamp()');
  });
});

describe('listChunksWithoutMentions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes skip/limit as integers to Cypher', async () => {
    mockedRead.mockResolvedValue({
      records: [{ id: 'chunk-1' }, { id: 'chunk-2' }],
    });
    const result = await listChunksWithoutMentions(100, 50);
    const [cypher, params] = mockedRead.mock.calls[0];
    expect(cypher).toContain('SKIP toInteger($skip)');
    expect(cypher).toContain('LIMIT toInteger($limit)');
    expect(params).toEqual({ skip: 100, limit: 50 });
    expect(result).toEqual(['chunk-1', 'chunk-2']);
  });
});
