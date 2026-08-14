/**
 * AI-048 — grounded generation returns publisher identities, not opaque Google
 * grounding redirects.
 *
 * `generateGroundedContent` is the single funnel every grounded consumer reads
 * through (chat citations, the webSearch tool, the research flows, company
 * research, signal expansion). Resolving there means no consumer can be missed,
 * and no consumer has to remember to resolve.
 *
 * @jest-environment node
 */

// This suite imports `../client` dynamically (after the mocks are installed), so
// the file needs an explicit module marker — otherwise its consts land in the
// global scope and collide with identically named ones in sibling suites.
export {};

const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn().mockReturnValue({ generateContent: mockGenerateContent });

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
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

const REDIRECT_HOST = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/';

/** A grounded Gemini response carrying `groundingChunks` for each uri. */
function groundedResponse(uris: Array<{ uri: string; title?: string }>) {
  return {
    response: {
      text: () => 'grounded answer',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: uris.map((u) => ({ web: { uri: u.uri, title: u.title } })),
          },
        },
      ],
    },
  };
}

/** A fetch stub that 302s each redirect to a caller-supplied publisher URL. */
function redirectingFetch(map: Record<string, string>) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const location = map[url];
    if (!location) return new Response(null, { status: 200 });
    return new Response(null, { status: 302, headers: { location } });
  }) as unknown as typeof fetch;
}

describe('generateGroundedContent — publisher identity resolution (AI-048)', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a grounding redirect to the publisher URL on identityUri', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA`, title: 'Article' }]));

    const result = await generateGroundedContent('q', {
      citationResolution: {
        fetchImpl: redirectingFetch({ [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article' }),
      },
    });

    expect(result.citations[0].identityUri).toBe('https://publisher.com/article');
  });

  it('leaves uri untouched so the provider-supplied navigation URL is preserved', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }]));

    const result = await generateGroundedContent('q', {
      citationResolution: {
        fetchImpl: redirectingFetch({ [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article' }),
      },
    });

    expect(result.citations[0].uri).toBe(`${REDIRECT_HOST}AAA`);
  });

  it('resolves two redirects that alias ONE publisher to the same identity', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(
      groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }, { uri: `${REDIRECT_HOST}BBB` }])
    );

    const result = await generateGroundedContent('q', {
      citationResolution: {
        fetchImpl: redirectingFetch({
          [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article',
          [`${REDIRECT_HOST}BBB`]: 'https://publisher.com/article',
        }),
      },
    });

    expect(result.citations.map((c) => c.identityUri)).toEqual([
      'https://publisher.com/article',
      'https://publisher.com/article',
    ]);
  });

  it('leaves a non-redirect citation alone and never fetches it', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: 'https://publisher.com/direct' }]));
    const fetchImpl = redirectingFetch({});

    const result = await generateGroundedContent('q', { citationResolution: { fetchImpl } });

    expect(result.citations[0].identityUri).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is non-fatal when resolution fails — the citation stays unresolved', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }]));
    const failingFetch = jest.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await generateGroundedContent('q', { citationResolution: { fetchImpl: failingFetch } });

    expect(result.text).toBe('grounded answer');
    expect(result.citations[0].uri).toBe(`${REDIRECT_HOST}AAA`);
    expect(result.citations[0].identityUri).toBeUndefined();
  });

  it('skips resolution entirely when disabled (count-only callers pay nothing)', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }]));
    const fetchImpl = redirectingFetch({ [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article' });

    const result = await generateGroundedContent('q', { citationResolution: { enabled: false, fetchImpl } });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.citations[0].identityUri).toBeUndefined();
  });

  it('resolves on the skipReliability path too', async () => {
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }]));

    const result = await generateGroundedContent('q', {
      skipReliability: true,
      citationResolution: {
        fetchImpl: redirectingFetch({ [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article' }),
      },
    });

    expect(result.citations[0].identityUri).toBe('https://publisher.com/article');
  });

  it('never follows a redirect that leaves Google for a second hop chain', async () => {
    // The resolver inspects the publisher destination; it must not fetch it.
    const { generateGroundedContent } = await import('../client');
    mockGenerateContent.mockResolvedValue(groundedResponse([{ uri: `${REDIRECT_HOST}AAA` }]));
    const fetchImpl = redirectingFetch({
      [`${REDIRECT_HOST}AAA`]: 'https://publisher.com/article',
      'https://publisher.com/article': 'https://elsewhere.example/final',
    });

    const result = await generateGroundedContent('q', { citationResolution: { fetchImpl } });

    expect(result.citations[0].identityUri).toBe('https://publisher.com/article');
    expect((fetchImpl as unknown as jest.Mock).mock.calls).toHaveLength(1);
  });
});
