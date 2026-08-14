/**
 * @jest-environment node
 *
 * @file ai/tools/__tests__/primary-source-tools.test.ts
 * @description Unit tests for the 5 primary-source research tool wrappers
 * (searchPapers, resolveOpenAccess, searchHackerNews, searchSecFilings,
 * searchOssHealth). The underlying `src/lib/research/*` modules are mocked so
 * each test controls the resolved value / throw directly — mirrors the
 * mocking idiom in `web-research.test.ts`.
 */

// ============================================================================
// Mocks
// ============================================================================

const mockSearchPapers = jest.fn();
jest.mock('@/lib/research/papers', () => ({
  __esModule: true,
  searchPapers: (...args: unknown[]) => mockSearchPapers(...args),
}));

const mockResolveOpenAccess = jest.fn();
jest.mock('@/lib/research/open-access', () => ({
  __esModule: true,
  resolveOpenAccess: (...args: unknown[]) => mockResolveOpenAccess(...args),
}));

const mockSearchHackerNews = jest.fn();
jest.mock('@/lib/research/hn', () => ({
  __esModule: true,
  searchHackerNews: (...args: unknown[]) => mockSearchHackerNews(...args),
}));

const mockSearchSecFilings = jest.fn();
jest.mock('@/lib/research/sec', () => ({
  __esModule: true,
  searchSecFilings: (...args: unknown[]) => mockSearchSecFilings(...args),
}));

