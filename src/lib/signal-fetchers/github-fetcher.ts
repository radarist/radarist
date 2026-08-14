/**
 * @file lib/signal-fetchers/github-fetcher.ts
 * @description Fetches technology signals from GitHub
 *
 * This fetcher searches for trending repositories and releases using
 * keywords and returns relevant projects as signals.
 *
 * **Data Source:** GitHub (https://github.com/)
 * **API:** GitHub REST API v3
 * **Rate Limits:** 60 requests/hour (unauthenticated), 5000 requests/hour (authenticated)
 * **Authentication:** Optional but recommended (use personal access token)
 *
 * **Setup (Optional but recommended):**
 * 1. Create personal access token: https://github.com/settings/tokens
 * 2. Add to .env.local: GITHUB_TOKEN=your_token_here
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import {
  BaseFetcher,
  PermanentSourceError,
  isNonJsonContentType,
  isPermanentHttpStatus,
  type FetchSignalsParams,
  type RawSignalItem,
} from './base-fetcher';
import { searchOssHealth } from '../research/oss-health';
import { createLogger } from '@/lib/logger';

const log = createLogger('signal-fetchers/github');

/**
 * GitHub search rejects queries with more than five AND/OR/NOT boolean
 * operators (documented limit) and queries longer than 256 characters — both
 * return HTTP 422 "Validation Failed". We OR the keyword terms together, so N
 * terms cost N-1 operators; cap the term count and the total length to stay
 * inside the contract. (OPS-002)
 */
export const MAX_GITHUB_QUERY_TERMS = 5;
const MAX_GITHUB_QUERY_LENGTH = 256;

/**
 * Build a GitHub repository-search query that respects GitHub's documented
 * contract: at most five boolean operators, at most 256 characters, and no
 * undocumented qualifier values. Forks are excluded by GitHub search by
 * default, so the previously-appended `fork:false` (whose only documented
 * values are `true`/`only`) is intentionally omitted — it was a 422 trigger.
 * Exported for direct contract testing. (OPS-002)
 */
export function buildGitHubSearchQuery(keywords: string[], startDate: Date): string {
  const escaped = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => (k.includes(' ') ? `"${k}"` : k));

  const dateFilter = `pushed:>=${startDate.toISOString().split('T')[0]}`;
  const qualifiers = `${dateFilter} stars:>10`;

  // Add keyword terms one at a time, staying within BOTH the operator cap and
  // the 256-char limit; drop the rest rather than emit a query GitHub rejects.
  const terms: string[] = [];
  for (const term of escaped) {
    if (terms.length >= MAX_GITHUB_QUERY_TERMS) break;
    const candidate = [...terms, term].join(' OR ');
    // A single oversized term must not prevent a later, shorter keyword from
    // producing a scoped query. Skip it and keep looking within the bounded
    // input list.
    if (`${candidate} ${qualifiers}`.length > MAX_GITHUB_QUERY_LENGTH) continue;
    terms.push(term);
  }

  const keywordQuery = terms.join(' OR ');
  if (!keywordQuery) {
    throw new PermanentSourceError(
      'GitHub search has no usable keyword within the 256-character query limit.'
    );
  }
  return `${keywordQuery} ${qualifiers}`;
}

/** GitHub reports primary and secondary rate limits as either 403 or 429. */
function isGitHubRateLimitResponse(response: Response, message: string): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.has('retry-after') ||
    /(?:rate limit|abuse detection)/i.test(message)
  );
}

/**
 * Cap on how many fetched repos get an OSS-health enrichment lookup per
 * `fetchFromSource` call. Each lookup is a network round-trip to Ecosyste.ms
 * (Component-A `searchOssHealth`), so fan-out is bounded rather than firing
 * one request per returned repo.
 */
const OSS_ENRICH_MAX = 10;

/**
 * Repository from GitHub API
 */
interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  language: string | null;
  topics: string[];
  owner: {
    login: string;
    type: string;
  };
}

/**
 * GitHub search response
 */
interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepository[];
}

/**
 * GitHub fetcher using GitHub REST API
 *
 * Searches for repositories that match keywords and were recently updated.
 *
 * **API Documentation:** https://docs.github.com/en/rest
 *
 * **Search Endpoints:**
 * - /search/repositories: Search repositories
 * - /search/code: Search code
 * - /search/issues: Search issues/PRs
 */
export class GitHubFetcher extends BaseFetcher {
  protected readonly source = 'github' as const;

  /**
   * GitHub API base URL
   */
  private readonly API_BASE = 'https://api.github.com';

