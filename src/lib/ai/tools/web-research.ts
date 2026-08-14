/**
 * @file ai/tools/web-research.ts
 * @description Web research tools for AI Assistant using Gemini with Google Search
 *
 * Provides capabilities for:
 * - Web searching using Google Search grounding
 * - Company research
 * - Technology research
 *
 * Uses Gemini's built-in Google Search grounding feature for web searches,
 * which provides access to current web information.
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  generateContent,
  generateGroundedContent,
  generateStructuredContent,
  type GroundingCitation,
  type GeminiModel,
} from '@/lib/ai/client';
import {
  COMPANY_INDUSTRY_VALUES,
  COMPANY_SIZE_VALUES,
  COMPANY_STAGE_VALUES,
  comprehensiveCompanyResearchSchema,
  toPersistableCompanyFacts,
  type CompanyEvidenceCategory,
  type CompanyResearchSource,
} from '@/lib/ai/company-research-contract';
import { geminiTextModel } from '@/lib/ai/model-config';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';
import { createLogger } from '@/lib/logger';
import type { CompanyIndustry, CompanySize, CompanyStage } from '@/lib/types';

const log = createLogger('ai/web-research');

// ============================================================================
// Tool Definitions for Web Research
// ============================================================================

export const WEB_RESEARCH_TOOLS: FunctionDeclaration[] = [
  {
    name: 'webSearch',
    description: `Search the web for current information about any topic. Uses Google Search for real-time results.

WHEN TO USE THIS TOOL:
- "Search for information about [company/technology/topic]"
- "What's the latest news about [topic]?"
- "Find articles about [subject]"
- "Look up [company name] recent funding"

GREAT FOR:
- Company news and announcements
- Technology trends and comparisons
- Market research and analysis
- Finding recent events and updates
- Discovering startups in a space

EXAMPLE QUERIES:
- "Anthropic AI company funding 2025"
- "React vs Vue performance comparison"
- "quantum computing startups Series A"
- "LLM fine-tuning best practices"
- "enterprise AI adoption trends"

TIP: Be specific in your query for better results. Include dates or year for recent information.

RETURNS: Summary of top search results with titles, URLs, and key points.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Search query (e.g., 'Anthropic AI company funding', 'React vs Vue 2024', 'quantum computing startups')",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of results to summarize (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'webScrape',
    description: `Extract detailed information from a specific URL or deeply research a topic.

WHEN TO USE THIS TOOL:
- "Get details from this URL: [url]"
- "Scrape information from [website]"
- "Extract data from this page"
- "Research [specific topic] in depth"

TWO MODES:
1. URL Mode: Provide a URL to extract content from that specific page
2. Topic Mode: Provide a topic name to research it comprehensively

EXTRACT FIELDS (optional):
Specify what data you want to extract:
- ['company_name', 'description', 'funding']
- ['features', 'pricing', 'competitors']
- ['team', 'investors', 'products']

EXAMPLES:
- webScrape(url: "https://techcrunch.com/article-about-startup")
- webScrape(url: "OpenAI GPT-4 capabilities", extractFields: ["features", "limitations", "use_cases"])
- webScrape(url: "https://company.com/about", extractFields: ["description", "team", "mission"])

RETURNS: Synthesized content from the source(s) with extracted fields if specified.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: {
          type: SchemaType.STRING,
          description: "URL or topic to research (e.g., 'https://example.com/article' or 'OpenAI GPT-4 capabilities')",
        },
        extractFields: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Specific fields to extract (e.g., ['company_name', 'funding', 'description']). If not specified, returns general summary.",
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'researchCompanyByName',
    description:
      'Quick company research by name using Google Search. Returns company overview, funding, key people, and recent news. Use this when you only have a company name (not an ID).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyName: {
          type: SchemaType.STRING,
          description: 'Name of the company to research',
        },
        focusAreas: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Specific areas to focus on (e.g., ['funding', 'products', 'competitors', 'news'])",
        },
      },
      required: ['companyName'],
    },
  },
  {
    name: 'researchTechnology',
    description:
      'Research a technology, framework, or tool using Google Search. Returns maturity assessment, adoption trends, key players, and use cases.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyName: {
          type: SchemaType.STRING,
          description: "Name of the technology to research (e.g., 'React', 'Kubernetes', 'Large Language Models')",
        },
        aspectsToResearch: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Specific aspects to research (e.g., ['adoption', 'alternatives', 'use_cases', 'trends'])",
        },
      },
      required: ['technologyName'],
    },
  },
  {
    name: 'researchCompanyComprehensive',
    description: `Research a company and return an unverified AI research draft with offered source references. This tool is read-only: it does not create or update any company record. Source review is required before using the draft for a later write.

WHEN TO USE THIS TOOL:
- "Research [company name] thoroughly"
- "Get full details on [company] before adding them"
- "Do comprehensive research on [startup name]"
- Prepare a draft for a later, separately requested company creation

WHAT IT RESEARCHES:
1. OVERVIEW: Description, website, industry, size, location, founding date
2. SOCIAL LINKS: LinkedIn, Twitter, GitHub profiles
3. TECH STACK: Technologies they use or provide
4. KEY CONTACTS: Executives, founders, leadership team
5. COMPETITORS: Similar companies in the space
6. SWOT ANALYSIS: Strengths, Weaknesses, Opportunities, Threats

RECOMMENDED WORKFLOW:
1. Call researchCompanyComprehensive(companyName: "Acme Corp")
2. Review the returned draft and its offered source references with the user
3. Only after an explicit create request, call createCompany with only user-approved fields

TIP: If you know the company website, provide it for more accurate research.

EXAMPLE:
researchCompanyComprehensive(companyName: "Anthropic", website: "https://anthropic.com")

RETURNS: A structured, unverified draft with researchStatus="draft", sourceReviewRequired=true, and citationsVerified=false. No data is persisted by this tool.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyName: {
          type: SchemaType.STRING,
          description: 'Name of the company to research comprehensively',
        },
        website: {
          type: SchemaType.STRING,
          description: 'Company website if known (helps with more accurate research)',
        },
      },
      required: ['companyName'],
    },
  },
  {
    name: 'bulkResearchCompanies',
    description: `Research and create multiple companies at once (parallel processing for speed). Use only when the user explicitly asks to create or add every named company; never use this write tool for a research-only request.

WHEN TO USE THIS TOOL:
- "Add these 5 AI startups: [list]"
- "Research and add all these companies: [list]"
- "Create profiles for these vendors: [names]"
- "Bulk add these competitors"

WHY USE THIS vs researchCompanyComprehensive:
- PARALLEL: Researches all companies simultaneously (much faster)
- BATCH: Creates all companies in one operation
- EFFICIENT: Single tool call instead of many

EXAMPLE INPUT:
bulkResearchCompanies(companies: [
  { name: "Anthropic", website: "https://anthropic.com" },
  { name: "Cohere", website: "https://cohere.com" },
  { name: "Mistral AI" },
  { name: "Hugging Face" }
])

WHAT HAPPENS:
1. All companies are researched in parallel
2. Each company is created with its user-supplied identity, receipt-backed profile facts, and unverified draft provenance
3. Offered but unverified sources remain explicitly marked for review
4. This tool does not create contacts, SWOT, competitor entities, or competitor relations

RETURNS:
- List of created companies with IDs
- Skipped duplicates and per-company failures
- Legacy side-materialization counters remain zero
- Any errors encountered

MAX RECOMMENDED: 10 companies per call (to avoid timeout)`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companies: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              name: {
                type: SchemaType.STRING,
                description: 'Company name',
              },
              website: {
                type: SchemaType.STRING,
                description: 'Company website (optional, helps with research accuracy)',
              },
            },
            required: ['name'],
          },
          description: 'Array of companies to research and create',
        },
      },
      required: ['companies'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebScrapeResult {
  url: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CompanyResearchResult {
  name: string;
  description: string;
  website?: string;
  industry?: string[];
  founded?: string;
  headquarters?: string;
  employeeCount?: string;
  funding?: {
    total?: string;
    lastRound?: string;
    investors?: string[];
  };
  keyPeople?: Array<{ name: string; title: string }>;
  products?: string[];
  recentNews?: Array<{ title: string; date: string; url: string }>;
  competitors?: string[];
  sources: string[];
}

export interface TechnologyResearchResult {
  name: string;
  description: string;
  category: string;
  maturityLevel: 'emerging' | 'growing' | 'mature' | 'declining';
  adoptionTrend: 'up' | 'stable' | 'down';
  keyPlayers: string[];
  useCases: string[];
  alternatives: string[];
  prosAndCons?: {
    pros: string[];
    cons: string[];
  };
  sources: string[];
}

/**
 * AI-028 — the result of comprehensive company research.
 *
 * Every field that reaches Firestore is a *cleared* fact: schema-valid on the
 * real `CompanySize` / `CompanyStage` / `CompanyIndustry` unions, and backed by
 * at least one structurally valid source in `receipts`. Fields the research
 * could not establish are absent and named in `unknowns` — they are never
 * back-filled from words in the prose.
 */
