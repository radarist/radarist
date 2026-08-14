/**
 * @file lib/research/oss-health.ts
 * @description Keyless OSS repository health lookup via the Ecosyste.ms
 * repos API. Server-only (uses `politeFetch` + the public
 * `repos.ecosyste.ms` API).
 *
 * Contract (per the Research-Capability Lift plan, Task A7; error/empty
 * discriminator added in the final-review pass):
 * - `searchOssHealth` never throws to the caller: parsing + the fetch +
 *   mapping are wrapped so any failure (unparsable input, upstream error,
 *   404, malformed/schema-invalid response) degrades to a typed empty
 *   result — all metrics `null`, but `attribution` is ALWAYS the constant
 *   `'Data: Ecosyste.ms (CC-BY-SA 4.0)'` (Ecosyste.ms data is CC-BY-SA;
 *   the attribution must survive even total failure so a caller never
 *   surfaces Ecosyste.ms data without it). Unparsable non-blank input and
 *   upstream/schema failures (including a 404 for a repo that doesn't exist)
 *   all set `error`; a blank input (nothing given) and a successful lookup
 *   that legitimately has null metrics do not.
 * - `repoOrPackage` accepts a bare `owner/repo` or a full GitHub URL
 *   (`https://github.com/owner/repo[.git]`); anything that doesn't resolve
 *   to an `owner/repo` pair short-circuits without ever calling fetch.
 * - Schema is lenient: only the consumed fields, everything
 *   `.optional()/.nullable()`, `.passthrough()` — upstream shape drift never
 *   crashes a fetch.
 * - Missing metrics map to `null`, never invented/defaulted to 0.
 *
 * Live-verified real shape (confirmed against a live
 * `repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/{owner}/{repo}`
 * response):
 * ```
 * {
 *   stargazers_count: 140197,
 *   pushed_at: "2026-07-01T08:49:07.000Z",
 *   commit_stats: { total_commits: 26011, total_committers: 3632, dds: 0.88 },
 *   scorecard: { score: null }
 * }
 * ```
 * The repos endpoint does not offer `downloads`, `dependent_repos_count`, or
 * `advisories_count` — those three map to `null` unconditionally rather than
 * being invented from a field that doesn't exist on this endpoint.
 * `contributors` comes from `commit_stats.total_committers` (there is no
 * top-level `contributors_count`), and `maintenanceScore` from
 * `scorecard.score` (frequently `null` upstream — an honest gap, not a bug).
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, getResearchContactEmail, ResearchFetchError } from './http';
import type { OssHealthResult, ResearchOutcome } from './types';

const log = createLogger('research/oss-health');

export interface SearchOssHealthParams {
  repoOrPackage: string;
}

const ATTRIBUTION = 'Data: Ecosyste.ms (CC-BY-SA 4.0)';

const OWNER_REPO_ERROR = 'Expected an "owner/repo" slug (e.g. "pgvector/pgvector").';

/** All-null metrics + the mandatory attribution; `name` is filled by the caller. */
function emptyResult(name: string): OssHealthResult {
  return {
    name,
    stars: null,
    contributors: null,
    lastCommit: null,
    downloads: null,
    dependentsCount: null,
    advisories: null,
    maintenanceScore: null,
    attribution: ATTRIBUTION,
  };
}

const EcosystemsRepoSchema = z
  .object({
    full_name: z.string().nullable().optional(),
    stargazers_count: z.number().nullable().optional(),
    pushed_at: z.string().nullable().optional(),
    commit_stats: z
      .object({
        total_commits: z.number().nullable().optional(),
        total_committers: z.number().nullable().optional(),
        dds: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    scorecard: z
      .object({
        score: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Parse an `owner/repo` pair out of a bare `owner/repo` string or a full
 * GitHub URL (`https://github.com/owner/repo[.git][/...]`). Returns `null`
 * when no owner/repo pair can be recovered.
 */
function parseOwnerRepo(input: string): { owner: string; repo: string } | null {
  let path = input.trim();

  // Strip a github.com URL prefix (protocol + host) if present.
  path = path.replace(/^https?:\/\/(www\.)?github\.com\//i, '');

  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!owner || !repo) return null;

  return { owner, repo };
}

/**
 * Look up OSS repository health metrics via the Ecosyste.ms repos API.
 * Never throws — degrades to a typed empty result (attribution set, all
 * metrics null) on unparsable input, an upstream error, or a
 * schema-invalid response, with `error` set on all three of those paths so a
 * caller can tell "the lookup failed" from "nothing was asked for." A blank
 * input short-circuits to the same typed empty result WITHOUT `error` — no
 * repo was asked for, so there is nothing to fail.
 */
export async function searchOssHealth(params: SearchOssHealthParams): Promise<ResearchOutcome<OssHealthResult>> {
  const raw = params.repoOrPackage?.trim() ?? '';
  if (!raw) return { data: emptyResult('') };

  const parsed = parseOwnerRepo(raw);
  if (!parsed) {
    log.warn('could not parse owner/repo from input; skipping fetch', { repoOrPackage: raw });
    return { data: emptyResult(raw), error: OWNER_REPO_ERROR };
  }

  const { owner, repo } = parsed;
  const fallbackName = `${owner}/${repo}`;

  try {
    let url = `https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repo)}`;
    const email = getResearchContactEmail();
    if (email) url += `?mailto=${encodeURIComponent(email)}`;

    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const validated = EcosystemsRepoSchema.safeParse(json);
    if (!validated.success) {
      log.warn('Ecosyste.ms response failed schema validation', {
        repoOrPackage: fallbackName,
        issues: validated.error.issues.length,
      });
      return { data: emptyResult(fallbackName), error: 'Unexpected response shape from Ecosyste.ms' };
    }

    const data = validated.data;
    return {
      data: {
        name: data.full_name?.trim() || fallbackName,
        stars: data.stargazers_count ?? null,
        contributors: data.commit_stats?.total_committers ?? null,
        lastCommit: data.pushed_at ?? null,
        // Not offered by the repos endpoint — never invented.
        downloads: null,
        dependentsCount: null,
        advisories: null,
        maintenanceScore: data.scorecard?.score ?? null,
        attribution: ATTRIBUTION,
      },
    };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('Ecosyste.ms fetch failed', { repoOrPackage: fallbackName, err: err.message, status: err.status });
      return {
        data: emptyResult(fallbackName),
        error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}`,
      };
    }
    log.warn('Ecosyste.ms fetch failed', {
      repoOrPackage: fallbackName,
      err: err instanceof Error ? err.message : String(err),
    });
    return { data: emptyResult(fallbackName), error: 'Unexpected response shape from Ecosyste.ms' };
  }
}
