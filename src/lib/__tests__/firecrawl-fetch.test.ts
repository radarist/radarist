/**
 * @file lib/__tests__/firecrawl-fetch.test.ts
 * @description ARUN-022 — the centralized Firecrawl fetch boundary.
 *
 * Pins requirement #7: one provider call produces one receipt; the basic HTTP
 * fallback is zero-provider and must NEVER fabricate a receipt; the fee is
 * applicable-but-unknown (Firecrawl reports no per-call amount, so it never
 * reads as $0); and capture is content-free (no URL/title/page text).
 *
 * @jest-environment node
 */

export {};

const mockCaptureProviderUsage = jest.fn();
jest.mock('@/lib/operation-context', () => ({
  captureProviderUsage: (...args: unknown[]) => mockCaptureProviderUsage(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof global.fetch;

const { fetchUrlContent } = require('../firecrawl-fetch');

describe('firecrawl-fetch — ARUN-022 receipt boundary', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('emits exactly ONE receipt on a successful Firecrawl call', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { markdown: '# Page', metadata: { title: 'T' } } }),
    });

    const result = await fetchUrlContent('https://example.com/page');

    expect(result).toEqual({
      success: true,
      usedFirecrawl: true,
      content: '# Page',
      title: 'T',
    });
    expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
  });

  it('emits exactly ONE receipt when Firecrawl returns an HTTP error', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    // Firecrawl HTTP error → one receipt (call was made) → fall back to basic fetch.
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><body>X</body></html>' });

    const result = await fetchUrlContent('https://example.com/err');

    expect(result.success).toBe(true);
    expect(result.usedFirecrawl).toBe(true);
    // Exactly one capture (the Firecrawl call), NOT one for the basic fallback.
    expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
  });

  it('emits exactly ONE receipt when the Firecrawl fetch throws', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, text: async () => '<html><body>Y</body></html>' });

    const result = await fetchUrlContent('https://example.com/throw');

    expect(result.success).toBe(true);
    expect(result.usedFirecrawl).toBe(true);
    expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
  });

  it('NEVER fabricates a receipt for the zero-provider basic HTTP fallback', async () => {
    // No API key → straight to the basic fetch, which is NOT a provider call.
    delete process.env.FIRECRAWL_API_KEY;
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => '<html><body>Z</body></html>' });

    const result = await fetchUrlContent('https://example.com/basic');

    expect(result.success).toBe(true);
    expect(result.usedFirecrawl).toBe(false);
    expect(mockCaptureProviderUsage).not.toHaveBeenCalled();
  });

  it('records an applicable-but-unknown fee (Firecrawl reports no per-call amount)', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { markdown: 'c' } }),
    });

    await fetchUrlContent('https://example.com/fee');

    const captured = mockCaptureProviderUsage.mock.calls[0][0] as Record<string, unknown>;
    expect(captured.provider).toBe('firecrawl');
    expect(captured.operation).toBe('firecrawl.scrape');
    expect(captured.feeState).toBe('applicable-but-unknown');
    expect(captured.usageCompleteness).toBe('unreported');
    expect(captured.externalFees).toBeUndefined();
  });

  it('capture is content-free (no URL, title, or page text in the receipt)', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { markdown: 'SECRET PAGE CONTENT', metadata: { title: 'SECRET TITLE' } },
      }),
    });

    await fetchUrlContent('https://example.com/secret-url');

    const serialized = JSON.stringify(mockCaptureProviderUsage.mock.calls[0][0]);
    expect(serialized).not.toContain('SECRET PAGE CONTENT');
    expect(serialized).not.toContain('SECRET TITLE');
    expect(serialized).not.toContain('secret-url');
  });

  it('never throws into the fetch path when capture fails', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-key';
    mockCaptureProviderUsage.mockImplementation(() => {
      throw new Error('sink broken');
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { markdown: 'c' } }),
    });

    await expect(fetchUrlContent('https://example.com/sink-throws')).resolves.toEqual(
      expect.objectContaining({ success: true, usedFirecrawl: true })
    );
    mockCaptureProviderUsage.mockReset();
  });
});
