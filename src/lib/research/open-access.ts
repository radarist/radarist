/**
 * @file lib/research/open-access.ts
 * @description Keyless-adjacent open-access resolution via Unpaywall. Server-only
 * (uses `politeFetch` + the public Unpaywall API).
 *
 * Contract (per the Research-Capability Lift plan, Task A4; error/empty
 * discriminator added in the final-review pass):
 * - Unpaywall REQUIRES a contact email (`?email=`) — this is the one source in
 *   the primary-source-research family that is not fully keyless. When
 *   `RESEARCH_CONTACT_EMAIL` is unset, `resolveOpenAccess` returns a typed
 *   `version: 'email-not-configured'` result WITHOUT ever calling fetch, and
 *   logs the reason. This guard runs FIRST, before any network attempt. This
 *   is a configuration state, not an upstream failure, so `error` is left
 *   unset — the typed `version` value is itself the signal.
 * - Otherwise: `politeFetch` → lenient Zod `safeParse` (only the consumed
 *   fields, everything `.optional()/.nullable()`, `.passthrough()`) → map
 *   `{ is_oa, best_oa_location: { url_for_pdf, host_type, version } }` to
 *   `OpenAccessResult`.
 * - Never throws to the caller: upstream errors and schema-invalid responses
 *   both degrade to the typed non-OA default `{ isOA: false, pdfUrl: null,
 *   hostType: null, version: null }` — with `error` set to a short human
 *   message so a caller can tell "the source failed" from "genuinely not
 *   open access."
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { politeFetch, getResearchContactEmail, ResearchFetchError } from './http';
import type { OpenAccessResult, ResearchOutcome } from './types';

const log = createLogger('research/open-access');

export interface ResolveOpenAccessParams {
  doi: string;
}

/** Returned when the caller passes a blank DOI, or on any upstream failure. */
const NON_OA_DEFAULT: OpenAccessResult = {
  isOA: false,
  pdfUrl: null,
  hostType: null,
  version: null,
};

/** Returned when `RESEARCH_CONTACT_EMAIL` is unset — Unpaywall requires an email. */
const EMAIL_NOT_CONFIGURED: OpenAccessResult = {
  isOA: false,
  pdfUrl: null,
  hostType: null,
  version: 'email-not-configured',
};

const UnpaywallResponseSchema = z
  .object({
    is_oa: z.boolean().nullable().optional(),
    best_oa_location: z
      .object({
        url_for_pdf: z.string().nullable().optional(),
        host_type: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Resolve open-access status + PDF location for a DOI via Unpaywall.
 * Never throws — degrades to a typed non-OA default (with `error` set) on
 * any upstream/schema failure, and to a distinguishable
 * `version: 'email-not-configured'` default (no `error` — it's a
 * configuration state, not a failure) when `RESEARCH_CONTACT_EMAIL` is unset
 * (Unpaywall requires an email; we never call it without one).
 */
export async function resolveOpenAccess(params: ResolveOpenAccessParams): Promise<ResearchOutcome<OpenAccessResult>> {
  const doi = params.doi?.trim();
  if (!doi) return { data: NON_OA_DEFAULT };

  const email = getResearchContactEmail();
  if (!email) {
    log.warn('RESEARCH_CONTACT_EMAIL is unset; Unpaywall requires an email — skipping fetch', { doi });
    return { data: EMAIL_NOT_CONFIGURED };
  }

  try {
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
    const res = await politeFetch(url);
    const json: unknown = await res.json();
    const parsed = UnpaywallResponseSchema.safeParse(json);
    if (!parsed.success) {
      log.warn('Unpaywall response failed schema validation', { doi, issues: parsed.error.issues.length });
      return { data: NON_OA_DEFAULT, error: 'Unexpected response shape from Unpaywall' };
    }

    const location = parsed.data.best_oa_location;
    return {
      data: {
        isOA: parsed.data.is_oa ?? false,
        pdfUrl: location?.url_for_pdf ?? null,
        hostType: location?.host_type ?? null,
        version: location?.version ?? null,
      },
    };
  } catch (err) {
    if (err instanceof ResearchFetchError) {
      log.warn('Unpaywall fetch failed', { doi, err: err.message, status: err.status });
      return { data: NON_OA_DEFAULT, error: `Upstream request failed (${err.status ?? 'network'}): ${err.message}` };
    }
    log.warn('Unpaywall fetch failed', { doi, err: err instanceof Error ? err.message : String(err) });
    return { data: NON_OA_DEFAULT, error: 'Unexpected response shape from Unpaywall' };
  }
}
