/**
 * @file ai/tools/primary-source-tools.ts
 * @description Tool wrappers exposing the 5 keyless primary-source research
 * modules (`src/lib/research/*`) to the Gemini chat assistant + MCP surface.
 * Mirrors the `FunctionDeclaration` + `execute*` idiom in `web-research.ts`.
 *
 * Consumes: `searchPapers`, `resolveOpenAccess`, `searchHackerNews`,
 * `searchSecFilings`, `searchOssHealth` from `src/lib/research/*`. Each
 * research module already never throws to its own caller (see the
 * Research-Capability Lift plan, Tasks A3-A7) — these executors add a
 * defensive try/catch anyway so a `ToolResult` is always returned even if a
 * research module's no-throw contract were ever violated.
 *
 * Provides keyless primary-source research tools with bounded output.
 * Final-review pass (error/empty discriminator): every module now returns a
 * `ResearchOutcome<T>` (`{ data, error? }`) instead of a bare `data` value.
 * Each executor unwraps it — `error` set maps to `{ success: false, error }`
 * so a genuine upstream failure (403/5xx/timeout/schema-drift) surfaces to
 * the chat assistant as a real failure instead of collapsing into the same
 * shape as "no results," which previously caused the assistant to
 * confabulate an answer on top of a silent SEC EDGAR 403.
 *
 * @author Radarist Team
 * @created 2026-07-03
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { createLogger } from '@/lib/logger';
import { searchPapers, type PaperSource } from '@/lib/research/papers';
import { resolveOpenAccess } from '@/lib/research/open-access';
import { searchHackerNews } from '@/lib/research/hn';
import { searchSecFilings } from '@/lib/research/sec';
import { searchOssHealth } from '@/lib/research/oss-health';
import { searchPatents } from '@/lib/research/patents';
import type { ToolResult } from './tool-result';

const log = createLogger('ai/primary-source-tools');

// ============================================================================
// Tool Definitions for Primary-Source Research
// ============================================================================

export const PRIMARY_SOURCE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'searchPapers',
    description: `Search real academic literature across OpenAlex, Crossref, and Semantic Scholar — three keyless, public scholarly indexes covering peer-reviewed papers, preprints, and citation counts.

WHEN TO USE THIS TOOL:
- The user asks about research, state-of-the-art, academic evidence, or "what does the literature say about X"
- You need peer-reviewed backing for a technology or scientific claim (benchmark numbers, methodology, prior art)
- You need a proper citation for a report or a graph Evidence node

WHAT IT RETURNS: title, authors, publication year, URL, abstract (when available), citation count, DOI, and a ready-to-use IEEE-formatted citation string per paper.

Returns real data from live academic APIs — never invent/fabricate results or citations. If no papers are found, say so; do not make one up.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Search query for the academic literature (e.g., "retrieval augmented generation", "graph neural networks drug discovery")',
        },
        source: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['openalex', 'crossref', 'semantic-scholar', 'all'],
          description: 'Which academic index to search. "all" (default) queries all three and merges/dedups by DOI.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of papers to return (default: 10)',
        },
        yearFrom: {
          type: SchemaType.NUMBER,
          description: 'Only return papers published in or after this year (e.g., 2023)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'resolveOpenAccess',
    description: `Resolve the open-access status and free full-text PDF location for a paper's DOI, via Unpaywall — the canonical public open-access database.

WHEN TO USE THIS TOOL:
- After searchPapers returns a DOI and the user wants to read (or link to) the full text
- You need to know whether a paper is legally freely available before citing a paywalled version

WHAT IT RETURNS: whether the paper is open access, the direct PDF URL (if any), the host type (e.g. repository, publisher), and the OA version (e.g. published, accepted manuscript).

Requires a configured contact email (RESEARCH_CONTACT_EMAIL) — Unpaywall's terms require one. When unset, this tool returns a typed "email not configured" result rather than failing; say so plainly rather than guessing at OA status. Returns real data — never invent/fabricate results or citations.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        doi: {
          type: SchemaType.STRING,
          description:
            'The paper DOI to resolve (e.g., "10.1109/CVPR.2016.90"), typically obtained from a searchPapers result',
        },
      },
      required: ['doi'],
    },
  },
  {
    name: 'searchHackerNews',
    description: `Search Hacker News (stories, Show HN, Ask HN, comments) via the keyless HN Algolia API — a real-time pulse on what the developer/tech community is discussing right now.

WHEN TO USE THIS TOOL:
- The user asks what people are saying about a technology, launch, or trend on Hacker News
- You want community sentiment, launch reception, or discussion volume as a grounding signal (points, comment count) alongside more formal sources

WHAT IT RETURNS: title, URL, points, comment count, author, and creation date per hit.

Returns real data from the live HN Algolia search API — never invent/fabricate results or citations. If nothing turns up, say so.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Search query (e.g., "vector database", "AI coding agent launch")',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of results to return (default: 10)',
        },
        tags: {
          type: SchemaType.STRING,
          description: 'HN Algolia tag filter, e.g. "story" (default), "comment", "ask_hn", "show_hn", "poll"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'searchSecFilings',
    description: `Search real SEC filings (10-K, 10-Q, 8-K, S-1, etc.) via the SEC EDGAR full-text search API — the authoritative, keyless, public source for US public-company disclosures.

WHEN TO USE THIS TOOL:
- The user asks about a public company's official disclosures, risk factors, financials narrative, or a specific filing type
- You need primary-source evidence (not a news paraphrase) for a company/technology claim tied to a public filer

WHAT IT RETURNS: company name, CIK, form type, filing date, a direct link to the filing index page on sec.gov, and a snippet when EDGAR provides one.

Returns real data from the live SEC EDGAR API — never invent/fabricate results or citations. If no matching filings are found, say so.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Full-text search query (e.g., company name, product, or risk-factor keyword)',
        },
        formTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter to specific SEC form types (e.g., ["10-K", "8-K"])',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of filings to return',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'searchOssHealth',
    description: `Look up open-source repository health metrics (stars, contributors, last commit, maintenance score) for a GitHub repo via the keyless Ecosyste.ms API.

WHEN TO USE THIS TOOL:
- The user asks how healthy, active, or well-maintained an open-source project is
- You're assessing a technology's OSS maturity/risk (e.g., for a radar placement or a buy-vs-build call) and need real repo signals, not a guess

WHAT IT RETURNS: stars, contributor count, last commit date, downloads/dependents/advisories (null when Ecosyste.ms doesn't offer that metric for the repo — never invented), and a maintenance score.

Results carry a CC-BY-SA attribution ("Data: Ecosyste.ms (CC-BY-SA 4.0)") that MUST be preserved/surfaced whenever this data is quoted in a report or answer. Returns real data — never invent/fabricate results or citations. If this tool returns null/empty metrics, say the data was not found — do NOT fill in remembered or estimated numbers.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        repoOrPackage: {
          type: SchemaType.STRING,
          description:
            'The FULL GitHub "owner/repo" slug (e.g., "facebook/react", "pgvector/pgvector", "qdrant/qdrant") or a full github.com URL. A bare project name without the owner (e.g., just "pgvector") returns NO data — if you only know the project name, resolve its owner/repo slug first (many projects use owner==repo, e.g. "pgvector/pgvector") rather than calling with a bare name.',
        },
      },
      required: ['repoOrPackage'],
    },
  },
  {
    name: 'searchPatents',
    description: `Search the patent landscape for a topic, keyword, or assignee via the keyless Google Patents search API — real filings with assignees and filing dates, plus the total match count (the "how crowded is this space?" signal).

WHEN TO USE THIS TOOL:
- The user asks "who owns the IP around X?", "patent landscape for X", "is this space getting crowded?", or "where's the white space?"
- You're reading a *cluster* of filings for competitive/white-space signal (assignee concentration, filing velocity) — pairs with the read-patent-landscape skill

WHAT IT RETURNS: totalResults (full upstream match count), and per filing: patent number, title, assignee, inventor, priority/filing/grant/publication dates, and a Google Patents URL. CPC/IPC codes are NOT returned by the search endpoint — do not claim CPC clustering from this tool alone; for a single filing's claims/classes use analyze-patent-claims.

Returns real data from live Google Patents — never invent/fabricate filings, assignees, or numbers. The endpoint rate-limits bursts: if it returns an error (e.g. a 503), say patent search was temporarily unavailable and retry — do NOT fill in remembered or estimated results.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            'Patent search terms — a topic/keyword ("retrieval augmented generation", "solid state battery"), or an assignee name to see one company\'s filings.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description:
            'Maximum number of filings to sample (default: 25, max: 100). The total match count is returned regardless.',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Search academic literature across OpenAlex, Crossref, and Semantic Scholar.
 * Delegates to `searchPapers` (src/lib/research/papers.ts), which never
 * throws; the try/catch here is belt-and-suspenders so this executor never
 * throws to the model either.
 */
