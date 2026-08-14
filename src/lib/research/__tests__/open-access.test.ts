/**
 * @jest-environment node
 *
 * @file lib/research/__tests__/open-access.test.ts
 * @description Unit tests for `resolveOpenAccess` (Unpaywall). The upstream
 * `politeFetch` and `getResearchContactEmail` are mocked (jest.mock('../http'))
 * so no network is hit — mirrors the fetch-mock idiom in papers.test.ts.
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
const mockLogInfo = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import { resolveOpenAccess } from '../open-access';
import { ResearchFetchError } from '../http';

/** Wrap a plain object as a minimal `Response`-like value (only `.json()` used). */
function jsonResponse(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEmail.mockReturnValue(undefined);
});

describe('resolveOpenAccess — email-unset short-circuit', () => {
  it('returns the email-not-configured result WITHOUT calling fetch, WITHOUT error, and logs it', async () => {
    mockGetEmail.mockReturnValue(undefined);

    const { data, error } = await resolveOpenAccess({ doi: '10.1109/CVPR.2016.90' });

    expect(data).toEqual({
      isOA: false,
      pdfUrl: null,
      hostType: null,
      version: 'email-not-configured',
    });
    // Not a failure — a configuration state. `error` must stay unset.
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalled();
  });
});

describe('resolveOpenAccess — happy path', () => {
  beforeEach(() => mockGetEmail.mockReturnValue('me@example.com'));

  it('maps an OA hit from best_oa_location', async () => {
    mockPoliteFetch.mockResolvedValue(
      jsonResponse({
        is_oa: true,
        best_oa_location: {
          url_for_pdf: 'https://example.org/paper.pdf',
          host_type: 'repository',
          version: 'publishedVersion',
        },
      })
    );

    const { data, error } = await resolveOpenAccess({ doi: '10.1109/CVPR.2016.90' });

    expect(error).toBeUndefined();
    expect(data).toEqual({
      isOA: true,
      pdfUrl: 'https://example.org/paper.pdf',
      hostType: 'repository',
      version: 'publishedVersion',
    });
    const calledUrl = mockPoliteFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api.unpaywall.org/v2/');
    expect(calledUrl).toContain(encodeURIComponent('10.1109/CVPR.2016.90'));
    expect(calledUrl).toContain('email=me%40example.com');
  });

  it('maps is_oa: false to a fully-null non-OA result, with no error (genuinely not open access)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ is_oa: false, best_oa_location: null }));

    const { data, error } = await resolveOpenAccess({ doi: '10.1/not-oa' });

    expect(error).toBeUndefined();
    expect(data).toEqual({ isOA: false, pdfUrl: null, hostType: null, version: null });
  });

  it('treats a missing best_oa_location as fully null even when is_oa is true', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ is_oa: true }));

    const { data, error } = await resolveOpenAccess({ doi: '10.1/weird' });

    expect(error).toBeUndefined();
    expect(data).toEqual({ isOA: true, pdfUrl: null, hostType: null, version: null });
  });
});

describe('resolveOpenAccess — degradation', () => {
  beforeEach(() => mockGetEmail.mockReturnValue('me@example.com'));

  it('sets error (not just the non-OA default) when the upstream fetch rejects with a ResearchFetchError', async () => {
    mockPoliteFetch.mockRejectedValue(new ResearchFetchError('Upstream 404 for x', 404));

    const { data, error } = await resolveOpenAccess({ doi: '10.1/missing' });

    expect(data).toEqual({ isOA: false, pdfUrl: null, hostType: null, version: null });
    expect(error).toBeDefined();
    expect(error).toContain('404');
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('sets error when the response shape is malformed (schema-invalid)', async () => {
    mockPoliteFetch.mockResolvedValue(jsonResponse({ is_oa: 'not-a-boolean' }));

    const { data, error } = await resolveOpenAccess({ doi: '10.1/malformed' });

    expect(data).toEqual({ isOA: false, pdfUrl: null, hostType: null, version: null });
    expect(error).toBeDefined();
  });

  it('returns the non-OA default for a blank doi without fetching, with no error', async () => {
    const { data, error } = await resolveOpenAccess({ doi: '   ' });

    expect(data).toEqual({ isOA: false, pdfUrl: null, hostType: null, version: null });
    expect(error).toBeUndefined();
    expect(mockPoliteFetch).not.toHaveBeenCalled();
  });
});