export interface ComprehensiveCompanyResearchResult {
  name: string;

  // Cleared facts — present only when a receipt exists for them.
  description?: string;
  website?: string;
  industry: CompanyIndustry[];
  size?: CompanySize;
  stage?: CompanyStage;
  location?: {
    city?: string;
    country?: string;
  };
  technologyStack: string[];

  socialLinks: {
    linkedin?: string;
    twitter?: string;
    github?: string;
  };

  contacts: Array<{
    name: string;
    role: string;
    linkedin?: string;
  }>;

  competitors: Array<{ name: string; sources: CompanyResearchSource[] }>;

  swot: {
    strengths: string[];
    weaknesses: string[];
    opportunities: string[];
    threats: string[];
  };

  // Provenance and honest gaps.
  /** Source receipts keyed by the fact they support. */
  receipts: Record<string, CompanyResearchSource[]>;
  /** Fields the research could not establish from a cited source. */
  unknowns: string[];
  /** Fields where cited sources disagree — deliberately left unpersisted. */
  contradictions: Array<{ field: string; values: string[]; sources: CompanyResearchSource[] }>;
  /** Vendor capabilities; `available` requires a source or it is `unknown`. */
  vendorCapabilities: Array<{ name: string; status: 'available' | 'announced' | 'unknown' }>;
  /** Which of benchmark/pricing/SLA/security/trial evidence is absent. */
  missingEvidence: CompanyEvidenceCategory[];
  /** Every evidence category carries at least one OFFERED (unverified) citation. */
  sourcingComplete: boolean;
  /** Always false: receipts are model-offered, never fetched or verified. */
  citationsVerified: false;
}