export async function executeSearchPapers(args: {
  query: string;
  source?: string;
  limit?: number;
  yearFrom?: number;
}): Promise<ToolResult> {
  try {
    const { data, error } = await searchPapers({
      query: args.query,
      source: (args.source as PaperSource | undefined) ?? 'all',
      limit: args.limit,
      yearFrom: args.yearFrom,
    });
    if (error) return { success: false, error };
    return { success: true, data: { count: data.length, papers: data } };
  } catch (err) {
    log.error('executeSearchPapers failed', err instanceof Error ? err : undefined, { query: args.query });
    return { success: false, error: err instanceof Error ? err.message : 'searchPapers failed' };
  }
}

/**
 * Resolve open-access status + PDF location for a DOI via Unpaywall.
 * Delegates to `resolveOpenAccess` (src/lib/research/open-access.ts).
 */
export async function executeResolveOpenAccess(args: { doi: string }): Promise<ToolResult> {
  try {
    const { data, error } = await resolveOpenAccess({ doi: args.doi });
    if (error) return { success: false, error };
    return { success: true, data };
  } catch (err) {
    log.error('executeResolveOpenAccess failed', err instanceof Error ? err : undefined, { doi: args.doi });
    return { success: false, error: err instanceof Error ? err.message : 'resolveOpenAccess failed' };
  }
}

