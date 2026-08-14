/**
 * @jest-environment node
 *
 * Service-wrapper tests for `expandSignal()`. Focus: the backlog-0.2 graph
 * re-sync — every NON-Inngest caller (enrich-on-like, the chat expandSignal tool)
 * must re-sync the expanded signal to Neo4j, because persistSignalExpansion writes
 * Firestore directly and bypasses the entity-sync event.
 */
jest.mock('server-only', () => ({}));

const mockSignalGet = jest.fn();
const mockSignalUpdate = jest.fn().mockResolvedValue(undefined);
const mockStrategiesGet = jest.fn().mockResolvedValue({ docs: [] });

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: (name: string) => {
      if (name === 'strategies') return { get: mockStrategiesGet };
      // signals
      return { doc: () => ({ get: mockSignalGet, update: mockSignalUpdate }) };
    },
  },
}));

const mockGenerateContent = jest.fn();
const mockGenerateGroundedContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateContent: (...a: unknown[]) => mockGenerateContent(...a),
  generateGroundedContent: (...a: unknown[]) => mockGenerateGroundedContent(...a),
}));

jest.mock('../expansion-prompts', () => ({
  __esModule: true,
  getExpansionPrompt: () => 'prompt',
}));

const mockCalculateTrustScore = jest.fn((_input?: unknown) => ({ overall: 80, breakdown: {}, factors: [] }));
jest.mock('../trust-score', () => ({
  __esModule: true,
  calculateTrustScore: (input: unknown) => mockCalculateTrustScore(input),
}));

const mockSend = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/inngest/client', () => ({
  __esModule: true,
  inngest: { send: (...a: unknown[]) => mockSend(...a) },
}));

import { expandSignal } from '../expand-signal';