/**
 * Execute web search using Gemini with Google Search grounding
 * Includes fallback mechanism when search fails
 */
export async function executeWebSearch(
  query: string,
  limit: number = 5
): Promise<{
  success: boolean;
  data?: { results: WebSearchResult[]; summary: string; citations?: GroundingCitation[]; searchFailed?: boolean };
  error?: string;
}> {
  try {
    log.debug('Searching', { query, limit });

    const prompt = `Search the web for: "${query}"

Please provide:
1. A concise summary of the top ${limit} most relevant findings
2. Key facts and data points
3. Any recent developments or news

Format your response as a clear, informative summary. Do not include any markdown formatting like ** or ##.`;

    // Phase 2.1 (Part D) — grounded variant returns the REAL sources Gemini
    // grounded on, instead of discarding them. Citations flow up to the chat
    // response so web answers are verifiable (or honestly "no sources found").
    const { text: response, citations } = await generateGroundedContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    log.debug('Search successful', { query, responseLength: response.length, citations: citations.length });

    return {
      success: true,
      data: {
        // Real grounded sources when present; otherwise the generic search link.
        // AI-048 — prefer the publisher identity `generateGroundedContent`
        // recovered. Google's redirects EXPIRE, so handing the model (or storing)
        // a raw redirect produces citations that rot into dead links, and a
        // title-less citation renders as an opaque `vertexaisearch…` string.
        results:
          citations.length > 0
            ? citations.map((c) => ({
                title: c.title ?? c.identityUri ?? c.uri,
                url: c.identityUri ?? c.uri,
                // AI-048 — the answer segments this source actually supports,
                // from `groundingSupports`. Empty when the provider sent none,
                // which is honest: we then know the page was consulted but not
                // which sentence it backs.
                snippet: (c.supportedSegments ?? []).join(' … '),
              }))
            : [
                {
                  title: `Search results for: ${query}`,
                  url: 'https://google.com/search?q=' + encodeURIComponent(query),
                  snippet: response.substring(0, 300) + '...',
                },
              ],
        citations,
        summary: response,
      },
    };
  } catch (error) {
    log.error('Search failed', error instanceof Error ? error : undefined);
    const errorMessage = error instanceof Error ? error.message : 'Search failed';

    // Provide a fallback response so the AI can still proceed
    // This prevents the AI from being completely blocked when search fails
    log.debug('Returning fallback response due to search failure');
    return {
      success: true, // Mark as success so the AI can continue
      data: {
        results: [],
        summary: `Web search for "${query}" could not be completed due to: ${errorMessage}. You can proceed with the information you already have or ask the user for more details about this topic.`,
        searchFailed: true, // Flag to indicate search didn't succeed
      },
    };
  }
}

