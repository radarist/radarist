/**
 * @file lib/research/hn.ts
 * @description Keyless Hacker News search via the HN Algolia API. Server-only
 * (uses `politeFetch` + the public HN Algolia search endpoint).
 *
 * Contract (per the Research-Capability Lift plan, Task A5; error/empty
 * discriminator added in the final-review pass):
 * - `searchHackerNews` never throws to the caller: the fetch + mapping is
 *   wrapped in try/catch and returns `{ data: [] }` on any failure (upstream
 *   error, malformed/schema-invalid response) — with `error` set to a short
 *   human message so a caller can tell "the source failed" from "the source
 *   had nothing."
 * - Schema is lenient: only the consumed fields, everything
 *   `.optional()/.nullable()`, `.passthrough()` — upstream shape drift never
 *   crashes a fetch (it surfaces as `error`, not a throw).
 * - Field renames per the spec: `num_comments` → `numComments`,
 *   `created_at` → `createdAt`; `points`/`num_comments` default to 0 when
 *   the API omits them.
 * - Entries missing a title or objectID are skipped rather than emitted
 *   half-populated.
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, ResearchFetchError } from './http';
import type { HackerNewsResult, ResearchOutcome } from './types';

const log = createLogger('research/hn');

export interface SearchHackerNewsParams {
  query: string;
  limit?: number;
  tags?: string;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_TAGS = 'story';

const HnHitSchema = z
  .object({
    objectID: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    points: z.number().nullable().optional(),
    num_comments: z.number().nullable().optional(),
    author: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();

const HnResponseSchema = z.object({ hits: z.array(HnHitSchema).nullable().optional() }).passthrough();

/**
 * Assemble a `HackerNewsResult`. Returns `null` when the hit lacks the
 * minimum required fields (objectID + title) so it is skipped rather than
 * emitted half-populated.
 */
function toHnResult(hit: z.infer<typeof HnHitSchema>): HackerNewsResult | null {
  const objectID = hit.objectID?.trim();
  const title = hit.title?.trim();
  if (!objectID || !title) return null;

  return {
    title,
    url: hit.url ?? null,
    points: hit.points ?? 0,
    numComments: hit.num_comments ?? 0,
    author: hit.author?.trim() ?? '',
    createdAt: hit.created_at ?? '',
    objectID,
  };
}

/**
 * Search Hacker News (stories/comments) via the HN Algolia API. Never
 * throws — degrades to `{ data: [], error: <message> }` on any upstream
 * error or schema-invalid response; a genuine zero-hit search returns
 * `{ data: [] }` with `error` undefined.
 */
export async function searchHackerNews(params: SearchHackerNewsParams): Promise<ResearchOutcome<HackerNewsResult[]>> {
  const query = params.query?.trim();
  if (!query) return { data: [] };

  const limit = params.limit && params.limit > 0 ? params.limit : DEFAULT_LIMIT;
  const tags = params.tags?.trim() || DEFAULT_TAGS;

  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=${encodeURIComponent(
      tags
    )}&hitsPerPage=${limit}`;

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = HnResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('HN Algolia response failed schema validation', { issues: parsed.error.issues.length });
      return { data: [], error: 'Unexpected response shape from HN Algolia' };
    }

    const results: HackerNewsResult[] = [];
    for (const hit of parsed.data.hits ?? []) {
      const mapped = toHnResult(hit);
      if (mapped) results.push(mapped);
    }
    return { data: results };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('HN Algolia fetch failed', { err: err.message, status: err.status });
      return { data: [], error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn('HN Algolia fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return { data: [], error: 'Unexpected response shape from HN Algolia' };
  }
}