const mockSearchOssHealth = jest.fn();
jest.mock('@/lib/research/oss-health', () => ({
  __esModule: true,
  searchOssHealth: (...args: unknown[]) => mockSearchOssHealth(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  executeSearchPapers,
  executeResolveOpenAccess,
  executeSearchHackerNews,
  executeSearchSecFilings,
  executeSearchOssHealth,
  PRIMARY_SOURCE_TOOLS,
} from '../primary-source-tools';

describe('Primary-Source Research Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // PRIMARY_SOURCE_TOOLS declarations
  // --------------------------------------------------------------------------
  describe('PRIMARY_SOURCE_TOOLS', () => {
    it('declares all six tools by name', () => {
      const names = PRIMARY_SOURCE_TOOLS.map((t) => t.name);
      expect(names).toEqual([
        'searchPapers',
        'resolveOpenAccess',
        'searchHackerNews',
        'searchSecFilings',
        'searchOssHealth',
        'searchPatents',
      ]);
    });

    it('every declaration has a non-empty description mentioning "never invent"', () => {
      for (const tool of PRIMARY_SOURCE_TOOLS) {
        expect(tool.description).toBeTruthy();
        expect(tool.description?.toLowerCase()).toContain('never invent');
      }
    });

    it("searchOssHealth's description notes the CC-BY-SA attribution", () => {
      const tool = PRIMARY_SOURCE_TOOLS.find((t) => t.name === 'searchOssHealth');
      expect(tool?.description).toContain('CC-BY-SA');
    });
  });

  // --------------------------------------------------------------------------
  // executeSearchPapers
  // --------------------------------------------------------------------------
  describe('executeSearchPapers', () => {
    it('calls searchPapers with mapped args and wraps success', async () => {
      const papers = [
        {
          title: 'A Paper',
          authors: ['A. Author'],
          year: 2024,
          url: 'https://x',
          abstract: null,
          citationCount: 1,
          source: 'openalex',
          doi: null,
          citation: 'A. Author (2024). A Paper. https://x',
        },
      ];
      mockSearchPapers.mockResolvedValue({ data: papers });

      const result = await executeSearchPapers({ query: 'graph rag', source: 'openalex', limit: 5, yearFrom: 2020 });

      expect(mockSearchPapers).toHaveBeenCalledWith({
        query: 'graph rag',
        source: 'openalex',
        limit: 5,
        yearFrom: 2020,
      });
      expect(result).toEqual({ success: true, data: { count: 1, papers } });
    });

    it('defaults source to "all" when not provided', async () => {
      mockSearchPapers.mockResolvedValue({ data: [] });
      await executeSearchPapers({ query: 'x' });
      expect(mockSearchPapers).toHaveBeenCalledWith({
        query: 'x',
        source: 'all',
        limit: undefined,
        yearFrom: undefined,
      });
    });

    it('returns a failure ToolResult when searchPapers resolves with an upstream error (not a throw)', async () => {
      mockSearchPapers.mockResolvedValue({ data: [], error: 'All paper sources failed' });

      const result = await executeSearchPapers({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'All paper sources failed' });
    });

    it('returns a failure ToolResult (not a throw) when searchPapers itself throws', async () => {
      mockSearchPapers.mockRejectedValue(new Error('upstream boom'));

      const result = await executeSearchPapers({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'upstream boom' });
    });

    it('falls back to a generic error message when the thrown value is not an Error', async () => {
      mockSearchPapers.mockRejectedValue('weird failure');

      const result = await executeSearchPapers({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'searchPapers failed' });
    });
  });

  // --------------------------------------------------------------------------
  // executeResolveOpenAccess
  // --------------------------------------------------------------------------
  describe('executeResolveOpenAccess', () => {
    it('calls resolveOpenAccess with the DOI and wraps success', async () => {
      const oa = { isOA: true, pdfUrl: 'https://pdf', hostType: 'repository', version: 'publishedVersion' };
      mockResolveOpenAccess.mockResolvedValue({ data: oa });

      const result = await executeResolveOpenAccess({ doi: '10.1234/abc' });

      expect(mockResolveOpenAccess).toHaveBeenCalledWith({ doi: '10.1234/abc' });
      expect(result).toEqual({ success: true, data: oa });
    });

    it('returns a failure ToolResult when resolveOpenAccess resolves with an upstream error (not a throw)', async () => {
      const nonOaDefault = { isOA: false, pdfUrl: null, hostType: null, version: null };
      mockResolveOpenAccess.mockResolvedValue({ data: nonOaDefault, error: 'Upstream request failed (404): x' });

      const result = await executeResolveOpenAccess({ doi: '10.1234/abc' });

      expect(result).toEqual({ success: false, error: 'Upstream request failed (404): x' });
    });

    it('returns a failure ToolResult when resolveOpenAccess itself throws', async () => {
      mockResolveOpenAccess.mockRejectedValue(new Error('unpaywall down'));

      const result = await executeResolveOpenAccess({ doi: '10.1234/abc' });

      expect(result).toEqual({ success: false, error: 'unpaywall down' });
    });
  });

  // --------------------------------------------------------------------------
  // executeSearchHackerNews
  // --------------------------------------------------------------------------
  describe('executeSearchHackerNews', () => {
    it('calls searchHackerNews with mapped args and wraps success', async () => {
      const hits = [
        {
          title: 'Show HN: Thing',
          url: 'https://hn/1',
          points: 42,
          numComments: 7,
          author: 'op',
          createdAt: '2026-01-01T00:00:00Z',
          objectID: '1',
        },
      ];
      mockSearchHackerNews.mockResolvedValue({ data: hits });

      const result = await executeSearchHackerNews({ query: 'vector db', limit: 3, tags: 'show_hn' });

      expect(mockSearchHackerNews).toHaveBeenCalledWith({ query: 'vector db', limit: 3, tags: 'show_hn' });
      expect(result).toEqual({ success: true, data: { count: 1, hits } });
    });

    it('returns a failure ToolResult when searchHackerNews resolves with an upstream error (not a throw)', async () => {
      mockSearchHackerNews.mockResolvedValue({ data: [], error: 'Upstream request failed (503): x' });

      const result = await executeSearchHackerNews({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'Upstream request failed (503): x' });
    });

    it('returns a failure ToolResult when searchHackerNews itself throws', async () => {
      mockSearchHackerNews.mockRejectedValue(new Error('hn down'));

      const result = await executeSearchHackerNews({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'hn down' });
    });
  });

  // --------------------------------------------------------------------------
  // executeSearchSecFilings
  // --------------------------------------------------------------------------
  describe('executeSearchSecFilings', () => {
    it('calls searchSecFilings with mapped args and wraps success', async () => {
      const filings = [
        {
          company: 'C3.ai, Inc.',
          cik: '1577526',
          formType: '10-K',
          filedAt: '2026-06-23',
          url: 'https://www.sec.gov/Archives/edgar/data/1577526/x/x-index.htm',
          snippet: null,
        },
      ];
      mockSearchSecFilings.mockResolvedValue({ data: filings });

      const result = await executeSearchSecFilings({ query: 'C3.ai', formTypes: ['10-K'], limit: 5 });

      expect(mockSearchSecFilings).toHaveBeenCalledWith({ query: 'C3.ai', formTypes: ['10-K'], limit: 5 });
      expect(result).toEqual({ success: true, data: { count: 1, filings } });
    });

    it('returns a failure ToolResult when searchSecFilings resolves with an upstream error (not a throw) — this is the SEC-403-looks-like-no-filings bug fix', async () => {
      mockSearchSecFilings.mockResolvedValue({ data: [], error: 'Upstream request failed (403): x' });

      const result = await executeSearchSecFilings({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'Upstream request failed (403): x' });
    });

    it('returns a failure ToolResult when searchSecFilings itself throws', async () => {
      mockSearchSecFilings.mockRejectedValue(new Error('sec down'));

      const result = await executeSearchSecFilings({ query: 'x' });

      expect(result).toEqual({ success: false, error: 'sec down' });
    });
  });

  // --------------------------------------------------------------------------
  // executeSearchOssHealth
  // --------------------------------------------------------------------------
  describe('executeSearchOssHealth', () => {
    it('calls searchOssHealth with mapped args and wraps success', async () => {
      const health = {
        name: 'facebook/react',
        stars: 200000,
        contributors: 1000,
        lastCommit: '2026-07-01T00:00:00Z',
        downloads: null,
        dependentsCount: null,
        advisories: null,
        maintenanceScore: null,
        attribution: 'Data: Ecosyste.ms (CC-BY-SA 4.0)',
      };
      mockSearchOssHealth.mockResolvedValue({ data: health });

      const result = await executeSearchOssHealth({ repoOrPackage: 'facebook/react' });

      expect(mockSearchOssHealth).toHaveBeenCalledWith({ repoOrPackage: 'facebook/react' });
      expect(result).toEqual({ success: true, data: health });
    });

    it('returns a failure ToolResult when searchOssHealth resolves with an upstream error (not a throw)', async () => {
      const emptyHealth = {
        name: 'facebook/react',
        stars: null,
        contributors: null,
        lastCommit: null,
        downloads: null,
        dependentsCount: null,
        advisories: null,
        maintenanceScore: null,
        attribution: 'Data: Ecosyste.ms (CC-BY-SA 4.0)',
      };
      mockSearchOssHealth.mockResolvedValue({ data: emptyHealth, error: 'Upstream request failed (404): x' });

      const result = await executeSearchOssHealth({ repoOrPackage: 'facebook/react' });

      expect(result).toEqual({ success: false, error: 'Upstream request failed (404): x' });
    });

    it('returns a failure ToolResult when searchOssHealth itself throws', async () => {
      mockSearchOssHealth.mockRejectedValue(new Error('ecosyste.ms down'));

      const result = await executeSearchOssHealth({ repoOrPackage: 'facebook/react' });

      expect(result).toEqual({ success: false, error: 'ecosyste.ms down' });
    });
  });
});

// ============================================================================
// CORE_AI_TOOLS registration
// ============================================================================

describe('CORE_AI_TOOLS registration', () => {
  // `@/lib/ai/tools` (tools.ts) pulls in the full admin-SDK tool surface.
  // Mock the Firebase/Firestore chain exactly like
  // `src/lib/mcp/__tests__/tool-permission-coverage.test.ts` so the import
  // doesn't attempt a real Firebase init.
  beforeAll(() => {
    jest.doMock('@/lib/firebase', () => ({ db: {}, auth: {} }));
    jest.doMock('@/lib/entity-factory', () => ({ createEntity: jest.fn() }));
    jest.doMock('firebase/firestore', () => ({
      getFirestore: jest.fn(),
      collection: jest.fn(),
      doc: jest.fn(),
      getDoc: jest.fn(),
      getDocs: jest.fn(),
      setDoc: jest.fn(),
      updateDoc: jest.fn(),
      deleteDoc: jest.fn(),
      query: jest.fn(),
      where: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      Timestamp: { now: jest.fn(() => ({ toDate: () => new Date() })) },
    }));
    jest.doMock('firebase/auth', () => ({ getAuth: jest.fn() }));
  });

  it('includes all six primary-source research tool names', () => {
    // Import lazily (after the mocks above are registered) and isolated from
    // the module registry used by the describe block above.
    let CORE_AI_TOOLS: { name: string }[];
    jest.isolateModules(() => {
      CORE_AI_TOOLS = require('@/lib/ai/tools').CORE_AI_TOOLS;
    });

    const names = CORE_AI_TOOLS!.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'searchPapers',
        'resolveOpenAccess',
        'searchHackerNews',
        'searchSecFilings',
        'searchOssHealth',
        'searchPatents',
      ])
    );
  });
});