/**
 * Execute web research on a topic or URL using Gemini with Google Search
 */
export async function executeWebScrape(
  urlOrTopic: string,
  extractFields?: string[]
): Promise<{ success: boolean; data?: WebScrapeResult; error?: string }> {
  try {
    log.info('Researching', { urlOrTopic });

    const fieldsPrompt = extractFields?.length
      ? `Focus on extracting: ${extractFields.join(', ')}`
      : 'Provide a comprehensive summary';

    const prompt = `Research this topic/URL: "${urlOrTopic}"

${fieldsPrompt}

Provide detailed, factual information. Do not include any markdown formatting like ** or ##.`;

    const response = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
    });

    return {
      success: true,
      data: {
        url: urlOrTopic,
        title: `Research: ${urlOrTopic}`,
        content: response,
      },
    };
  } catch (error) {
    log.error('Research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Research failed',
    };
  }
}

/**
 * Execute comprehensive company research using Gemini with Google Search
 */
export async function executeCompanyResearch(
  companyName: string,
  focusAreas?: string[]
): Promise<{ success: boolean; data?: CompanyResearchResult; error?: string }> {
  try {
    log.info('Researching company', { companyName });

    const areasPrompt = focusAreas?.length ? `Focus on: ${focusAreas.join(', ')}` : 'Cover all key aspects';

    const prompt = `Research the company "${companyName}" comprehensively.

${areasPrompt}

Provide information about:
- Company description and what they do
- Website URL
- Industry/sector
- Founding date and headquarters
- Company size/employee count
- Funding history (total raised, recent rounds, key investors)
- Key executives
- Main products/services
- Recent news and developments
- Main competitors

Be factual and concise. Do not include any markdown formatting like ** or ##.`;

    const response = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
    });

    // Parse the response to extract structured data
    return {
      success: true,
      data: {
        name: companyName,
        description: response,
        sources: ['Google Search via Gemini'],
      },
    };
  } catch (error) {
    log.error('Company research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Company research failed',
    };
  }
}

/**
 * Execute technology research using Gemini with Google Search
 */
export async function executeTechnologyResearch(
  technologyName: string,
  aspectsToResearch?: string[]
): Promise<{ success: boolean; data?: TechnologyResearchResult; error?: string }> {
  try {
    log.info('Researching technology', { technologyName });

    const aspectsPrompt = aspectsToResearch?.length
      ? `Focus on: ${aspectsToResearch.join(', ')}`
      : 'Cover all key aspects';

    const prompt = `Research the technology/framework "${technologyName}" comprehensively.

${aspectsPrompt}

Provide information about:
- What it is and what problem it solves
- Technology category (e.g., frontend framework, database, AI/ML tool)
- Maturity level (emerging, growing, mature, or declining)
- Adoption trends (increasing, stable, or decreasing)
- Key companies/players using or developing it
- Common use cases
- Alternative technologies
- Pros and cons

Be factual and concise. Do not include any markdown formatting like ** or ##.`;

    const response = await generateContent(prompt, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.3,
    });

    // Determine maturity level from response
    let maturityLevel: 'emerging' | 'growing' | 'mature' | 'declining' = 'growing';
    const lowerResponse = response.toLowerCase();
    if (lowerResponse.includes('emerging') || lowerResponse.includes('new') || lowerResponse.includes('early stage')) {
      maturityLevel = 'emerging';
    } else if (
      lowerResponse.includes('mature') ||
      lowerResponse.includes('established') ||
      lowerResponse.includes('widely adopted')
    ) {
      maturityLevel = 'mature';
    } else if (
      lowerResponse.includes('declining') ||
      lowerResponse.includes('legacy') ||
      lowerResponse.includes('being replaced')
    ) {
      maturityLevel = 'declining';
    }

    return {
      success: true,
      data: {
        name: technologyName,
        description: response,
        category: 'Technology',
        maturityLevel,
        adoptionTrend: 'up',
        keyPlayers: [],
        useCases: [],
        alternatives: [],
        sources: ['Google Search via Gemini'],
      },
    };
  } catch (error) {
    log.error('Technology research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Technology research failed',
    };
  }
}

