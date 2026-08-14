/**
 * @file lib/research/papers.ts
 * @description Keyless academic literature search across OpenAlex, Crossref, and
 * Semantic Scholar. Server-only (uses `politeFetch` + public research APIs).
 *
 * Contract (per the Research-Capability Lift plan, Task A3; error/empty
 * discriminator added in the final-review pass):
 * - `searchPapers` never throws to the caller. Each private source fetcher wraps
 *   its work in try/catch and returns `{ data: [] }` on any failure (upstream
 *   error, malformed/schema-invalid response) — with `error` set to a short
 *   human message so a caller can tell "the source failed" from "the source had
 *   nothing." `searchPapers` runs the selected sources with `Promise.allSettled`,
 *   flattens the successful `data`, dedups (by DOI case-insensitive when
 *   present — DOI takes precedence; normalized-title dedup is only the fallback
 *   for DOI-less papers), and trims the result to the resolved `limit` (each
 *   source is asked for up to `limit`, so `source: 'all'` can merge to ~3x
 *   `limit` before trimming). The top-level `error` is set only when EVERY
 *   requested source failed — a partial failure alongside at least one
 *   successful source still yields genuine (if partial) data, which is not a
 *   top-level failure.
 * - Schemas are lenient: only the consumed fields, everything
 *   `.optional()/.nullable()`, `.passthrough()` — upstream shape drift never
 *   crashes a fetch (it surfaces as `error`, not a throw).
 * - Each result's `citation` is filled via `formatIeeeCitation`.
 * - OpenAlex abstracts are an inverted index; we deliberately set `abstract: null`
 *   rather than reconstruct.
 * - Crossref abstracts arrive as raw JATS XML (e.g. `<jats:p>…</jats:p>`);
 *   `stripJatsMarkup` strips tags (no entity decoding) before mapping.
 * - `yearFrom` is coerced + validated (`coerceYearFrom`) before being
 *   interpolated into the OpenAlex/Crossref URLs — the MCP path doesn't
 *   per-field validate args, so a non-numeric value must not reach the URL.
 *
 * Deferred by design: arXiv Atom-XML source (needs `fast-xml-parser`). OpenAlex
 * already indexes arXiv preprints, so v1 coverage is intact.
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, getResearchContactEmail, ResearchFetchError } from './http';
import { formatIeeeCitation } from './citation';
import type { PaperResult, ResearchOutcome } from './types';

const log = createLogger('research/papers');

export type PaperSource = 'openalex' | 'crossref' | 'semantic-scholar' | 'all';

export interface SearchPapersParams {
  query: string;
  source?: PaperSource;
  limit?: number;
  yearFrom?: number;
}

const DEFAULT_LIMIT = 10;

// ============================================================================
// Small shared helpers
// ============================================================================

/**
 * Strip common DOI URL/prefix wrappers so DOIs from different sources compare
 * equal. Returns a bare DOI (e.g. `10.1109/CVPR.2016.90`) or `null` when empty.
 */
function stripDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Normalize a title for dedup: lowercase, alphanumerics only, collapsed spaces. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Strip JATS/XML markup (e.g. `<jats:p>…</jats:p>`) from a Crossref abstract.
 * Crossref returns the raw JATS XML abstract verbatim; we only strip tags —
 * no entity decoding — and preserve `null` when the abstract is absent.
 */
function stripJatsMarkup(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/<[^>]+>/g, '').trim();
  return stripped.length > 0 ? stripped : null;
}

/** Keep only non-empty, trimmed author strings. */
function cleanAuthors(names: Array<string | null | undefined>): string[] {
  return names.map((n) => (n ?? '').trim()).filter((n): n is string => n.length > 0);
}

/**
 * Coerce + validate `yearFrom` before it's interpolated into a source URL.
 * The MCP path doesn't per-field validate tool args, so a value typed
 * `number` in `SearchPapersParams` can still arrive as a string (or other
 * junk) at runtime. Only a value that coerces to a positive integer is used
 * as a year filter; anything else is silently dropped (no filter applied)
 * rather than interpolated raw.
 */
