/**
 * @file resolve-entity.ts
 * @description Best-effort entity resolver for chat-facing graph tools.
 *
 * Accepts either a Neo4j id or a human name / fragment. Returns the best
 * match plus close alternatives, so tool callers can either proceed with the
 * resolved node OR surface a structured "did you mean" response to the LLM.
 *
 * Used by src/lib/ai/tools/graph-tools.ts findGraphPath — earlier behaviour
 * was to pass the raw string to Neo4j and silently return null, which the
 * chat model read as "no path exists".
 */
import { runReadTransaction } from './neo4j-client';
import {
  businessEntityIdentityCypher,
  businessEntityIdentityParams,
  businessEntityLabelProjection,
} from './business-entity-identity';

export interface ResolvedEntity {
  id: string;
  name: string;
  type: string;
}

export interface ResolveEntityOutcome {
  input: string;
  match: ResolvedEntity | null;
  suggestions: ResolvedEntity[];
}

/**
 * Resolve a string that may be a Neo4j node id or a name fragment.
 *
 * Strategy:
 *   1. Exact id match — MATCH (n:Entity {id: $input})
 *   2. Exact name match (case-insensitive) — toLower(n.name) = toLower($input)
 *   3. Fuzzy CONTAINS on name or title, ranked by length (shorter = tighter)
 *
 * The first strategy that yields a single hit wins. Up to `suggestionLimit`
 * other candidates are always returned so the caller can surface them.
 */
export async function resolveEntityByIdOrName(input: string, suggestionLimit = 5): Promise<ResolveEntityOutcome> {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) return { input, match: null, suggestions: [] };

  // 1. Exact id
  //
  // AI-026: `:Entity` alone kept `:AgentObservation` out (they carry no `:Entity`
  // label), but `coalesce(n.entityType, head(labels(n)))` still preferred the
  // property for the reported type, and the scan admitted any node that had
  // acquired `:Entity` alongside a foreign label. Both are now label-decided.
  const byId = await runReadTransaction<{ id: string; name: string; type: string }>(
    `MATCH (n:Entity {id: $input})
     WHERE ${businessEntityIdentityCypher('n')}
     RETURN n.id AS id, coalesce(n.name, n.title, n.id) AS name,
            coalesce(${businessEntityLabelProjection('n')}, n.entityType) AS type
     LIMIT 1`,
    { input: trimmed, ...businessEntityIdentityParams() }
  );
  if (byId.records.length > 0) {
    const row = byId.records[0];
    return {
      input,
      match: { id: row.id, name: row.name, type: row.type },
      suggestions: [],
    };
  }

  // 2 + 3. Name-based lookup with ranking — exact case-insensitive match
  //    first, then CONTAINS matches ordered by target-string length so
  //    shorter names (tighter matches) rank higher.
  const byName = await runReadTransaction<{ id: string; name: string; type: string; score: number }>(
    `MATCH (n:Entity)
     WHERE ${businessEntityIdentityCypher('n')}
     WITH n, toLower(coalesce(n.name, n.title, '')) AS hay, toLower($input) AS needle
     WHERE hay = needle OR hay CONTAINS needle
     WITH n, hay, needle,
          CASE WHEN hay = needle THEN 0 ELSE size(hay) - size(needle) END AS score
     RETURN n.id AS id, coalesce(n.name, n.title, n.id) AS name,
            coalesce(${businessEntityLabelProjection('n')}, n.entityType) AS type, score
     ORDER BY score ASC LIMIT toInteger($limit)`,
    { input: trimmed, limit: suggestionLimit + 1, ...businessEntityIdentityParams() }
  );

  const rows = byName.records.map((r) => ({ id: r.id, name: r.name, type: r.type }));
  if (rows.length === 0) {
    return { input, match: null, suggestions: [] };
  }

  return {
    input,
    match: rows[0],
    suggestions: rows.slice(1, suggestionLimit + 1),
  };
}