/**
 * AI-028 — comprehensive company research through the structured-generation
 * client and a bounded Zod schema.
 *
 * This previously asked for free-text prose and then recovered "facts" by
 * scanning it, so a page that merely used the word "global" made the company an
 * Enterprise and "public cloud" made it publicly traded. The model now returns a
 * schema-validated object on the real domain unions, each atomic claim carries
 * its own source receipts, and `toPersistableCompanyFacts` drops anything that
 * is unsourced or contradicted before it can be written.
 *
 * @param companyName - The company to research.
 * @param website - Optional known website, used as context only.
 */
export async function executeComprehensiveCompanyResearch(
  companyName: string,
  website?: string
): Promise<{ success: boolean; data?: ComprehensiveCompanyResearchResult; error?: string }> {
  try {
    log.info('Comprehensive research', { companyName });

    const websiteContext = website ? `Known company website: ${website}` : '';

    const prompt = `Research the company "${companyName}" and return ONLY a JSON object matching the schema below.
${websiteContext}

EVIDENCE RULES — these override any instinct to produce a complete-looking record:
- Every claim object is {"value": ..., "sources": [{"url","title","publisher","publishedDate"}]}.
- Only include a claim if you can cite at least one real source URL you actually consulted.
- If you cannot cite a source for a field, set that field to null and add its name to "unknowns".
  A null with an honest unknown is CORRECT. A guess is a defect.
- NEVER infer size, funding stage, country or products from incidental wording. The words
  "global", "large", "enterprise", "public", "seed" or a country name appearing in prose are
  NOT evidence — only an explicit, cited statement about the company is.
- If sources disagree about a field, leave the field null and describe the disagreement in
  "contradictions" instead of picking a side.

ENUMS — use these exact values or null. Do not invent members.
- size: ${COMPANY_SIZE_VALUES.join(' | ')}
- stage: ${COMPANY_STAGE_VALUES.join(' | ')}
- industries: ${COMPANY_INDUSTRY_VALUES.join(' | ')}

VENDOR ASSESSMENT:
- "vendorCapabilities": for each capability, status is "available" only with a cited source;
  a roadmap or launch-post promise is "announced"; anything else is "unknown".
- "evidenceByCategory": cite what you found for benchmark, pricing, sla, security and trial.
  Leave a category as [] when you found nothing — the gap will be reported to the user.

Return JSON with these keys: name, description, website, size, stage, city, country, industries,
technologyStack, socialLinks, contacts, competitors (each {name, sources[]} — cite where the
competitive relationship is stated), swot{strengths,weaknesses,opportunities,threats},
unknowns, contradictions, vendorCapabilities, evidenceByCategory{benchmark,pricing,sla,security,trial}.

Return ONLY the JSON object. No markdown fences, no commentary.`;

    const parsed = await generateStructuredContent(prompt, comprehensiveCompanyResearchSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.2,
    });

    const cleared = toPersistableCompanyFacts(parsed);

    return {
      success: true,
      data: {
        name: parsed.name || companyName,
        ...(cleared.facts.description !== undefined ? { description: cleared.facts.description } : {}),
        ...(cleared.facts.website !== undefined ? { website: cleared.facts.website } : {}),
        industry: cleared.facts.industries ?? [],
        ...(cleared.facts.size !== undefined ? { size: cleared.facts.size } : {}),
        ...(cleared.facts.stage !== undefined ? { stage: cleared.facts.stage } : {}),
        ...(cleared.facts.location !== undefined ? { location: cleared.facts.location } : {}),
        technologyStack: cleared.facts.technologyStack ?? [],
        // Cleared social links only — a `javascript:` URL here would be
        // persisted and rendered as a raw href.
        socialLinks: cleared.facts.socialLinks ?? {},
        contacts: parsed.contacts.map((contact) => ({
          name: contact.name,
          role: contact.role,
          ...(contact.linkedin && canonicalHttpUrl(contact.linkedin) ? { linkedin: contact.linkedin } : {}),
        })),
        competitors: parsed.competitors,
        swot: parsed.swot,
        receipts: cleared.receipts,
        unknowns: cleared.unknowns,
        contradictions: cleared.contradictions,
        vendorCapabilities: cleared.vendorCapabilities.map((capability) => ({
          name: capability.name,
          status: capability.status,
        })),
        missingEvidence: cleared.missingEvidence,
        sourcingComplete: cleared.sourcingComplete,
        citationsVerified: cleared.citationsVerified,
      },
    };
  } catch (error) {
    log.error('Comprehensive company research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Comprehensive company research failed',
    };
  }
}

