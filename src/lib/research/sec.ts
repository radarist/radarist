/**
 * @file lib/research/sec.ts
 * @description Keyless SEC filing search via the EDGAR full-text search
 * endpoint (EFTS). Server-only (uses `politeFetch` + the public
 * `efts.sec.gov` API).
 *
 * Contract (per the Research-Capability Lift plan, Task A6; error/empty
 * discriminator added in the final-review pass):
 * - `searchSecFilings` never throws to the caller: the fetch + mapping is
 *   wrapped in try/catch and returns `{ data: [] }` on any failure (upstream
 *   error, malformed/schema-invalid response) — with `error` set to a short
 *   human message so a caller can tell "the source failed" from "the source
 *   had nothing" (the bug this closes: a 403 from EDGAR's WAF used to look
 *   identical to "no filings found").
 * - SEC EDGAR requires a descriptive `User-Agent` (not an email) —
 *   `politeFetch` already supplies one, so this module works with
 *   `RESEARCH_CONTACT_EMAIL` unset. If the upstream fetch still fails (e.g.
 *   a 403), the warn log includes a hint pointing at the User-Agent
 *   requirement so an operator investigating a live failure knows where to
 *   look first.
 * - Schema is lenient: only the consumed fields, everything
 *   `.optional()/.nullable()`, `.passthrough()` — upstream shape drift never
 *   crashes a fetch.
 * - `company` is `_source.display_names[0]` with trailing parenthetical
 *   annotations stripped (EDGAR emits names like
 *   `"C3.ai, Inc.  (AI)  (CIK 0001577526)"` — cleaned to `"C3.ai, Inc."`).
 * - `cik` is `_source.ciks[0]` (EDGAR returns an array — a filing can list
 *   more than one CIK; we take the first).
 * - `formType` is `_source.form` (not `_source.root_forms`, which is the
 *   normalized-family array, e.g. `["10-K"]` for a `10-K/A`).
 * - `snippet` is `_source.file_description ?? null` — EDGAR's actual
 *   highlight/description field (not a search-highlight fragment).
 * - `url` is derived from `_source.adsh` (accession number) +
 *   `_source.ciks[0]`:
 *   `https://www.sec.gov/Archives/edgar/data/{cikNoLeadingZeros}/{adshNoDashes}/{adsh}-index.htm`.
 *
 * Live-verified real `_source` shape (confirmed against a live
 * `efts.sec.gov` response):
 * ```
 * {
 *   adsh: "0001628280-25-032604",
 *   ciks: ["0001577526"],
 *   form: "10-K",
 *   root_forms: ["10-K"],
 *   display_names: ["C3.ai, Inc.  (AI)  (CIK 0001577526)"],
 *   file_date: "2025-06-23",
 *   file_description: "..."
 * }
 * ```
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, ResearchFetchError } from './http';
import type { SecFilingResult, ResearchOutcome } from './types';

const log = createLogger('research/sec');

export interface SearchSecFilingsParams {
  query: string;
  formTypes?: string[];
  limit?: number;
}

const SEC_UA_HINT =
  'SEC EDGAR requires a descriptive User-Agent header (see https://www.sec.gov/os/webmaster-faq#code-support) — ' +
  "confirm politeFetch's User-Agent is descriptive if this keeps failing (e.g. repeated 403s).";

const SecHitSourceSchema = z
  .object({
    display_names: z.array(z.string()).nullable().optional(),
    ciks: z.array(z.string()).nullable().optional(),
    adsh: z.string().nullable().optional(),
    form: z.string().nullable().optional(),
    file_date: z.string().nullable().optional(),
    file_description: z.string().nullable().optional(),
  })
  .passthrough();

const SecHitSchema = z
  .object({
    _id: z.string().nullable().optional(),
    _source: SecHitSourceSchema.nullable().optional(),
  })
  .passthrough();

const SecResponseSchema = z
  .object({
    hits: z
      .object({ hits: z.array(SecHitSchema).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Strip trailing parenthetical annotations EDGAR appends to display names,
 * e.g. `"C3.ai, Inc.  (AI)  (CIK 0001577526)"` -> `"C3.ai, Inc."`. Repeats
 * until no more trailing `(...)` groups remain.
 */
function cleanCompanyName(raw: string | null | undefined): string {
  if (!raw) return '';
  let name = raw.trim();
  let previous: string;
  do {
    previous = name;
    name = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  } while (name !== previous && name.length > 0);
  return name;
}

/**
 * Build the filing index-page URL from `_source.adsh` (accession number,
 * e.g. `"0001628280-25-032604"`) and `_source.ciks[0]`. Returns `null` when
 * either piece is missing or the CIK isn't a usable number.
 */
function buildFilingUrl(adsh: string | null | undefined, cik: string | null | undefined): string | null {
  if (!adsh || !cik) return null;
  const adshNoDashes = adsh.replace(/-/g, '');
  if (!adshNoDashes) return null;

  const cikNumber = Number(cik);
  if (!Number.isFinite(cikNumber)) return null;
  const cikNoLeadingZeros = String(cikNumber);

  return `https://www.sec.gov/Archives/edgar/data/${cikNoLeadingZeros}/${adshNoDashes}/${adsh}-index.htm`;
}

/**
 * Assemble a `SecFilingResult`. Returns `null` when the hit lacks the
 * minimum required fields (company, cik, form type, filing date, or a
 * constructable URL — which itself requires `adsh` + `ciks[0]`) so it is
 * skipped rather than emitted half-populated.
 */
function toSecFilingResult(hit: z.infer<typeof SecHitSchema>): SecFilingResult | null {
  const source = hit._source;
  const company = cleanCompanyName(source?.display_names?.[0]);
  const cik = source?.ciks?.[0] ?? null;
  const formType = source?.form?.trim();
  const filedAt = source?.file_date?.trim();
  const snippet = source?.file_description?.trim() || null;
  const url = buildFilingUrl(source?.adsh, cik);

  if (!company || !cik || !formType || !filedAt || !url) return null;

  return {
    company,
    cik: String(cik),
    formType,
    filedAt,
    url,
    snippet,
  };
}

/**
 * Search SEC filings via the EDGAR full-text search API (EFTS). Never
 * throws — degrades to `{ data: [], error: <message> }` on any upstream
 * error or schema-invalid response; a genuine zero-hit search returns
 * `{ data: [] }` with `error` undefined.
 */
export async function searchSecFilings(params: SearchSecFilingsParams): Promise<ResearchOutcome<SecFilingResult[]>> {
  const query = params.query?.trim();
  if (!query) return { data: [] };

  try {
    let url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}`;
    if (params.formTypes && params.formTypes.length > 0) {
      url += `&forms=${encodeURIComponent(params.formTypes.join(','))}`;
    }

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = SecResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('SEC EDGAR response failed schema validation', { issues: parsed.error.issues.length });
      return { data: [], error: 'Unexpected response shape from SEC EDGAR' };
    }

    const hits = parsed.data.hits?.hits ?? [];
    const results: SecFilingResult[] = [];
    for (const hit of hits) {
      const mapped = toSecFilingResult(hit);
      if (mapped) results.push(mapped);
    }

    const limit = params.limit && params.limit > 0 ? params.limit : results.length;
    return { data: results.slice(0, limit) };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn(SEC_UA_HINT, { query, err: err.message, status: err.status });
      return { data: [], error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn(SEC_UA_HINT, { query, err: err instanceof Error ? err.message : String(err) });
    return { data: [], error: 'Unexpected response shape from SEC EDGAR' };
  }
}
