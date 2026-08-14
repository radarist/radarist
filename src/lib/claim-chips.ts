/**
 * claim-chips: pure corroboration/claim-chip logic (client-safe)
 *
 * One pure import (`signals/source-identity`) — still client-safe, no I/O.
 * No logger, no Zod. Used by client components (Tasks 9, 10, 19).
 *
 * Distinct-source counting rule (display-side):
 * key = canonical publisher identity of sourceUrl ?? documentId ?? signalId ?? id
 * A `sourceUrl` is keyed by its CANONICAL PUBLISHER IDENTITY, not the raw
 * string, so http/https aliases and tracking-parameter variants of one article
 * collapse to a single source. Unresolved Google grounding redirects share one
 * reserved bucket: two such URLs may alias the same article, so they can never
 * be counted as independent corroboration (GRAPH-070).
 * Items with sourceType 'user_assertion', 'edge_annotation', or 'entity_field'
 * are EXCLUDED from counts. Entity fields are first-party entity content, not
 * an independent corroborating source.
 * Items with no key fields at all (all undefined) are SKIPPED from counting.
 */

import {
  canonicalHttpUrl,
  isUnresolvedGoogleGroundingRedirect,
  UNRESOLVED_GROUNDING_REDIRECT_KEY,
} from './signals/source-identity';

export interface ClaimEvidenceLike {
  sourceType?: string;
  sourceUrl?: string;
  documentId?: string;
  signalId?: string;
  entityId?: string;
  entityType?: string;
  entityField?: string;
  id?: string;
}

export type CorroborationLevel = 'corroborated' | 'single' | 'unverified';

export interface ClaimChip {
  relationId: string;
  statement: string;
  kind: 'curated' | CorroborationLevel;
  independentSourceCount: number;
}

/**
 * Reduce a raw `sourceUrl` to the key it counts under.
 *
 * Canonical publisher identity when the URL is a usable http(s) URL; the shared
 * unresolved-redirect bucket when it is a Google grounding redirect we have not
 * resolved to a publisher; the raw string when it cannot be parsed at all
 * (keeping unusable values distinct rather than silently under-counting).
 */
function corroborationUrlKey(sourceUrl: string): string {
  const canonical = canonicalHttpUrl(sourceUrl);
  if (!canonical) return sourceUrl;
  return isUnresolvedGoogleGroundingRedirect(canonical) ? UNRESOLVED_GROUNDING_REDIRECT_KEY : canonical.identity;
}

/**
 * computeCorroboration: derive distinct source count and corroboration level.
 *
 * Excludes 'user_assertion', 'edge_annotation', and first-party
 * 'entity_field' evidence from counts.
 * Key precedence: sourceUrl > documentId > signalId > id, where sourceUrl is
 * reduced to canonical publisher identity first (GRAPH-070).
 * Items with no key fields are skipped from counting.
 *
 * Levels:
 * - 0 distinct sources → 'unverified'
 * - 1 distinct source  → 'single'
 * - 2+ distinct sources → 'corroborated'
 */
export function computeCorroboration(evidence: ClaimEvidenceLike[]): {
  independentSourceCount: number;
  level: CorroborationLevel;
} {
  const distinctKeys = new Set<string>();

  for (const item of evidence) {
    // Skip excluded sourceTypes
    if (
      item.sourceType === 'user_assertion' ||
      item.sourceType === 'edge_annotation' ||
      item.sourceType === 'entity_field'
    ) {
      continue;
    }

    // Derive distinct key with precedence: sourceUrl > documentId > signalId > id.
    // sourceUrl is keyed by canonical publisher identity so aliasing URLs — and
    // in particular unresolved grounding redirects — cannot inflate the count.
    const key =
      (item.sourceUrl !== undefined ? corroborationUrlKey(item.sourceUrl) : undefined) ??
      item.documentId ??
      item.signalId ??
      item.id;

    // Skip items with no key fields
    if (key === undefined) {
      continue;
    }

    distinctKeys.add(key);
  }

  const independentSourceCount = distinctKeys.size;
  const level: CorroborationLevel =
    independentSourceCount === 0 ? 'unverified' : independentSourceCount === 1 ? 'single' : 'corroborated';

  return { independentSourceCount, level };
}

/**
 * deriveClaimChip: transform claim + evidence into a ClaimChip.
 *
 * kind determination:
 * - If asserterType === 'user' OR status === 'curated', kind = 'curated'
 * - Otherwise kind = corroboration level from evidence
 *
 * relationId = claim.relationId ?? claim.id ?? ''
 * statement = claim.statement ?? ''
 * independentSourceCount = computed from evidence
 */
export function deriveClaimChip(
  claim: {
    relationId?: string;
    id?: string;
    statement?: string;
    asserterType?: string;
    status?: string;
  },
  evidence: ClaimEvidenceLike[]
): ClaimChip {
  // Determine kind: curated wins
  const isCurated = claim.asserterType === 'user' || claim.status === 'curated';
  const { independentSourceCount, level } = computeCorroboration(evidence);
  const kind: ClaimChip['kind'] = isCurated ? 'curated' : level;

  // Derive relationId, statement, independentSourceCount
  const relationId = claim.relationId ?? claim.id ?? '';
  const statement = claim.statement ?? '';

  return {
    relationId,
    statement,
    kind,
    independentSourceCount,
  };
}