// ============================================================================
// Bulk Company Research
// ============================================================================

/**
 * Maximum parallel company research operations.
 * Configurable via AI_PARALLEL_TOOL_CALLS env var.
 */
const BULK_RESEARCH_CONCURRENCY = Math.max(1, parseInt(process.env.AI_PARALLEL_TOOL_CALLS || '3', 10));

/** Hard cap on companies per bulk request; the overflow is reported as failed. */
const MAX_BULK_COMPANIES = 50;

/** Maximum accepted company-name length. */
const MAX_COMPANY_NAME_LENGTH = 200;

/**
 * Result of bulk company research
 */
export interface BulkCompanyResearchResult {
  successful: Array<{
    name: string;
    companyId: string;
    contactsCreated: number;
    competitorsAdded: number;
    swotPopulated: boolean;
  }>;
  failed: Array<{
    name: string;
    error: string;
  }>;
  skipped: Array<{
    name: string;
    existingId: string;
    reason: string;
  }>;
}

/**
 * Normalized match key for company duplicate detection: Unicode-normalized
 * (NFKC), case-folded, with every non-letter/non-number character removed while
 * PRESERVING Unicode letters and digits. "DSM Firmenich", "DSM-Firmenich" and
 * "dsmfirmenich" collapse to the same key, but distinct non-Latin names (e.g.
 * "日本電気" vs "任天堂") keep distinct keys instead of both collapsing to "".
 */
function normalizeCompanyMatchKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Research and create multiple companies in parallel.
 * This is much faster than calling researchCompanyComprehensive multiple times.
 *
 * @param companies - Array of company names and optional websites
 * @returns Results for each company (successful, failed, or skipped)
 */
