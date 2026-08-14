/**
 * Normalized result types for the primary-source research tools
 * (papers, open-access resolution, Hacker News, SEC filings, OSS health).
 *
 * Each source module (`papers.ts`, `open-access.ts`, `hn.ts`, `sec.ts`,
 * `oss-health.ts`) normalizes its upstream API response into one of these
 * shapes so the tool wrappers in `src/lib/ai/tools/primary-source-tools.ts`
 * have a single, stable contract regardless of source.
 */

/**
 * A research fetch that succeeded (`error` undefined, `data` is the real
 * result — possibly a genuinely-empty array/object) or failed upstream
 * (`error` set to a short human message, `data` is the typed empty default).
 * Lets callers (and the chat assistant, transitively) distinguish "the API
 * failed" from "no results" instead of collapsing both to an empty payload.
 */
export interface ResearchOutcome<T> {
  data: T;
  error?: string;
}

export interface PaperResult {
  title: string;
  authors: string[];
  year: number | null;
  url: string;
  abstract: string | null;
  citationCount: number | null;
  source: 'openalex' | 'crossref' | 'semantic-scholar' | 'arxiv';
  doi: string | null;
  citation: string; // IEEE string (citation-js) or plain fallback
}

export interface OpenAccessResult {
  isOA: boolean;
  pdfUrl: string | null;
  hostType: string | null;
  version: string | null;
}

export interface HackerNewsResult {
  title: string;
  url: string | null;
  points: number;
  numComments: number;
  author: string;
  createdAt: string;
  objectID: string;
}

export interface SecFilingResult {
  company: string;
  cik: string;
  formType: string;
  filedAt: string;
  url: string;
  snippet: string | null;
}

export interface OssHealthResult {
  name: string;
  stars: number | null;
  contributors: number | null;
  lastCommit: string | null;
  downloads: number | null;
  dependentsCount: number | null;
  advisories: number | null;
  maintenanceScore: number | null;
  attribution: string; // CC-BY-SA — always "Data: Ecosyste.ms (CC-BY-SA 4.0)"
}

export interface PatentResult {
  patentNumber: string; // e.g. "US12197859B1" (Google Patents publication_number)
  title: string;
  assignee: string | null;
  inventor: string | null;
  priorityDate: string | null; // ISO date string, or null
  filingDate: string | null;
  grantDate: string | null;
  publicationDate: string | null;
  url: string; // https://patents.google.com/patent/<number>/en
  snippet: string | null;
}

/**
 * A patent-landscape search result. `totalResults` is the FULL match count
 * upstream (the "how crowded is this space?" signal), independent of how many
 * `patents` were sampled into this page. CPC/IPC codes are NOT included — the
 * search endpoint does not return them (a per-filing fetch would); an honest
 * gap, not a bug.
 */
export interface PatentSearchData {
  totalResults: number;
  patents: PatentResult[];
  source: 'google-patents';
}
