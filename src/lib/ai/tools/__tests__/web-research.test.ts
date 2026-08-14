/**
 * @jest-environment node
 */

// ============================================================================
// Mocks
// ============================================================================

const mockGenerateContent = jest.fn();
// executeWebSearch switched to the grounded variant (Phase 2.1 Part D) so it can
// return the REAL sources Gemini grounded on; the other research helpers still use
// plain generateContent. Both must be mocked or the module import throws.
const mockGenerateGroundedContent = jest.fn();
// AI-028 — comprehensive company research now goes through the structured
// client with a bounded Zod schema instead of prose + regex scanning.
const mockGenerateStructuredContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateContent: (...args: unknown[]) => mockGenerateContent(...args),
  generateGroundedContent: (...args: unknown[]) => mockGenerateGroundedContent(...args),
  generateStructuredContent: (...args: unknown[]) => mockGenerateStructuredContent(...args),
}));

// AI-036 — the bulk-research executor runs SERVER-side. Every read it performs
// must go through the Admin SDK boundary (`@/lib/companies-admin`), never the
// Firebase Web SDK. These throwing sentinels are the Node module-graph
// assertion: the whole suite fails the instant anything reachable from
// `executeBulkResearchCompanies` loads the client runtime (`@/lib/firebase`,
// `firebase/firestore`) or the client companies service (`@/lib/companies`).
jest.mock('@/lib/firebase', () => {
  throw new Error('web-research must not import the Firebase client runtime (@/lib/firebase)');
});
jest.mock('firebase/firestore', () => {
  throw new Error('web-research must not import firebase/firestore');
});
jest.mock('@/lib/companies', () => {
  throw new Error('web-research must not import the client companies service (@/lib/companies)');
});

const mockAdminGetCompanies = jest.fn().mockResolvedValue([]);
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: (...args: unknown[]) => mockAdminGetCompanies(...args),
}));

const mockExecuteCreateCompanyWithResearch = jest.fn();
jest.mock('../entity-creation', () => ({
  __esModule: true,
  executeCreateCompanyWithResearch: (...args: unknown[]) => mockExecuteCreateCompanyWithResearch(...args),
}));

// ============================================================================
// Imports
// ============================================================================

import {
  WEB_RESEARCH_TOOLS,
  executeWebSearch,
  executeWebScrape,
  executeCompanyResearch,
  executeTechnologyResearch,
  executeComprehensiveCompanyResearch,
  executeBulkResearchCompanies,
} from '../web-research';

// ============================================================================
// Tests
// ============================================================================

