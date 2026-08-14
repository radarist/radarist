/**
 * AI-048 part 2 — `groundingSupports` maps a claim to the source that supports
 * it, upgrading grounded search from document-level citation to claim-level
 * provenance. It was read nowhere, which is why every grounded result carried
 * an empty snippet.
 *
 * The correspondence is the whole risk: `groundingChunkIndices` index into the
 * RAW `groundingChunks` array, while citations are deduped by URI. Mapping the
 * support onto the wrong citation attributes a claim to a source that never
 * made it — worse than carrying no snippet at all. Every malformed or
 * out-of-range index therefore fails closed.
 *
 * @jest-environment node
 */

export {};

const mockGroundedGenerateContent = jest.fn();
const mockGroundedGetGenerativeModel = jest.fn().mockReturnValue({ generateContent: mockGroundedGenerateContent });

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGroundedGetGenerativeModel,
  })),
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT', RETRIEVAL_QUERY: 'RETRIEVAL_QUERY' },
}));

jest.mock('../reliability', () => ({
  withReliability: jest.fn(async (fn: () => Promise<{ result: unknown }>) => ({ data: (await fn()).result })),
  trackCost: jest.fn(),
  calculateCost: jest.fn(() => 0),
  assertCostBudgetAvailable: jest.fn(),
  generateRequestId: jest.fn(() => 'req-test'),
  getCostTracker: jest.fn(() => ({ getTotalCost: () => 0 })),
}));

interface SupportFixture {
  segmentText?: unknown;
  chunkIndices?: unknown;
}

function response(chunkUris: Array<string | undefined>, supports: SupportFixture[]) {
  return {
    response: {
      text: () => 'grounded answer',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: chunkUris.map((uri) => ({ web: { uri } })),
            groundingSupports: supports.map((s) => ({
              segment: { text: s.segmentText },
              groundingChunkIndices: s.chunkIndices,
            })),
          },
        },
      ],
    },
  };
}

/** Resolution is exercised in its own suite; keep it out of the way here. */
const NO_RESOLUTION = { citationResolution: { enabled: false } } as const;

