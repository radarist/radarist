import { verifyUrlsReachable } from '../scout-url-verifier';

describe('verifyUrlsReachable', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('passes when all URLs return 2xx or 3xx', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit?]>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 301 }));
    const result = await verifyUrlsReachable(['https://a.example.com/1', 'https://b.example.com/2'], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
  });

  it('fails when any URL returns 404', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit?]>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await verifyUrlsReachable(['https://a.example.com/1', 'https://b.example.com/fake-paper.pdf'], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unreachable).toHaveLength(1);
      expect(result.unreachable[0].url).toBe('https://b.example.com/fake-paper.pdf');
      expect(result.unreachable[0].reason).toMatch(/404/);
    }
  });

  it('treats timeout as inconclusive (passes)', async () => {
    const fetchMock = jest
      .fn<Promise<Response>, [string, RequestInit?]>()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new DOMException('The operation was aborted', 'AbortError')), 10)
          )
      );
    const result = await verifyUrlsReachable(['https://slow.example.com/1'], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5,
    });
    expect(result.ok).toBe(true);
  });

  it('treats DNS failure as unreachable (fails)', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>().mockRejectedValueOnce(dnsError);
    const result = await verifyUrlsReachable(['https://nxdomain.fake.invalid/1'], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unreachable[0].reason).toMatch(/ENOTFOUND|dns/i);
    }
  });

  it('fails fast on malformed URL without calling fetch', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
    const result = await verifyUrlsReachable(['not-a-url', 'https://ok.example.com/'], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unreachable.some((u) => u.url === 'not-a-url')).toBe(true);
    }
  });

  it('passes when given an empty URL list', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
    const result = await verifyUrlsReachable([], {
      fetchImpl: fetchMock as unknown as typeof fetch,
      perUrlTimeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