function coerceYearFrom(yearFrom: number | undefined): number | undefined {
  if (yearFrom === undefined || yearFrom === null) return undefined;
  const n = Number(yearFrom);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Assemble a `PaperResult`, filling the IEEE citation. Returns `null` when the
 * entry lacks the minimum required fields (title + a usable URL) so it is
 * skipped rather than emitted half-populated.
 */
function toPaperResult(input: {
  title: string | null | undefined;
  authors: string[];
  year: number | null;
  url: string | null;
  abstract: string | null;
  citationCount: number | null;
  source: PaperResult['source'];
  doi: string | null;
}): PaperResult | null {
  const title = input.title?.trim();
  if (!title) return null;
  const url = input.url?.trim();
  if (!url) return null;

  return {
    title,
    authors: input.authors,
    year: input.year ?? null,
    url,
    abstract: input.abstract ?? null,
    citationCount: input.citationCount ?? null,
    source: input.source,
    doi: input.doi ?? null,
    citation: formatIeeeCitation({
      title,
      authors: input.authors,
      year: input.year ?? null,
      url,
      doi: input.doi ?? null,
    }),
  };
}

// ============================================================================
// OpenAlex — https://api.openalex.org/works
// ============================================================================

const OpenAlexWorkSchema = z
  .object({
    title: z.string().nullable().optional(),
    publication_year: z.number().nullable().optional(),
    cited_by_count: z.number().nullable().optional(),
    doi: z.string().nullable().optional(),
    authorships: z
      .array(
        z
          .object({
            author: z.object({ display_name: z.string().nullable().optional() }).passthrough().nullable().optional(),
          })
          .passthrough()
      )
      .nullable()
      .optional(),
    primary_location: z
      .object({ landing_page_url: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const OpenAlexResponseSchema = z.object({ results: z.array(OpenAlexWorkSchema).nullable().optional() }).passthrough();

async function fetchOpenAlex(query: string, limit: number, yearFrom?: number): Promise<ResearchOutcome<PaperResult[]>> {
  try {
    let url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}`;
    // `yearFrom` is coerced + validated by the caller (`coerceYearFrom`) before
    // reaching here, so it's always a positive integer at this point.
    if (yearFrom) url += `&filter=from_publication_date:${yearFrom}-01-01`;
    const email = getResearchContactEmail();
    if (email) url += `&mailto=${encodeURIComponent(email)}`;

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = OpenAlexResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('OpenAlex response failed schema validation', { issues: parsed.error.issues.length });
      return { data: [], error: 'Unexpected response shape from OpenAlex' };
    }

    const results: PaperResult[] = [];
    for (const work of parsed.data.results ?? []) {
      const doi = stripDoi(work.doi);
      const mapped = toPaperResult({
        title: work.title,
        authors: cleanAuthors((work.authorships ?? []).map((a) => a.author?.display_name)),
        year: work.publication_year ?? null,
        // Prefer the landing page; fall back to the DOI resolver.
        url: work.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : null),
        // OpenAlex abstracts are an inverted index — deliberately not reconstructed.
        abstract: null,
        citationCount: work.cited_by_count ?? null,
        source: 'openalex',
        doi,
      });
      if (mapped) results.push(mapped);
    }
    return { data: results };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('OpenAlex fetch failed', { err: err.message, status: err.status });
      return { data: [], error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn('OpenAlex fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return { data: [], error: 'Unexpected response shape from OpenAlex' };
  }
}

// ============================================================================
// Crossref — https://api.crossref.org/works
// ============================================================================

const CrossrefItemSchema = z
  .object({
    title: z.array(z.string()).nullable().optional(),
    author: z
      .array(
        z
          .object({
            given: z.string().nullable().optional(),
            family: z.string().nullable().optional(),
          })
          .passthrough()
      )
      .nullable()
      .optional(),
    created: z
      .object({ 'date-parts': z.array(z.array(z.number())).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    'is-referenced-by-count': z.number().nullable().optional(),
    DOI: z.string().nullable().optional(),
    URL: z.string().nullable().optional(),
    abstract: z.string().nullable().optional(),
  })
  .passthrough();

const CrossrefResponseSchema = z
  .object({
    message: z
      .object({ items: z.array(CrossrefItemSchema).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

async function fetchCrossref(query: string, limit: number, yearFrom?: number): Promise<ResearchOutcome<PaperResult[]>> {
  try {
    let url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`;
    // `yearFrom` is coerced + validated by the caller (`coerceYearFrom`) before
    // reaching here, so it's always a positive integer at this point.
    if (yearFrom) url += `&filter=from-pub-date:${yearFrom}-01-01`;
    const email = getResearchContactEmail();
    if (email) url += `&mailto=${encodeURIComponent(email)}`;

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = CrossrefResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('Crossref response failed schema validation', { issues: parsed.error.issues.length });
      return { data: [], error: 'Unexpected response shape from Crossref' };
    }

    const results: PaperResult[] = [];
    for (const item of parsed.data.message?.items ?? []) {
      const doi = stripDoi(item.DOI);
      const year = item.created?.['date-parts']?.[0]?.[0] ?? null;
      const mapped = toPaperResult({
        title: item.title?.[0],
        authors: cleanAuthors((item.author ?? []).map((a) => `${a.given ?? ''} ${a.family ?? ''}`.trim())),
        year,
        url: item.URL ?? (doi ? `https://doi.org/${doi}` : null),
        abstract: stripJatsMarkup(item.abstract),
        citationCount: item['is-referenced-by-count'] ?? null,
        source: 'crossref',
        doi,
      });
      if (mapped) results.push(mapped);
    }
    return { data: results };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('Crossref fetch failed', { err: err.message, status: err.status });
      return { data: [], error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn('Crossref fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return { data: [], error: 'Unexpected response shape from Crossref' };
  }
}

// ============================================================================
// Semantic Scholar — https://api.semanticscholar.org/graph/v1/paper/search
// ============================================================================

const SemanticScholarPaperSchema = z
  .object({
    title: z.string().nullable().optional(),
    abstract: z.string().nullable().optional(),
    year: z.number().nullable().optional(),
    citationCount: z.number().nullable().optional(),
    url: z.string().nullable().optional(),
    authors: z
      .array(z.object({ name: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    externalIds: z.object({ DOI: z.string().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

const SemanticScholarResponseSchema = z
  .object({ data: z.array(SemanticScholarPaperSchema).nullable().optional() })
  .passthrough();

async function fetchSemanticScholar(query: string, limit: number): Promise<ResearchOutcome<PaperResult[]>> {
  try {
    const fields = 'title,abstract,year,authors,citationCount,externalIds,url';
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
      query
    )}&limit=${limit}&fields=${fields}`;

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = SemanticScholarResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('Semantic Scholar response failed schema validation', { issues: parsed.error.issues.length });
      return { data: [], error: 'Unexpected response shape from Semantic Scholar' };
    }

    const results: PaperResult[] = [];
    for (const paper of parsed.data.data ?? []) {
      const doi = stripDoi(paper.externalIds?.DOI);
      const mapped = toPaperResult({
        title: paper.title,
        authors: cleanAuthors((paper.authors ?? []).map((a) => a.name)),
        year: paper.year ?? null,
        url: paper.url ?? (doi ? `https://doi.org/${doi}` : null),
        abstract: paper.abstract ?? null,
        citationCount: paper.citationCount ?? null,
        source: 'semantic-scholar',
        doi,
      });
      if (mapped) results.push(mapped);
    }
    return { data: results };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('Semantic Scholar fetch failed', { err: err.message, status: err.status });
      return { data: [], error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn('Semantic Scholar fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return { data: [], error: 'Unexpected response shape from Semantic Scholar' };
  }
}

// ============================================================================
// Merge + dedup
// ============================================================================

/**
 * Dedup by DOI (case-insensitive) when a paper has one; normalized-title
 * dedup is only the fallback for papers with NO DOI. DOI takes precedence so
 * two distinct papers that merely share a title (different DOIs) are both
 * kept. First occurrence wins, preserving source order (OpenAlex → Crossref
 * → Semantic Scholar for `source: 'all'`).
 */
function dedup(papers: PaperResult[]): PaperResult[] {
  const seenDoi = new Set<string>();
  const seenTitle = new Set<string>();
  const out: PaperResult[] = [];

  for (const paper of papers) {
    const doiKey = paper.doi ? paper.doi.toLowerCase() : null;

    if (doiKey) {
      if (seenDoi.has(doiKey)) continue;
      seenDoi.add(doiKey);
      out.push(paper);
      continue;
    }

    const titleKey = normalizeTitle(paper.title);
    if (titleKey && seenTitle.has(titleKey)) continue;
    if (titleKey) seenTitle.add(titleKey);
    out.push(paper);
  }

  return out;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Search academic literature across OpenAlex, Crossref, and Semantic Scholar.
 * Never throws — failing sources contribute no papers to `data`. Results are
 * merged and deduped by DOI (case-insensitive) then normalized title.
 *
 * The top-level `error` is set only when EVERY requested source failed —
 * this lets a caller distinguish "the API failed" from "no results" without
 * penalizing a partial success (`source: 'all'` with one source down still
 * returns the other sources' genuine data, un-flagged as an error).
 */
export async function searchPapers(params: SearchPapersParams): Promise<ResearchOutcome<PaperResult[]>> {
  const query = params.query?.trim();
  if (!query) return { data: [] };

  const source: PaperSource = params.source ?? 'all';
  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT;
  const yearFrom = coerceYearFrom(params.yearFrom);

  const tasks: Array<Promise<ResearchOutcome<PaperResult[]>>> = [];
  if (source === 'openalex' || source === 'all') tasks.push(fetchOpenAlex(query, limit, yearFrom));
  if (source === 'crossref' || source === 'all') tasks.push(fetchCrossref(query, limit, yearFrom));
  if (source === 'semantic-scholar' || source === 'all') tasks.push(fetchSemanticScholar(query, limit));

  const settled = await Promise.allSettled(tasks);
  const merged: PaperResult[] = [];
  const failures: string[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      merged.push(...result.value.data);
      if (result.value.error) failures.push(result.value.error);
    } else {
      // Fetchers already swallow their own errors; this is belt-and-suspenders.
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(reason);
      log.warn('paper source rejected unexpectedly', { reason });
    }
  }

  // Each source is asked for up to `limit` results, so `source: 'all'` can
  // return up to ~3x `limit` after merging. Trim to the caller's requested
  // limit after dedup.
  const data = dedup(merged).slice(0, limit);
  if (tasks.length > 0 && failures.length === tasks.length) {
    // A single requested source surfaces its own error message; multiple
    // requested sources (source: 'all') collapse to one summary message —
    // three concatenated upstream errors is noise, not signal.
    return { data, error: failures.length === 1 ? failures[0] : 'All paper sources failed' };
  }
  return { data };
}