/**
 * Search Hacker News via the HN Algolia API.
 * Delegates to `searchHackerNews` (src/lib/research/hn.ts).
 */
export async function executeSearchHackerNews(args: {
  query: string;
  limit?: number;
  tags?: string;
}): Promise<ToolResult> {
  try {
    const { data, error } = await searchHackerNews({ query: args.query, limit: args.limit, tags: args.tags });
    if (error) return { success: false, error };
    return { success: true, data: { count: data.length, hits: data } };
  } catch (err) {
    log.error('executeSearchHackerNews failed', err instanceof Error ? err : undefined, { query: args.query });
    return { success: false, error: err instanceof Error ? err.message : 'searchHackerNews failed' };
  }
}

/**
 * Search SEC filings via the EDGAR full-text search API.
 * Delegates to `searchSecFilings` (src/lib/research/sec.ts).
 */
export async function executeSearchSecFilings(args: {
  query: string;
  formTypes?: string[];
  limit?: number;
}): Promise<ToolResult> {
  try {
    const { data, error } = await searchSecFilings({ query: args.query, formTypes: args.formTypes, limit: args.limit });
    if (error) return { success: false, error };
    return { success: true, data: { count: data.length, filings: data } };
  } catch (err) {
    log.error('executeSearchSecFilings failed', err instanceof Error ? err : undefined, { query: args.query });
    return { success: false, error: err instanceof Error ? err.message : 'searchSecFilings failed' };
  }
}

/**
 * Look up OSS repository health metrics via the Ecosyste.ms API.
 * Delegates to `searchOssHealth` (src/lib/research/oss-health.ts).
 */
export async function executeSearchOssHealth(args: { repoOrPackage: string }): Promise<ToolResult> {
  try {
    const { data, error } = await searchOssHealth({ repoOrPackage: args.repoOrPackage });
    if (error) return { success: false, error };
    return { success: true, data };
  } catch (err) {
    log.error('executeSearchOssHealth failed', err instanceof Error ? err : undefined, {
      repoOrPackage: args.repoOrPackage,
    });
    return { success: false, error: err instanceof Error ? err.message : 'searchOssHealth failed' };
  }
}

/**
 * Search the patent landscape via Google Patents.
 * Delegates to `searchPatents` (src/lib/research/patents.ts).
 */
export async function executeSearchPatents(args: { query: string; limit?: number }): Promise<ToolResult> {
  try {
    const { data, error } = await searchPatents({ query: args.query, limit: args.limit });
    if (error) return { success: false, error };
    return {
      success: true,
      data: { totalResults: data.totalResults, count: data.patents.length, patents: data.patents },
    };
  } catch (err) {
    log.error('executeSearchPatents failed', err instanceof Error ? err : undefined, { query: args.query });
    return { success: false, error: err instanceof Error ? err.message : 'searchPatents failed' };
  }
}
