/**
 * @file ai/tools/helpers/resolve-entity-endpoint.ts
 * @description The ONE rule for turning an entity NAME into a single, exact
 * write endpoint.
 *
 * A tool that mutates a named entity must never act on a guess. This resolver
 * accepts only ONE unique normalized-exact name match; a partial match, several
 * partial matches, or several records sharing the same exact name all fail, and
 * the failure carries the candidates so the caller can ask for an id instead.
 *
 * Extracted from the policy `linkDocumentToEntity` established inline, so the
 * batch relation writer applies the identical rule rather than a second
 * hand-rolled copy — that is exactly how a "unique exact endpoint" guarantee
 * silently becomes a fuzzy one. (`linkDocumentToEntity` keeps its own branch for
 * now: it returns a richer per-case `matchingEntities` payload that its callers
 * render. Both enforce the same rule; this module is the canonical statement of
 * it for new call sites.)
 */

import 'server-only';

import { normalizeEntityReferenceName, searchEntityCandidatesByName } from '../entity-creation';

export interface EntityCandidate {
  id: string;
  name: string;
}

export type EntityEndpointFailure =
  /** `searchEntityCandidatesByName` has no reader for this entity type. */
  | { kind: 'unsupported-type'; entityType: string; name: string }
  /** Nothing matched the name at all. */
  | { kind: 'not-found'; entityType: string; name: string }
  /** Several records share the same exact normalized name — an id is required. */
  | { kind: 'ambiguous-exact'; entityType: string; name: string; candidates: EntityCandidate[] }
  /** Candidates exist but none matches exactly — the caller must be precise. */
  | { kind: 'no-exact-match'; entityType: string; name: string; candidates: EntityCandidate[] };

export type EntityEndpointResolution =
  { resolved: true; id: string; name: string } | { resolved: false; failure: EntityEndpointFailure };

/**
 * Resolve `name` to exactly one `entityType` record, or explain why it could not.
 * Never throws for a resolution outcome; a reader failure propagates unchanged.
 */
export async function resolveEntityEndpointByExactName(
  entityType: string,
  name: string
): Promise<EntityEndpointResolution> {
  const candidates = await searchEntityCandidatesByName(entityType, name, { prioritizeNormalizedExact: true });
  if (candidates === null) {
    return { resolved: false, failure: { kind: 'unsupported-type', entityType, name } };
  }

  const normalized = normalizeEntityReferenceName(name);
  const exactMatches = candidates.filter((candidate) => normalizeEntityReferenceName(candidate.name) === normalized);

  if (exactMatches.length > 1) {
    return { resolved: false, failure: { kind: 'ambiguous-exact', entityType, name, candidates: exactMatches } };
  }

  const chosen = exactMatches[0];
  if (chosen) return { resolved: true, id: chosen.id, name: chosen.name };

  if (candidates.length === 0) {
    return { resolved: false, failure: { kind: 'not-found', entityType, name } };
  }
  return { resolved: false, failure: { kind: 'no-exact-match', entityType, name, candidates } };
}

/** One actionable sentence naming the failure and what to supply instead. */
export function describeEntityEndpointFailure(failure: EntityEndpointFailure): string {
  const listCandidates = (candidates: EntityCandidate[]): string =>
    candidates.map((candidate) => `"${candidate.name}" (id: ${candidate.id})`).join(', ');

  switch (failure.kind) {
    case 'unsupported-type':
      return `"${failure.entityType}" cannot be looked up by name; supply the entity id instead.`;
    case 'not-found':
      return `No ${failure.entityType} found with name "${failure.name}".`;
    case 'ambiguous-exact':
      return `Multiple ${failure.entityType} records have the exact name "${failure.name}" — supply the id: ${listCandidates(
        failure.candidates
      )}.`;
    case 'no-exact-match':
      return `No exact ${failure.entityType} name match for "${failure.name}". Closest: ${listCandidates(
        failure.candidates
      )}. Use the exact name or the id.`;
  }
}