describe('groundingSupports → claim-level snippets (AI-048)', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => jest.clearAllMocks());

  it('attaches the supported segment to the source that supports it', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGroundedGenerateContent.mockResolvedValue(
      response(
        ['https://a.com/1', 'https://b.com/2'],
        [
          { segmentText: 'Claim about A.', chunkIndices: [0] },
          { segmentText: 'Claim about B.', chunkIndices: [1] },
        ]
      )
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    expect(citations[0].supportedSegments).toEqual(['Claim about A.']);
    expect(citations[1].supportedSegments).toEqual(['Claim about B.']);
  });

  it('gives one segment to every source that supports it', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGroundedGenerateContent.mockResolvedValue(
      response(['https://a.com/1', 'https://b.com/2'], [{ segmentText: 'Jointly supported.', chunkIndices: [0, 1] }])
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    expect(citations[0].supportedSegments).toEqual(['Jointly supported.']);
    expect(citations[1].supportedSegments).toEqual(['Jointly supported.']);
  });

  it('collects multiple segments for one source in order', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGroundedGenerateContent.mockResolvedValue(
      response(
        ['https://a.com/1'],
        [
          { segmentText: 'First claim.', chunkIndices: [0] },
          { segmentText: 'Second claim.', chunkIndices: [0] },
        ]
      )
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    expect(citations[0].supportedSegments).toEqual(['First claim.', 'Second claim.']);
  });

  // The correspondence trap: citations are deduped by URI, chunk indices are not.
  it('keeps correspondence when duplicate URIs collapse the citation list', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGroundedGenerateContent.mockResolvedValue(
      response(
        ['https://a.com/1', 'https://a.com/1', 'https://b.com/2'],
        [
          { segmentText: 'Belongs to A.', chunkIndices: [1] },
          { segmentText: 'Belongs to B.', chunkIndices: [2] },
        ]
      )
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    expect(citations).toHaveLength(2);
    expect(citations[0].uri).toBe('https://a.com/1');
    expect(citations[0].supportedSegments).toEqual(['Belongs to A.']);
    expect(citations[1].uri).toBe('https://b.com/2');
    expect(citations[1].supportedSegments).toEqual(['Belongs to B.']);
  });

  it('keeps correspondence when a chunk without a uri is skipped', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGroundedGenerateContent.mockResolvedValue(
      response(
        [undefined, 'https://b.com/2'],
        [
          { segmentText: 'Belongs to the skipped chunk.', chunkIndices: [0] },
          { segmentText: 'Belongs to B.', chunkIndices: [1] },
        ]
      )
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    expect(citations).toHaveLength(1);
    expect(citations[0].uri).toBe('https://b.com/2');
    expect(citations[0].supportedSegments).toEqual(['Belongs to B.']);
  });

  describe('fails closed on malformed metadata', () => {
    it.each([
      ['an out-of-range index', [{ segmentText: 'Orphan.', chunkIndices: [7] }]],
      ['a negative index', [{ segmentText: 'Orphan.', chunkIndices: [-1] }]],
      ['a non-integer index', [{ segmentText: 'Orphan.', chunkIndices: [1.5] }]],
      ['a non-numeric index', [{ segmentText: 'Orphan.', chunkIndices: ['0'] }]],
      ['indices that are not an array', [{ segmentText: 'Orphan.', chunkIndices: 0 }]],
      ['a missing segment text', [{ chunkIndices: [0] }]],
      ['a non-string segment text', [{ segmentText: 42, chunkIndices: [0] }]],
      ['a blank segment text', [{ segmentText: '   ', chunkIndices: [0] }]],
    ])('drops the support for %s', async (_label, supports) => {
      const { generateGroundedContent } = await import('../client');
      mockGroundedGenerateContent.mockResolvedValue(response(['https://a.com/1'], supports as SupportFixture[]));

      const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

      expect(citations).toHaveLength(1);
      expect(citations[0].supportedSegments).toBeUndefined();
    });

    it('never lets a malformed support discard a well-formed one', async () => {
      const { generateGroundedContent } = await import('../client');
      mockGroundedGenerateContent.mockResolvedValue(
        response(
          ['https://a.com/1'],
          [
            { segmentText: 'Orphan.', chunkIndices: [99] },
            { segmentText: 'Valid claim.', chunkIndices: [0] },
          ]
        )
      );

      const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

      expect(citations[0].supportedSegments).toEqual(['Valid claim.']);
    });

    it('leaves segments absent when groundingSupports is missing entirely', async () => {
      const { generateGroundedContent } = await import('../client');
      mockGroundedGenerateContent.mockResolvedValue({
        response: {
          text: () => 'grounded answer',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          candidates: [{ groundingMetadata: { groundingChunks: [{ web: { uri: 'https://a.com/1' } }] } }],
        },
      });

      const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

      expect(citations[0].supportedSegments).toBeUndefined();
    });
  });

  // Identity resolution rebuilds each citation object. A spread that dropped
  // the segments would silently downgrade claim-level provenance back to
  // document-level, with nothing failing.
  it('preserves supported segments through identity resolution', async () => {
    const { generateGroundedContent } = await import('../client');
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA';
    mockGroundedGenerateContent.mockResolvedValue(
      response([redirect], [{ segmentText: 'Claim about A.', chunkIndices: [0] }])
    );
    const fetchImpl = jest.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://publisher.com/article' } })
    ) as unknown as typeof fetch;

    const { citations } = await generateGroundedContent('q', { citationResolution: { fetchImpl } });

    expect(citations[0].identityUri).toBe('https://publisher.com/article');
    expect(citations[0].supportedSegments).toEqual(['Claim about A.']);
  });

  it('bounds how much segment text one source can accumulate', async () => {
    const { generateGroundedContent } = await import('../client');
    const long = 'x'.repeat(400);
    mockGroundedGenerateContent.mockResolvedValue(
      response(
        ['https://a.com/1'],
        Array.from({ length: 20 }, () => ({ segmentText: long, chunkIndices: [0] }))
      )
    );

    const { citations } = await generateGroundedContent('q', NO_RESOLUTION);

    const total = (citations[0].supportedSegments ?? []).join('').length;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(2_000);
  });
});
