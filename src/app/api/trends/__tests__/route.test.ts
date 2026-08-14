/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Mock google-trends-api
jest.mock('google-trends-api', () => ({
  interestOverTime: jest.fn(),
}), { virtual: true });

// Mock google-search-results-nodejs
jest.mock('google-search-results-nodejs', () => ({
  getJson: jest.fn(),
}), { virtual: true });

const googleTrends = jest.requireMock('google-trends-api');
const { getJson } = jest.requireMock('google-search-results-nodejs');

// Import route AFTER mocks
import { GET, sanitizeTrendKeyword } from '../route';

function createMockRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/trends');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/trends', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SERPAPI_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest({ keyword: 'AI' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when keyword is missing', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('Keyword is required');
  });

  it('returns trend data from google-trends-api on success', async () => {
    const mockTimeline = {
      default: {
        timelineData: [
          { formattedTime: 'Jan 2025', value: [75] },
          { formattedTime: 'Feb 2025', value: [80] },
          { formattedTime: 'Mar 2025', value: [90] },
        ],
      },
    };
    googleTrends.interestOverTime.mockResolvedValue(JSON.stringify(mockTimeline));

    const res = await GET(createMockRequest({ keyword: 'AI' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Google Trends');
    expect(json.data).toHaveLength(3);
    expect(json.data[0]).toEqual({ date: 'Jan 2025', value: 75 });
  });

  it('returns fallback data when google-trends-api returns HTML (blocked)', async () => {
    googleTrends.interestOverTime.mockResolvedValue('<html>Rate limited</html>');

    const res = await GET(createMockRequest({ keyword: 'blockchain' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Fallback Data');
    expect(json.isEstimate).toBe(true);
    expect(json.data).toBeDefined();
    expect(json.data.length).toBeGreaterThan(0);
  });

  it('returns fallback data when all values are zero (no data)', async () => {
    const mockTimeline = {
      default: {
        timelineData: [
          { formattedTime: 'Jan 2025', value: [0] },
          { formattedTime: 'Feb 2025', value: [0] },
        ],
      },
    };
    googleTrends.interestOverTime.mockResolvedValue(JSON.stringify(mockTimeline));

    const res = await GET(createMockRequest({ keyword: 'xyznonexistent' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Fallback Data');
    expect(json.isEstimate).toBe(true);
    expect(json.warning).toContain('Insufficient search volume');
  });

  it('returns fallback data when google-trends-api throws', async () => {
    googleTrends.interestOverTime.mockRejectedValue(new Error('Network error'));

    const res = await GET(createMockRequest({ keyword: 'robotics' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Fallback Data');
    expect(json.isEstimate).toBe(true);
  });

  it('sanitizes keyword by removing parenthetical content', async () => {
    const mockTimeline = {
      default: {
        timelineData: [
          { formattedTime: 'Jan 2025', value: [50] },
        ],
      },
    };
    googleTrends.interestOverTime.mockResolvedValue(JSON.stringify(mockTimeline));

    await GET(createMockRequest({ keyword: 'Collaborative Robots (Cobots)' }));

    expect(googleTrends.interestOverTime).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: 'Collaborative Robots',
      })
    );
  });

  it('uses SerpApi when SERPAPI_KEY is set', async () => {
    process.env.SERPAPI_KEY = 'test-serpapi-key';

    getJson.mockImplementation((_params: Record<string, unknown>, callback: (json: Record<string, unknown>) => void) => {
      callback({
        interest_over_time: {
          timeline_data: [
            { date: 'Jan 2025', values: [{ extracted_value: 65 }] },
            { date: 'Feb 2025', values: [{ extracted_value: 72 }] },
          ],
        },
      });
    });

    const res = await GET(createMockRequest({ keyword: 'AI' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Google Trends (via SerpApi)');
    expect(json.data).toHaveLength(2);
    expect(json.data[0].value).toBe(65);
  });

  it('falls back to google-trends-api when SerpApi fails', async () => {
    process.env.SERPAPI_KEY = 'test-serpapi-key';

    getJson.mockImplementation((_params: Record<string, unknown>, callback: (json: Record<string, unknown>) => void) => {
      callback({ error: 'API quota exceeded' });
    });

    const mockTimeline = {
      default: {
        timelineData: [
          { formattedTime: 'Jan 2025', value: [50] },
        ],
      },
    };
    googleTrends.interestOverTime.mockResolvedValue(JSON.stringify(mockTimeline));

    const res = await GET(createMockRequest({ keyword: 'AI' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.source).toBe('Google Trends');
  });
});

describe('sanitizeTrendKeyword', () => {
  it('removes multiple parenthetical qualifiers with their adjacent whitespace', () => {
    expect(sanitizeTrendKeyword('Robots (Cobots) and AI (Enterprise)')).toBe('Robotsand AI');
  });

  it('preserves a long unmatched opening sequence without repeated suffix scans', () => {
    const input = `Robotics ${'('.repeat(20_000)}`;
    expect(sanitizeTrendKeyword(input)).toBe(input);
  });
});