beforeEach(() => {
  jest.clearAllMocks();
  mockSignalGet.mockResolvedValue({
    exists: true,
    data: () => ({
      id: 'sig-1',
      title: 'A signal',
      description: 'desc',
      source: 'Original source',
      url: 'https://original.example/story',
    }),
  });
  mockStrategiesGet.mockResolvedValue({ docs: [] });
  mockGenerateContent.mockResolvedValue('```json\n{"summary":"x","relatedItems":[]}\n```');
  mockGenerateGroundedContent.mockResolvedValue({
    text: '```json\n{"summary":"x","relatedItems":[]}\n```',
    citations: [],
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('expandSignal() — graph re-sync (backlog 0.2, service path)', () => {
  it('re-syncs the expanded signal to Neo4j after persisting', async () => {
    const res = await expandSignal('sig-1');

    expect(res.success).toBe(true);
    expect(mockSignalUpdate).toHaveBeenCalledTimes(1); // persisted
    const persisted = mockSignalUpdate.mock.calls[0][0];
    expect(persisted).toMatchObject({ expansionFailed: false });
    expect(persisted).toHaveProperty('expansionError');
    expect(persisted).toHaveProperty('expansionFailedAt');
    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/unified-entity.sync.requested',
      data: { entityId: 'sig-1', entityType: 'signal', operation: 'update' },
    });
  });

  it('still succeeds when the graph re-sync fails (best-effort, non-fatal)', async () => {
    mockSend.mockRejectedValueOnce(new Error('inngest down'));

    const res = await expandSignal('sig-1');

    expect(res.success).toBe(true);
    expect(res.expandedContent).toBeDefined();
  });

  it('does not re-sync when expansion itself fails (no persist)', async () => {
    mockGenerateGroundedContent.mockRejectedValue(new Error('gemini error'));

    const res = await expandSignal('sig-1');

    expect(res.success).toBe(false);
    expect(mockSignalUpdate).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('persists the original URL plus actual grounded citations with normalized stance', async () => {
    mockGenerateGroundedContent.mockResolvedValueOnce({
      text: `\`\`\`json
{"sources":[
  {"title":"Declared title","url":"https://evidence.example/report?utm_source=gemini","verdict":"confirming"},
  {"title":"Invented","url":"https://invented.example/report","verdict":"confirming"}
]}
\`\`\``,
      citations: [
        { uri: 'https://evidence.example/report?fbclid=abc', title: 'Grounded title' },
        { uri: 'https://unclear.example/report', title: 'Unclassified grounding source' },
      ],
    });

    const res = await expandSignal('sig-1');

    expect(res.success).toBe(true);
    expect(res.expandedContent?.sources).toEqual([
      {
        title: 'Original source',
        url: 'https://original.example/story',
        verdict: 'confirming',
      },
      {
        title: 'Grounded title',
        url: 'https://evidence.example/report?fbclid=abc',
        verdict: 'confirming',
      },
      {
        title: 'Unclassified grounding source',
        url: 'https://unclear.example/report',
        verdict: 'inconclusive',
      },
    ]);
    expect(res.expandedContent?.sources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ url: 'https://invented.example/report' })])
    );
  });

  it('binds a real-shaped Gemini redirect citation to its declared publisher URL', async () => {
    const redirectUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'https://publisher.example/report?fbclid=google' }),
    } as Response);
    mockGenerateGroundedContent.mockResolvedValueOnce({
      text: `\`\`\`json
{"sources":[{"title":"Publisher","url":"https://publisher.example/report?utm_source=gemini","verdict":"confirming"}]}
\`\`\``,
      citations: [{ uri: redirectUrl, title: 'publisher.example' }],
    });

    const res = await expandSignal('sig-1');

    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.expandedContent?.sources).toEqual([
      {
        title: 'Original source',
        url: 'https://original.example/story',
        verdict: 'confirming',
      },
      {
        title: 'publisher.example',
        url: redirectUrl,
        verdict: 'confirming',
      },
    ]);
    expect(mockCalculateTrustScore).toHaveBeenCalledWith(
      expect.objectContaining({ hasCorroboration: true, corroboratingSourceCount: 2 })
    );
    fetchSpy.mockRestore();
  });

  it('keeps a self-declared Google redirect inconclusive when resolution fails', async () => {
    const redirectUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token';
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    mockGenerateGroundedContent.mockResolvedValueOnce({
      text: `\`\`\`json
{"sources":[{"title":"Redirect","url":"${redirectUrl}","verdict":"confirming"}]}
\`\`\``,
      citations: [{ uri: redirectUrl, title: 'publisher.example' }],
    });

    const res = await expandSignal('sig-1');

    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.expandedContent?.sources?.[1]).toEqual({
      title: 'publisher.example',
      url: redirectUrl,
      verdict: 'inconclusive',
    });
    expect(mockCalculateTrustScore).toHaveBeenCalledWith(
      expect.objectContaining({ hasCorroboration: false, corroboratingSourceCount: 1 })
    );
    fetchSpy.mockRestore();
  });

  it('does not claim search corroboration when grounding returns zero citations', async () => {
    mockGenerateGroundedContent.mockResolvedValueOnce({
      text: `\`\`\`json
{"sources":[{"title":"Invented","url":"https://invented.example/report","verdict":"confirming"}]}
\`\`\``,
      citations: [],
    });

    const res = await expandSignal('sig-1', { useGoogleSearch: true });

    expect(res.success).toBe(true);
    expect(res.expandedContent?.sources).toEqual([
      {
        title: 'Original source',
        url: 'https://original.example/story',
        verdict: 'confirming',
      },
    ]);
    expect(mockCalculateTrustScore).toHaveBeenCalledWith(
      expect.objectContaining({ hasCorroboration: false, corroboratingSourceCount: 1 })
    );
  });

  it('uses the ungrounded client only when search is explicitly disabled', async () => {
    await expandSignal('sig-1', { useGoogleSearch: false });

    expect(mockGenerateContent).toHaveBeenCalledWith('prompt', expect.objectContaining({ useGoogleSearch: false }));
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();
  });
});
