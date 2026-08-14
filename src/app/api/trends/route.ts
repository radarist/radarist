import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/trends');

// External libraries loaded via require to ensure server-side compatibility in Next.js
const googleTrends = require('google-trends-api');
const { getJson } = require('google-search-results-nodejs');

interface TrendDataPoint {
  date: string;
  value: number;
}

// In-memory cache to reduce API calls and avoid rate limiting
// Format: { keyword: { data: TrendData[], timestamp: number, source: string } }
const trendCache = new Map<string, { data: TrendDataPoint[], timestamp: number, source: string }>();
const _CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting: track last request time
const _lastRequestTime = 0;
const _MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests

/**
 * Remove parenthetical qualifiers without a backtracking regular expression.
 * Each opening parenthesis consumes at most one following closing parenthesis,
 * matching the former non-greedy behavior in linear time.
 */
export function sanitizeTrendKeyword(keyword: string): string {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < keyword.length) {
    const opening = keyword.indexOf('(', cursor);
    if (opening < 0) {
      chunks.push(keyword.slice(cursor));
      break;
    }

    const closing = keyword.indexOf(')', opening + 1);
    if (closing < 0) {
      chunks.push(keyword.slice(cursor));
      break;
    }

    let removalStart = opening;
    while (removalStart > cursor && keyword[removalStart - 1].trim().length === 0) {
      removalStart -= 1;
    }
    let removalEnd = closing + 1;
    while (removalEnd < keyword.length && keyword[removalEnd].trim().length === 0) {
      removalEnd += 1;
    }

    chunks.push(keyword.slice(cursor, removalStart));
    cursor = removalEnd;
  }

  const sanitized = chunks.join('').trim();
  return sanitized || keyword;
}

export async function GET(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const keyword = searchParams.get('keyword');

  if (!keyword) {
    return NextResponse.json({ error: 'Keyword is required' }, { status: 400 });
  }

  // Sanitize keyword: Remove content in parentheses if present
  // e.g. "Collaborative Robots (Cobots)" -> "Collaborative Robots"
  const sanitizedKeyword = sanitizeTrendKeyword(keyword);

  try {
    // 1. Try SerpApi if API Key is available (Primary, Reliable)
    if (process.env.SERPAPI_KEY) {
      try {
        const serpData = await fetchSerpApi(sanitizedKeyword, process.env.SERPAPI_KEY);
        return NextResponse.json({
          data: serpData,
          source: 'Google Trends (via SerpApi)'
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn('SerpApi failed, falling back to unofficial scraper', { keyword, error: errMsg });
      }
    }

    // 2. Fallback to google-trends-api (Unofficial Scraper, often blocked)
    const results = await googleTrends.interestOverTime({
      keyword: sanitizedKeyword,
      startTime: new Date(new Date().setFullYear(new Date().getFullYear() - 1)), // Last 1 year
    });

    // Google Trends API sometimes returns an HTML error page when rate limited or blocked
    if (typeof results === 'string' && results.trim().startsWith('<')) {
      throw new Error("Google Trends API blocked request (returned HTML)");
    }

    const parsedResults = JSON.parse(results);

    if (parsedResults.default && parsedResults.default.timelineData) {
      const timelineData = parsedResults.default.timelineData;

      // Check if all values are 0 (no data found for this specific term)
      const allZero = timelineData.every((item: Record<string, unknown>) => (item.value as number[])[0] === 0);

      if (allZero) {
        throw new Error("No trend data found (all zeros)");
      }

      const formattedData = timelineData.map((item: Record<string, unknown>) => ({
        date: item.formattedTime as string,
        value: Number((item.value as number[])[0]),
      }));

      // Cache successful result
      trendCache.set(sanitizedKeyword.toLowerCase(), {
        data: formattedData,
        timestamp: Date.now(),
        source: 'Google Trends'
      });

      return NextResponse.json({
        data: formattedData,
        source: 'Google Trends'
      });
    } else {
      throw new Error('Invalid response structure');
    }

  } catch (error: unknown) {
    // Suppress verbose logging for expected blocking/parsing errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isBlocked = errorMessage?.includes("blocked") || error instanceof SyntaxError;
    const isNoData = errorMessage?.includes("all zeros");

    if (isBlocked) {
      log.warn('Google Trends blocked request, using fallback', { keyword: sanitizedKeyword });
    } else if (isNoData) {
      log.warn('No trend data available', { keyword: sanitizedKeyword });
    } else {
      log.error('Trend API error', undefined, { error: errorMessage });
    }

    // 3. Final Fallback: Mock Data (Simulation)
    const mockData = generateMockTrendData();
    return NextResponse.json({
      data: mockData,
      source: 'Fallback Data',
      warning: isNoData
        ? 'Insufficient search volume for this term. Showing generic trend pattern.'
        : 'Google Trends temporarily unavailable. Showing estimated pattern based on typical technology adoption curves.',
      isEstimate: true
    });
  }
}

// Helper to wrap SerpApi callback in Promise
function fetchSerpApi(keyword: string, apiKey: string): Promise<TrendDataPoint[]> {
  return new Promise((resolve, reject) => {
    getJson({
      engine: "google_trends",
      q: keyword,
      api_key: apiKey,
      date: "today 12-m" // Last 12 months
    }, (json: Record<string, unknown>) => {
      if (json.error) return reject(new Error(json.error as string));
      const interestOverTime = json.interest_over_time as Record<string, unknown> | undefined;
      if (!interestOverTime || !interestOverTime.timeline_data) {
        return reject(new Error("No timeline data in SerpApi response"));
      }

      // Parse SerpApi response format
      const timelineData = interestOverTime.timeline_data as Record<string, unknown>[];
      const data = timelineData.map((item: Record<string, unknown>) => ({
        date: item.date as string,
        // SerpApi values are arrays (e.g. values: [{ query_value: "...", value: "100", extracted_value: 100 }])
        value: item.values && (item.values as Record<string, unknown>[])[0] ? Number((item.values as Record<string, unknown>[])[0].extracted_value) : 0
      }));
      resolve(data);
    });
  });
}

function generateMockTrendData() {
  const data = [];
  const now = new Date();
  const baseValue = 45;

  for (let i = 12; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // S-curve adoption pattern with some randomness
    const progress = (12 - i) / 12; // 0 to 1
    const sCurve = 100 / (1 + Math.exp(-8 * (progress - 0.5))); // Sigmoid function
    const noise = (Math.random() - 0.5) * 10; // ±5 points of noise
    const value = Math.max(10, Math.min(100, baseValue + sCurve * 0.3 + noise));

    data.push({
      date: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      value: Math.round(value),
    });
  }
  return data;
}