describe('Web Research Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('tool definitions', () => {
    it('describes comprehensive company research as a non-persisting draft', () => {
      const tool = WEB_RESEARCH_TOOLS.find((candidate) => candidate.name === 'researchCompanyComprehensive');

      expect(tool?.description).toContain('unverified AI research draft');
      expect(tool?.description).toContain('does not create or update');
      expect(tool?.description).toMatch(/source review/i);
      expect(tool?.description).toContain('call createCompany with only user-approved fields');
      expect(tool?.description).not.toContain('call createCompanyWithResearch');
      expect(tool?.description).not.toContain('fills ALL company tabs');
    });

    it('describes bulk research as an explicit create with no generated side entities', () => {
      const tool = WEB_RESEARCH_TOOLS.find((candidate) => candidate.name === 'bulkResearchCompanies');

      expect(tool?.description).toMatch(/only when the user explicitly asks to create or add/i);
      expect(tool?.description).toContain('receipt-backed profile facts');
      expect(tool?.description).toContain('unverified draft provenance');
      expect(tool?.description).toContain(
        'does not create contacts, SWOT, competitor entities, or competitor relations'
      );
      expect(tool?.description).not.toContain('Each gets full profile: overview, contacts, competitors, SWOT');
      expect(tool?.description).not.toContain('Competitive relationships are auto-created');
    });
  });

  // --------------------------------------------------------------------------
  // executeWebSearch
  // --------------------------------------------------------------------------
  describe('executeWebSearch', () => {
    it('should return search results on success', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'AI is transforming industries. Key developments include LLMs and multimodal models.',
        citations: [],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.success).toBe(true);
      expect(result.data?.summary).toContain('AI is transforming');
      // No grounded citations → falls back to the single generic search-link result.
      expect(result.data?.results).toHaveLength(1);
      expect(result.data?.results[0].url).toContain('google.com/search');
      expect(mockGenerateGroundedContent).toHaveBeenCalledWith(
        expect.stringContaining('AI trends 2025'),
        expect.objectContaining({ model: 'gemini-3.5-flash' })
      );
    });

    it('should surface the real grounded sources when Gemini returns citations', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary grounded on real sources.',
        citations: [{ uri: 'https://example.com/a', title: 'Source A' }],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(1);
      expect(result.data?.results[0].url).toBe('https://example.com/a');
      expect(result.data?.results[0].title).toBe('Source A');
      expect(result.data?.citations).toHaveLength(1);
    });

    // AI-048 — the model must cite publishers, not opaque Google redirects.
    // `generateGroundedContent` resolves identities upstream; webSearch's job is
    // to PREFER the resolved identity in what it hands the model and the UI.
    it('hands the model the resolved publisher URL, not the grounding redirect', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary.',
        citations: [
          {
            uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ',
            identityUri: 'https://publisher.com/article',
            title: 'Real Article',
          },
        ],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.results[0].url).toBe('https://publisher.com/article');
      expect(result.data?.results[0].title).toBe('Real Article');
    });

    it('titles a title-less citation with the publisher URL, never the redirect', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary.',
        citations: [
          {
            uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ',
            identityUri: 'https://publisher.com/article',
          },
        ],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.results[0].title).toBe('https://publisher.com/article');
      expect(result.data?.results[0].title).not.toContain('vertexaisearch');
    });

    it('falls back to the raw uri when identity resolution did not succeed', async () => {
      const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ';
      mockGenerateGroundedContent.mockResolvedValue({ text: 'Summary.', citations: [{ uri: redirect }] });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.results[0].url).toBe(redirect);
    });

    // AI-048 part 2 — snippet was hardcoded '' on every grounded result because
    // groundingSupports was never read. It is what makes a stored EvidenceRef
    // claim-level rather than "this page was consulted".
    it('carries the supported answer segments into the result snippet', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary.',
        citations: [
          {
            uri: 'https://publisher.com/article',
            supportedSegments: ['Revenue grew 40% in 2026.', 'Headcount doubled.'],
          },
        ],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.results[0].snippet).toContain('Revenue grew 40% in 2026.');
      expect(result.data?.results[0].snippet).toContain('Headcount doubled.');
    });

    it('leaves the snippet empty when the provider sent no supporting segments', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary.',
        citations: [{ uri: 'https://publisher.com/article' }],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.results[0].snippet).toBe('');
    });

    it('passes resolved citations through so the UI renders publisher identities', async () => {
      mockGenerateGroundedContent.mockResolvedValue({
        text: 'Summary.',
        citations: [
          {
            uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ',
            identityUri: 'https://publisher.com/article',
          },
        ],
      });

      const result = await executeWebSearch('AI trends 2025');

      expect(result.data?.citations?.[0].identityUri).toBe('https://publisher.com/article');
    });

    it('should use the provided limit', async () => {
      mockGenerateGroundedContent.mockResolvedValue({ text: 'Results summary', citations: [] });

      await executeWebSearch('test query', 10);

      expect(mockGenerateGroundedContent).toHaveBeenCalledWith(expect.stringContaining('top 10'), expect.any(Object));
    });

    it('should return fallback on AI client error', async () => {
      mockGenerateGroundedContent.mockRejectedValue(new Error('API quota exceeded'));

      const result = await executeWebSearch('failing query');

      expect(result.success).toBe(true);
      expect(result.data?.searchFailed).toBe(true);
      expect(result.data?.summary).toContain('API quota exceeded');
      expect(result.data?.results).toEqual([]);
    });

    it('should handle non-Error exceptions in fallback', async () => {
      mockGenerateGroundedContent.mockRejectedValue('unknown failure');

      const result = await executeWebSearch('query');

      expect(result.success).toBe(true);
      expect(result.data?.searchFailed).toBe(true);
      expect(result.data?.summary).toContain('Search failed');
    });
  });

  // --------------------------------------------------------------------------
  // executeWebScrape
  // --------------------------------------------------------------------------
  describe('executeWebScrape', () => {
    it('should research a URL and return content', async () => {
      mockGenerateContent.mockResolvedValue('Detailed article about React hooks usage patterns.');

      const result = await executeWebScrape('https://example.com/article');

      expect(result.success).toBe(true);
      expect(result.data?.url).toBe('https://example.com/article');
      expect(result.data?.content).toContain('React hooks');
    });

    it('should include extract fields in prompt when provided', async () => {
      mockGenerateContent.mockResolvedValue('Pricing: $99/mo. Features: A, B, C.');

      const result = await executeWebScrape('https://example.com/pricing', ['pricing', 'features']);

      expect(result.success).toBe(true);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('pricing, features'),
        expect.any(Object)
      );
    });

    it('should use comprehensive summary when no fields specified', async () => {
      mockGenerateContent.mockResolvedValue('General summary');

      await executeWebScrape('topic name');

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('comprehensive summary'),
        expect.any(Object)
      );
    });

    it('should handle AI client errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Model overloaded'));

      const result = await executeWebScrape('https://example.com');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model overloaded');
    });
  });

  // --------------------------------------------------------------------------
  // executeCompanyResearch
  // --------------------------------------------------------------------------
  describe('executeCompanyResearch', () => {
    it('should research a company by name', async () => {
      mockGenerateContent.mockResolvedValue('Anthropic is an AI safety company founded by ex-OpenAI researchers.');

      const result = await executeCompanyResearch('Anthropic');

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Anthropic');
      expect(result.data?.description).toContain('AI safety');
      expect(result.data?.sources).toContain('Google Search via Gemini');
    });

    it('should include focus areas in prompt', async () => {
      mockGenerateContent.mockResolvedValue('Funding info here');

      await executeCompanyResearch('Acme', ['funding', 'products']);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('funding, products'),
        expect.any(Object)
      );
    });

    it('should handle AI client errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Timeout'));

      const result = await executeCompanyResearch('Unknown');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timeout');
    });
  });

  // --------------------------------------------------------------------------
  // executeTechnologyResearch
  // --------------------------------------------------------------------------
  describe('executeTechnologyResearch', () => {
    it('should research a technology and determine maturity', async () => {
      mockGenerateContent.mockResolvedValue(
        'React is a mature, widely adopted UI library by Meta. It has a large ecosystem.'
      );

      const result = await executeTechnologyResearch('React');

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('React');
      expect(result.data?.maturityLevel).toBe('mature');
      expect(result.data?.sources).toContain('Google Search via Gemini');
    });

    it('should detect emerging technologies', async () => {
      mockGenerateContent.mockResolvedValue('This is an emerging technology still in early stage development.');

      const result = await executeTechnologyResearch('QuantumML');

      expect(result.data?.maturityLevel).toBe('emerging');
    });

    it('should detect declining technologies', async () => {
      mockGenerateContent.mockResolvedValue(
        'This legacy framework is declining and being replaced by modern alternatives.'
      );

      const result = await executeTechnologyResearch('OldFramework');

      expect(result.data?.maturityLevel).toBe('declining');
    });

    it('should default to growing maturity', async () => {
      mockGenerateContent.mockResolvedValue('A popular framework gaining traction across enterprises.');

      const result = await executeTechnologyResearch('SvelteKit');

      expect(result.data?.maturityLevel).toBe('growing');
    });

    it('should include research aspects in prompt', async () => {
      mockGenerateContent.mockResolvedValue('Performance data');

      await executeTechnologyResearch('Vue.js', ['adoption', 'alternatives']);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.stringContaining('adoption, alternatives'),
        expect.any(Object)
      );
    });

    it('should handle errors gracefully', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Rate limited'));

      const result = await executeTechnologyResearch('Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limited');
    });
  });

  // --------------------------------------------------------------------------
  // executeComprehensiveCompanyResearch
  // --------------------------------------------------------------------------
  describe('executeComprehensiveCompanyResearch (AI-028)', () => {
    const SOURCE = { url: 'https://reuters.com/acme', publisher: 'Reuters' };

    /** Mock the structured client with a payload the real schema will accept. */
    function mockResearch(payload: Record<string, unknown>): void {
      mockGenerateStructuredContent.mockImplementation(
        async (_prompt: string, schema: { parse: (input: unknown) => unknown }) =>
          schema.parse({ name: 'Acme Corp', ...payload })
      );
    }

    it('goes through the structured client, not free-text prose', async () => {
      mockResearch({});

      await executeComprehensiveCompanyResearch('Acme Corp');

      expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('persists sourced facts on the real domain enums', async () => {
      mockResearch({
        size: { value: 'medium', sources: [SOURCE] },
        stage: { value: 'series_b', sources: [SOURCE] },
        city: { value: 'Barcelona', sources: [SOURCE] },
        country: { value: 'Spain', sources: [SOURCE] },
        industries: { value: ['technology'], sources: [SOURCE] },
      });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.size).toBe('medium');
      expect(data.stage).toBe('series_b');
      expect(data.location?.city).toBe('Barcelona');
      expect(data.industry).toEqual(['technology']);
      expect(data.receipts.size?.[0].url).toBe('https://reuters.com/acme');
    });

    it('leaves an unsourced fact unset and names it as unknown', async () => {
      mockResearch({ size: { value: 'enterprise', sources: [] } });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.size).toBeUndefined();
      expect(data.unknowns).toContain('size');
    });

    // The regression this item exists for: the old parser set size from the word
    // "global", stage from "public", country from a bare country name, and the
    // tech stack from a case-sensitive substring list.
    it('does not infer size, stage, country or products from incidental words', async () => {
      mockResearch({
        description: {
          value:
            'A global multinational enterprise operating at large scale in Spain, with public cloud ' +
            'seed projects written in Go, discussed widely on NASDAQ forums.',
          sources: [SOURCE],
        },
      });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.size).toBeUndefined();
      expect(data.stage).toBeUndefined();
      expect(data.location).toBeUndefined();
      expect(data.technologyStack).toEqual([]);
    });

    it('never fabricates a default industry', async () => {
      mockResearch({});

      const data = (await executeComprehensiveCompanyResearch('VagueCo')).data!;

      expect(data.industry).toEqual([]);
      expect(data.unknowns).toContain('industries');
    });

    it('withholds a contradicted field and reports the contradiction', async () => {
      mockResearch({
        stage: { value: 'public', sources: [SOURCE] },
        contradictions: [{ field: 'stage', values: ['public', 'private'], sources: [SOURCE] }],
      });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.stage).toBeUndefined();
      expect(data.contradictions[0].field).toBe('stage');
    });

    it('keeps an unsupported vendor capability unknown', async () => {
      mockResearch({
        vendorCapabilities: [
          { name: 'FedRAMP', status: 'available', sources: [] },
          { name: 'SSO', status: 'available', sources: [SOURCE] },
        ],
      });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.vendorCapabilities).toEqual([
        { name: 'FedRAMP', status: 'unknown' },
        { name: 'SSO', status: 'available' },
      ]);
    });

    it('names the missing benchmark, pricing, SLA, security and trial evidence', async () => {
      mockResearch({ evidenceByCategory: { pricing: [SOURCE] } });

      const data = (await executeComprehensiveCompanyResearch('Acme Corp')).data!;

      expect(data.missingEvidence).toEqual(['benchmark', 'sla', 'security', 'trial']);
      expect(data.sourcingComplete).toBe(false);
      expect(data.citationsVerified).toBe(false);
    });

    it('should handle AI client errors', async () => {
      mockGenerateStructuredContent.mockRejectedValue(new Error('Service unavailable'));

      const result = await executeComprehensiveCompanyResearch('Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Service unavailable');
    });
  });

  // --------------------------------------------------------------------------
  // executeBulkResearchCompanies
  // --------------------------------------------------------------------------
  describe('executeBulkResearchCompanies', () => {
    it('should skip existing companies', async () => {
      mockAdminGetCompanies.mockResolvedValue([{ id: 'existing-1', name: 'Already Exists' }]);

      const result = await executeBulkResearchCompanies([{ name: 'Already Exists' }]);

      expect(result.success).toBe(true);
      expect(result.data?.skipped).toHaveLength(1);
      expect(result.data?.skipped[0].reason).toContain('already exists');
    });

    it('should research and create new companies', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockImplementation(
        async (_p: string, schema: { parse: (input: unknown) => unknown }) => schema.parse({ name: 'New Company' })
      );
      mockExecuteCreateCompanyWithResearch.mockResolvedValue({
        success: true,
        data: { id: 'new-1', contactsCreated: 2, competitorsAdded: 3, swotPopulated: true },
      });

      const result = await executeBulkResearchCompanies([{ name: 'New Company', website: 'https://newco.com' }]);

      expect(result.success).toBe(true);
      expect(result.data?.successful).toHaveLength(1);
      expect(result.data?.successful[0].companyId).toBe('new-1');
    });

    it('should handle research failures per company', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockRejectedValue(new Error('API error'));

      const result = await executeBulkResearchCompanies([{ name: 'FailCo' }]);

      expect(result.success).toBe(true);
      expect(result.data?.failed).toHaveLength(1);
      expect(result.data?.failed[0].error).toContain('API error');
    });

    it('should handle creation failures after successful research', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockImplementation(
        async (_p: string, schema: { parse: (input: unknown) => unknown }) => schema.parse({ name: 'DupeCo' })
      );
      mockExecuteCreateCompanyWithResearch.mockResolvedValue({
        success: false,
        error: 'Duplicate slug',
      });

      const result = await executeBulkResearchCompanies([{ name: 'DupeCo' }]);

      expect(result.success).toBe(true);
      expect(result.data?.failed).toHaveLength(1);
      expect(result.data?.failed[0].error).toBe('Duplicate slug');
    });

    it('should handle top-level errors', async () => {
      mockAdminGetCompanies.mockRejectedValue(new Error('Firestore down'));

      const result = await executeBulkResearchCompanies([{ name: 'Test' }]);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore down');
    });

    // AI-036 — the executor reads existing companies through the Admin SDK
    // boundary. This proves the read is delegated there (and, together with the
    // throwing `@/lib/companies` sentinel above, that the client service is never
    // reached) rather than through the Firebase Web SDK.
    it('reads existing companies through the Admin SDK boundary', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockImplementation(
        async (_p: string, schema: { parse: (input: unknown) => unknown }) => schema.parse({ name: 'Fresh Co' })
      );
      mockExecuteCreateCompanyWithResearch.mockResolvedValue({ success: true, data: { id: 'fresh-1' } });

      await executeBulkResearchCompanies([{ name: 'Fresh Co' }]);

      expect(mockAdminGetCompanies).toHaveBeenCalledTimes(1);
    });

    it('returns created, skipped and failed together without cross-contamination', async () => {
      mockAdminGetCompanies.mockResolvedValue([{ id: 'existing-1', name: 'Existing Co' }]);
      mockGenerateStructuredContent.mockImplementation(
        async (prompt: string, schema: { parse: (input: unknown) => unknown }) => {
          if (prompt.includes('ResearchFail')) throw new Error('research boom');
          if (prompt.includes('CreateFail')) return schema.parse({ name: 'CreateFail' });
          return schema.parse({ name: 'NewCo' });
        }
      );
      mockExecuteCreateCompanyWithResearch.mockImplementation(async (data: { name: string }) => {
        if (data.name === 'CreateFail') return { success: false, error: 'Duplicate slug' };
        return { success: true, data: { id: 'new-1' } };
      });

      const result = await executeBulkResearchCompanies([
        { name: 'Existing Co' },
        { name: 'NewCo' },
        { name: 'ResearchFail' },
        { name: 'CreateFail' },
      ]);

      expect(result.success).toBe(true);
      // One failed company never erases the successful or skipped results.
      expect(result.data?.skipped.map((s) => s.name)).toEqual(['Existing Co']);
      expect(result.data?.skipped[0].existingId).toBe('existing-1');
      expect(result.data?.successful.map((s) => s.name)).toEqual(['NewCo']);
      expect(result.data?.failed.map((f) => f.name).sort()).toEqual(['CreateFail', 'ResearchFail']);
    });

    // AI-036 — two inputs that normalize to the same name in ONE request must
    // not each be researched-and-created in parallel; that parallel race is
    // exactly how a duplicate Company (and its side entities) could slip past the
    // factory's uniqueness check. The batch collapses them to a single create.
    it('collapses duplicate-looking inputs in the same request to a single create', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockImplementation(
        async (_p: string, schema: { parse: (input: unknown) => unknown }) => schema.parse({ name: 'DSM Firmenich' })
      );
      mockExecuteCreateCompanyWithResearch.mockResolvedValue({ success: true, data: { id: 'dsm-1' } });

      const result = await executeBulkResearchCompanies([{ name: 'DSM Firmenich' }, { name: 'DSM-Firmenich' }]);

      expect(result.success).toBe(true);
      expect(result.data?.successful).toHaveLength(1);
      // Exactly one research call and one create call for the collapsed pair.
      expect(mockExecuteCreateCompanyWithResearch).toHaveBeenCalledTimes(1);
      // The collapsed duplicate is reported honestly, never silently dropped and
      // never turned into a second Company.
      const reported = [
        ...result.data!.successful.map((s) => s.name),
        ...result.data!.skipped.map((s) => s.name),
        ...result.data!.failed.map((f) => f.name),
      ];
      expect(reported).toContain('DSM-Firmenich');
    });

    // A retry of the same batch must not create duplicate Company/contact/relation
    // side entities: the already-created company now comes back from the Admin
    // read and is skipped, and this flow materializes no contacts/competitors.
    it('is retry-safe: an already-created company is skipped, not re-created', async () => {
      mockAdminGetCompanies.mockResolvedValue([{ id: 'dsm-1', name: 'DSM Firmenich' }]);

      const result = await executeBulkResearchCompanies([{ name: 'DSM-Firmenich' }]);

      expect(result.success).toBe(true);
      expect(result.data?.skipped).toHaveLength(1);
      expect(result.data?.skipped[0].existingId).toBe('dsm-1');
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
      expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
    });

    it('returns a clean empty result for empty input', async () => {
      mockAdminGetCompanies.mockResolvedValue([]);

      const result = await executeBulkResearchCompanies([]);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ successful: [], failed: [], skipped: [] });
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // executeBulkResearchCompanies — AI-036 Unicode normalization + validation
  // --------------------------------------------------------------------------
  describe('executeBulkResearchCompanies — Unicode + validation (AI-036)', () => {
    const succeedResearch = () => {
      mockAdminGetCompanies.mockResolvedValue([]);
      mockGenerateStructuredContent.mockImplementation(
        async (_p: string, schema: { parse: (input: unknown) => unknown }) => schema.parse({ name: 'x' })
      );
      mockExecuteCreateCompanyWithResearch.mockResolvedValue({ success: true, data: { id: 'id' } });
    };

    it('keeps distinct non-Latin names distinct instead of collapsing to an empty duplicate key', async () => {
      succeedResearch();
      const result = await executeBulkResearchCompanies([{ name: '日本電気' }, { name: '任天堂' }]);
      expect(result.data?.successful).toHaveLength(2);
      expect(mockExecuteCreateCompanyWithResearch).toHaveBeenCalledTimes(2);
    });

    it('collapses the same name across width/spacing (NFKC) to one create', async () => {
      succeedResearch();
      // 'DSM Firmenich' vs fullwidth 'ＤＳＭ　Ｆｉｒｍｅｎｉｃｈ' normalize (NFKC) to the same key.
      const result = await executeBulkResearchCompanies([
        { name: 'DSM Firmenich' },
        { name: 'ＤＳＭ　Ｆｉｒｍｅｎｉｃｈ' },
      ]);
      expect(mockExecuteCreateCompanyWithResearch).toHaveBeenCalledTimes(1);
      expect(result.data?.successful).toHaveLength(1);
    });

    it('fails an empty or symbol-only name and never researches it', async () => {
      succeedResearch();
      const result = await executeBulkResearchCompanies([{ name: '   ' }, { name: '!!!' }]);
      expect(result.data?.failed).toHaveLength(2);
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
    });

    it('reports the overflow beyond the batch cap as failed', async () => {
      succeedResearch();
      const many = Array.from({ length: 55 }, (_, i) => ({ name: `Company ${i}` }));
      const result = await executeBulkResearchCompanies(many);
      expect(result.data!.failed.filter((f) => /exceeds the maximum/.test(f.error))).toHaveLength(5);
    });

    it('drops an unsafe website but still researches the company', async () => {
      succeedResearch();
      const result = await executeBulkResearchCompanies([{ name: 'Acme', website: 'javascript:alert(1)' }]);
      expect(result.data?.successful).toHaveLength(1);
    });
  });
});
