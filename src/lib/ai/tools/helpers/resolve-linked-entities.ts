/**
 * @file ai/tools/helpers/resolve-linked-entities.ts
 * @description Resolve model-supplied entity NAMES to company/technology IDs for
 * `Signal.linkedEntities`.
 *
 * AI-040 — this helper used to `await import('@/lib/companies')` and
 * `await import('@/lib/technology-service')`, the Firebase **client**-SDK service
 * barrels. It runs inside the chat tool executor, which is server-side, where the
 * client SDK has no auth context and its `asyncQueue` rejects. Both loaders
 * caught that rejection and returned `[]`, so every name became "unresolvable",
 * `executeCreateSignal` caught the empty result and persisted
 * `linkedEntities: []` — a signal that silently lost every link the user named.
 *
 * Three separate layers were masking the same failure; all three are gone:
 *  1. the per-collection catch that turned a read failure into an empty pool
 *     (now: {@link LinkedEntityLookupError} propagates),
 *  2. the "unresolvable names are dropped silently" contract
 *     (now: every requested name comes back as resolved OR unresolved),
 *  3. the executor's catch-and-continue (now: a fail-visible, zero-mutation
 *     refusal — see `executeCreateSignal`).
 *
 * Reads go through the Admin SDK twins, which is the only supported server-side
 * boundary (see the service-module ESLint rule in `eslint.config.mjs`).
 */

import 'server-only';

import { adminGetCompanies } from '@/lib/companies-admin';
import { adminGetTechnologies } from '@/lib/technology-admin';
import { fuzzySearchWithScores } from '@/lib/fuzzy-search';
import { createLogger } from '@/lib/logger';

const log = createLogger('resolve-linked-entities');

/** Maximum number of names one call may resolve. Over-cap input is refused, never truncated. */
export const LINKED_ENTITY_NAME_CAP = 10;

const SCORE_THRESHOLD = 0.85;

/** Entity kinds a signal may be linked to. */
export type LinkedEntityKind = 'company' | 'technology';

/** One name the caller supplied, resolved to a concrete library record. */
export interface ResolvedLinkedEntity {
  /** The name exactly as the caller supplied it. */
  requestedName: string;
  /** The library record's own name — may differ when the match was fuzzy. */
  matchedName: string;
  id: string;
  kind: LinkedEntityKind;
}

export interface LinkedEntityResolution {
  /** Resolved company IDs, in first-requested order, de-duplicated. */
  companies: string[];
  /** Resolved technology IDs, in first-requested order, de-duplicated. */
  technologies: string[];
  /** Full identity of every resolved name, so callers can report what they linked. */
  resolved: ResolvedLinkedEntity[];
  /** Names that matched no company and no technology above the score threshold. */
  unresolved: string[];
}

/**
 * The company or technology library could not be read, so resolution is
 * INCONCLUSIVE — nothing may be inferred about whether the named entities exist.
 * Distinct from "the name resolved to nothing", which is a definite answer.
 */
export class LinkedEntityLookupError extends Error {
  constructor(
    public readonly collection: LinkedEntityKind,
    cause: unknown
  ) {
    super(
      `Could not read the ${collection} library to resolve linked entity names: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = 'LinkedEntityLookupError';
  }
}

interface NameIdPair {
  id: string;
  name: string;
}

async function loadCompanies(): Promise<NameIdPair[]> {
  try {
    const companies = await adminGetCompanies();
    return companies.map((company) => ({ id: company.id, name: company.name }));
  } catch (error) {
    throw new LinkedEntityLookupError('company', error);
  }
}

async function loadTechnologies(): Promise<NameIdPair[]> {
  try {
    const technologies = await adminGetTechnologies();
    return technologies.map((technology) => ({ id: technology.id, name: technology.name }));
  } catch (error) {
    throw new LinkedEntityLookupError('technology', error);
  }
}

function pickBestMatch(pool: NameIdPair[], name: string): NameIdPair | undefined {
  if (pool.length === 0) return undefined;
  const matches = fuzzySearchWithScores(pool, name, {
    keys: ['name'],
    threshold: SCORE_THRESHOLD,
    limit: 1,
  });
  return matches.length > 0 ? matches[0].item : undefined;
}

/**
 * Resolve up to {@link LINKED_ENTITY_NAME_CAP} names against the company and
 * technology libraries.
 *
 * @throws RangeError when more names than the cap are supplied — the caller must
 * refuse the whole request rather than silently link a truncated subset.
 * @throws LinkedEntityLookupError when a library read fails. A read failure is
 * never reported as "these names do not exist".
 */
export async function resolveLinkedEntityNames(names: readonly string[]): Promise<LinkedEntityResolution> {
  const empty: LinkedEntityResolution = { companies: [], technologies: [], resolved: [], unresolved: [] };
  if (names.length === 0) return empty;
  if (names.length > LINKED_ENTITY_NAME_CAP) {
    throw new RangeError(
      `Too many linked entity names: ${names.length} supplied, at most ${LINKED_ENTITY_NAME_CAP} can be resolved at once.`
    );
  }

  const [companies, technologies] = await Promise.all([loadCompanies(), loadTechnologies()]);

  const resolution: LinkedEntityResolution = { companies: [], technologies: [], resolved: [], unresolved: [] };

  for (const requestedName of names) {
    const trimmed = typeof requestedName === 'string' ? requestedName.trim() : '';
    if (trimmed.length === 0) {
      // Callers validate shape before calling; a blank that reaches here is a
      // definite non-match and must still be reported, never dropped.
      resolution.unresolved.push(String(requestedName));
      continue;
    }

    const company = pickBestMatch(companies, trimmed);
    if (company) {
      if (!resolution.companies.includes(company.id)) resolution.companies.push(company.id);
      resolution.resolved.push({
        requestedName: trimmed,
        matchedName: company.name,
        id: company.id,
        kind: 'company',
      });
      continue;
    }

    const technology = pickBestMatch(technologies, trimmed);
    if (technology) {
      if (!resolution.technologies.includes(technology.id)) resolution.technologies.push(technology.id);
      resolution.resolved.push({
        requestedName: trimmed,
        matchedName: technology.name,
        id: technology.id,
        kind: 'technology',
      });
      continue;
    }

    resolution.unresolved.push(trimmed);
  }

  log.debug('Resolved linked entity names', {
    requested: names.length,
    resolved: resolution.resolved.length,
    unresolved: resolution.unresolved.length,
  });

  return resolution;
}
