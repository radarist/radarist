/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/oss-health.test.ts
 * @description Unit tests for `searchOssHealth` (Ecosyste.ms repos API). The
 * upstream `politeFetch` is mocked (jest.mock('../http')) so no network is
 * hit — mirrors the fetch-mock idiom in papers.test.ts.
 */

// ============================================================================
// Mocks
// ============================================================================

const mockPoliteFetch = jest.fn();
const mockGetEmail = jest.fn<string | undefined, []>(() => undefined);

jest.mock('../http', () => ({
  __esModule: true,
  politeFetch: (...args: unknown[]) => mockPoliteFetch(...args),
  getResearchContactEmail: () => mockGetEmail(),
  ResearchFetchError: class ResearchFetchError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'ResearchFetchError';
      this.status = status;
    }
  },
}));

const mockLogWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import { searchOssHealth } from '../oss-health';
import { ResearchFetchError } from '../http';

const ATTRIBUTION = 'Data: Ecosyste.ms (CC-BY-SA 4.0)';

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

const REPO_BODY = {
  full_name: 'facebook/react',
  stargazers_count: 220000,
  pushed_at: '2026-06-01T00:00:00Z',
  commit_stats: {
    total_commits: 26011,
    total_committers: 1600,
    dds: 0.88,
  },
  scorecard: {
    score: 7.2,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmail.mockReturnValue(undefined);
});

describe('searchOssHealth — happy path', () => {
  it('maps available metrics (stargazers_count, commit_stats.total_committers, pushed_at, scorecard.score) and always sets the CC-BY-SA attribution', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(REPO_BODY));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'facebook/react' });

    expect(error).toBeUndefined();
    expect(data.name).toBe('facebook/react');
    expect(data.stars).toBe(220000);
    expect(data.contributors).toBe(1600);
    expect(data.lastCommit).toBe('2026-06-01T00:00:00Z');
    expect(data.maintenanceScore).toBe(7.2);
    expect(data.attribution).toBe(ATTRIBUTION);
  });

  it('never invents downloads/dependentsCount/advisories — the repos endpoint does not offer them', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(REPO_BODY));

    const { data } = await searchOssHealth({ repoOrPackage: 'facebook/react' });

    expect(data.downloads).toBeNull();
    expect(data.dependentsCount).toBeNull();
    expect(data.advisories).toBeNull();
  });

  it('maps maintenanceScore to null when scorecard.score is null (honest null, matches live Ecosyste.ms behavior for most repos)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ ...REPO_BODY, scorecard: { score: null } }));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'facebook/react' });

    expect(error).toBeUndefined();
    expect(data.maintenanceScore).toBeNull();
  });

  it('builds the repos.ecosyste.ms URL from owner/repo', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(REPO_BODY));

    await searchOssHealth({ repoOrPackage: 'facebook/react' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/facebook/react');
  });

  it('appends ?mailto= when a contact email is configured', async () => {
    mockGetEmail.mockReturnValue('me@example.com');
    mockPoliteFetch.mockResolvedValue(jsonResponse(REPO_BODY));

    await searchOssHealth({ repoOrPackage: 'facebook/react' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('mailto=me%40example.com');
  });

  it('never invents missing metrics — absent fields map to null, not 0', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ full_name: 'lonely/repo' }));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'lonely/repo' });

    expect(error).toBeUndefined();
    expect(data.name).toBe('lonely/repo');
    expect(data.stars).toBeNull();
    expect(data.contributors).toBeNull();
    expect(data.lastCommit).toBeNull();
    expect(data.downloads).toBeNull();
    expect(data.dependentsCount).toBeNull();
    expect(data.advisories).toBeNull();
    expect(data.maintenanceScore).toBeNull();
    expect(data.attribution).toBe(ATTRIBUTION);
  });

  it('parses owner/repo out of a full GitHub URL', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse(REPO_BODY));

    await searchOssHealth({ repoOrPackage: 'https://github.com/facebook/react' });

    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/facebook/react');
  });
});

describe('searchOssHealth — degradation', () => {
  it('sets error (not just an all-null result) WITH attribution + all-null metrics on a ResearchFetchError 404', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 404 for x', 404));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'ghost/repo' });

    expect(data).toEqual({
      name: 'ghost/repo',
      stars: null,
      contributors: null,
      lastCommit: null,
      downloads: null,
      dependentsCount: null,
      advisories: null,
      maintenanceScore: null,
      attribution: ATTRIBUTION,
    });
    expect(error).toBeDefined();
    expect(error).toContain('404');
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('sets error on the same typed empty result for a generic upstream ResearchFetchError', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 500 for x', 500));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'broken/repo' });

    expect(data.attribution).toBe(ATTRIBUTION);
    expect(data.stars).toBeNull();
    expect(error).toBeDefined();
  });

  it('sets error when the response shape is malformed (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ stargazers_count: 'not-a-number' }));

    const { data, error } = await searchOssHealth({ repoOrPackage: 'weird/repo' });

    expect(data.attribution).toBe(ATTRIBUTION);
    expect(data.stars).toBeNull();
    expect(error).toBeDefined();
  });

  it('sets a bad-input error WITHOUT fetching when the input cannot be parsed as owner/repo (e.g. a bare project name)', async () => {
    const { data, error } = await searchOssHealth({ repoOrPackage: 'pgvector' });

    expect(data.attribution).toBe(ATTRIBUTION);
    expect(data.stars).toBeNull();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalled();
    expect(error).toBeDefined();
    expect(error).toContain('owner/repo');
  });

  it('returns a typed empty result for a blank input without fetching, with no error', async () => {
    const { data, error } = await searchOssHealth({ repoOrPackage: '   ' });

    expect(data.attribution).toBe(ATTRIBUTION);
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });
});