export async function executeBulkResearchCompanies(
  companies: Array<{ name: string; website?: string }>
): Promise<{ success: boolean; data?: BulkCompanyResearchResult; error?: string }> {
  try {
    log.info('Bulk researching', { count: companies.length });

    const result: BulkCompanyResearchResult = {
      successful: [],
      failed: [],
      skipped: [],
    };

    // AI-036 — read existing companies through the Admin SDK boundary. This
    // executor runs SERVER-side; the Firebase Web SDK client service
    // (`@/lib/companies`) throws `Cannot read properties of undefined (reading
    // 'asyncQueue')` / `code: 'unavailable'` here, so it must never be reached.
    // `@/lib/companies-admin` is `server-only` and admin-backed. Imported here
    // (not statically) to avoid pulling a `server-only` module into any client
    // graph that references this file, and to break the entity-creation cycle.
    const { adminGetCompanies } = await import('@/lib/companies-admin');
    const { executeCreateCompanyWithResearch } = await import('./entity-creation');

    // Get existing companies once to check for duplicates.
    const existingCompanies = await adminGetCompanies();
    const existingByKey = new Map<string, { id: string; name: string }>();
    for (const existing of existingCompanies) {
      existingByKey.set(normalizeCompanyMatchKey(existing.name), { id: existing.id, name: existing.name });
    }

    // Bound the batch. Anything beyond the cap is reported as failed rather than
    // silently dropped, so the receipt is honest about what was not attempted.
    const overflow = companies.slice(MAX_BULK_COMPANIES);
    for (const company of overflow) {
      result.failed.push({
        name: typeof company?.name === 'string' && company.name.trim() ? company.name.trim() : '(unnamed)',
        error: `Batch exceeds the maximum of ${MAX_BULK_COMPANIES} companies per request`,
      });
    }

    // Filter and validate before researching. Invalid names (empty, over-long, or
    // with no letters/digits) fail fast; an unsafe optional website is dropped, not
    // trusted. A company already in the graph is skipped (with its existing id).
    // Two inputs that normalize to the SAME Unicode key in this one request are
    // collapsed to a single create: researching and creating both in parallel is
    // exactly how a duplicate Company (and its side entities) could race past the
    // factory's uniqueness check, so the later duplicate is reported as failed.
    const toResearch: Array<{ name: string; website?: string }> = [];
    const seenInBatch = new Set<string>();
    for (const company of companies.slice(0, MAX_BULK_COMPANIES)) {
      const rawName = typeof company?.name === 'string' ? company.name.trim() : '';
      if (!rawName || rawName.length > MAX_COMPANY_NAME_LENGTH) {
        result.failed.push({ name: rawName || '(unnamed)', error: 'Invalid company name' });
        continue;
      }
      const key = normalizeCompanyMatchKey(rawName);
      if (!key) {
        result.failed.push({ name: rawName, error: 'Company name has no letters or digits' });
        continue;
      }
      // Only a safe absolute http(s) URL is passed through; an unsafe website is
      // dropped and research proceeds on the name alone.
      const website =
        typeof company.website === 'string' && canonicalHttpUrl(company.website) ? company.website : undefined;

      const existing = existingByKey.get(key);
      if (existing) {
        result.skipped.push({
          name: rawName,
          existingId: existing.id,
          reason: `Company "${existing.name}" already exists`,
        });
        continue;
      }
      if (seenInBatch.has(key)) {
        const first = toResearch.find((candidate) => normalizeCompanyMatchKey(candidate.name) === key);
        result.failed.push({
          name: rawName,
          error: `Duplicate of "${first?.name ?? rawName}" in the same request — not created to avoid a duplicate company`,
        });
        continue;
      }
      seenInBatch.add(key);
      toResearch.push({ name: rawName, ...(website ? { website } : {}) });
    }

    log.info('Companies filtered', { skipped: result.skipped.length, toResearch: toResearch.length });

    // Process companies in parallel chunks
    for (let i = 0; i < toResearch.length; i += BULK_RESEARCH_CONCURRENCY) {
      const chunk = toResearch.slice(i, i + BULK_RESEARCH_CONCURRENCY);

      const chunkResults = await Promise.all(
        chunk.map(async (company) => {
          try {
            log.info('Researching company', { companyName: company.name });

            // Research the company
            const researchResult = await executeComprehensiveCompanyResearch(company.name, company.website);

            if (!researchResult.success || !researchResult.data) {
              return {
                type: 'failed' as const,
                name: company.name,
                error: researchResult.error || 'Research failed',
              };
            }

            // Create the company with research data
            const createResult = await executeCreateCompanyWithResearch(researchResult.data);

            if (!createResult.success) {
              return {
                type: 'failed' as const,
                name: company.name,
                error: createResult.error || 'Creation failed',
              };
            }

            return {
              type: 'successful' as const,
              name: company.name,
              companyId: createResult.data!.id,
              contactsCreated: createResult.data!.contactsCreated || 0,
              competitorsAdded: createResult.data!.competitorsAdded || 0,
              swotPopulated: createResult.data!.swotPopulated || false,
            };
          } catch (error) {
            return {
              type: 'failed' as const,
              name: company.name,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        })
      );

      // Categorize results
      for (const res of chunkResults) {
        if (res.type === 'successful') {
          result.successful.push({
            name: res.name,
            companyId: res.companyId,
            contactsCreated: res.contactsCreated,
            competitorsAdded: res.competitorsAdded,
            swotPopulated: res.swotPopulated,
          });
        } else {
          result.failed.push({
            name: res.name,
            error: res.error,
          });
        }
      }
    }

    log.info('Bulk research complete', {
      successful: result.successful.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
    });

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    log.error('Bulk research failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk research failed',
    };
  }
}