  /**
   * GitHub token from environment (optional)
   */
  private readonly GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  /**
   * Fetch GitHub repositories
   *
   * @param params Fetch parameters
   * @returns Array of raw repository items
   */
  protected async fetchFromSource(params: FetchSignalsParams): Promise<RawSignalItem[]> {
    const { startDate } = this.getDateRange(params.timeRangeDays);

    // Build query for GitHub search (contract-bounded — see buildGitHubSearchQuery)
    const query = buildGitHubSearchQuery(params.keywords, startDate);

    // Build URL
    const url = new URL(`${this.API_BASE}/search/repositories`);
    url.searchParams.set('q', query);
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('per_page', String(Math.min(params.maxSignals * 2, 100)));

    // Prepare headers
    const headers: HeadersInit = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Radarist-Innovation-Platform',
    };

    if (this.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${this.GITHUB_TOKEN}`;
    }

    // Fetch with retry logic. Permanent contract failures (422 validation
    // errors, other permanent 4xx, HTML error bodies) are thrown as
    // PermanentSourceError so they fail fast instead of retrying every cycle.
    const response = await this.retry(async () => {
      const res = await fetch(url.toString(), { headers });

      if (!res.ok) {
        const errorData = (await res.json().catch(() => ({}))) as { message?: string };
        const message = `GitHub API error: ${res.status} ${errorData.message || res.statusText}`;
        if (isPermanentHttpStatus(res.status) && !isGitHubRateLimitResponse(res, errorData.message ?? '')) {
          throw new PermanentSourceError(message);
        }
        throw new Error(message);
      }

      // A JSON API that answers 200 with an HTML body is a contract violation
      // that will not clear on retry (e.g. an interstitial or an error page).
      if (isNonJsonContentType(res.headers?.get?.('content-type'))) {
        throw new PermanentSourceError(
          `GitHub API returned a non-JSON body (content-type: ${res.headers?.get?.('content-type')})`
        );
      }

      try {
        return (await res.json()) as GitHubSearchResponse;
      } catch (parseError) {
        throw new PermanentSourceError(
          `GitHub API returned an unparseable body: ${parseError instanceof Error ? parseError.message : 'invalid JSON'}`
        );
      }
    });

    // Convert to RawSignalItem format
    const items = response.items.map((repo) => this.convertRepoToRawItem(repo));

    // Best-effort OSS-health enrichment — bounded, never blocks/fails the fetch.
    await this.enrichWithOssHealth(items);

    return items;
  }

  /**
   * Attach OSS-health metrics (contributors, last commit, maintenance score)
   * + CC-BY-SA attribution to the first `OSS_ENRICH_MAX` items via the
   * keyless Component-A `searchOssHealth` (Ecosyste.ms) tool.
   *
   * `searchOssHealth` never throws by contract, but every async operation
   * still needs its own try/catch per project convention — an error, or a
   * response with no usable signal, leaves the item's metadata untouched.
   * This never fabricates data and never fails/blocks the overall fetch.
   *
   * @param items Raw items to enrich in place (mutated)
   */
  private async enrichWithOssHealth(items: RawSignalItem[]): Promise<void> {
    const enrichable = items.slice(0, OSS_ENRICH_MAX);

    await Promise.all(
      enrichable.map(async (item) => {
        try {
          const { data, error } = await searchOssHealth({ repoOrPackage: item.title });
          if (error) return; // upstream failure — leave the item unchanged, never fabricate

          const hasSignal = data.stars !== null || data.contributors !== null || data.lastCommit !== null;
          if (!hasSignal) return; // Ecosyste.ms had no usable data for this slug

          item.metadata = {
            ...item.metadata,
            ossHealth: {
              stars: data.stars,
              contributors: data.contributors,
              lastCommit: data.lastCommit,
              maintenanceScore: data.maintenanceScore,
              attribution: data.attribution,
            },
          };
        } catch (err) {
          log.debug('OSS-health enrichment failed; leaving item unchanged', {
            repo: item.title,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  /**
   * Convert GitHub repository to raw signal item
   *
   * @param repo Repository from API
   * @returns Raw signal item
   */
  private convertRepoToRawItem(repo: GitHubRepository): RawSignalItem {
    // Use pushed_at (most recent activity) as the date
    const date = new Date(repo.pushed_at);

    return {
      id: String(repo.id),
      title: repo.full_name,
      description: repo.description || 'No description provided.',
      url: repo.html_url,
      date,
      metadata: {
        repoName: repo.name,
        owner: repo.owner.login,
        ownerType: repo.owner.type,
        stars: repo.stargazers_count,
        watchers: repo.watchers_count,
        forks: repo.forks_count,
        language: repo.language,
        topics: repo.topics,
        createdAt: repo.created_at,
        updatedAt: repo.updated_at,
        pushedAt: repo.pushed_at,
      },
    };
  }
}

/**
 * Create and export singleton instance
 */
export const githubFetcher = new GitHubFetcher();
