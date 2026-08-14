/**
 * Shared Cypher fragments for surfaces that promise the current graph.
 * Historical/audit queries deliberately do not use these helpers.
 *
 * This module is client-safe so Graph Explorer presets and server readers use
 * exactly the same invalidated/rejected rule.
 */
function assertCypherAlias(alias: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid internal Cypher alias: ${alias}`);
  }
  return alias;
}

export function currentEdgePredicate(alias: string): string {
  const safeAlias = assertCypherAlias(alias);
  return `${safeAlias}.t_invalidated IS NULL AND coalesce(${safeAlias}.claimStatus, 'curated') <> 'rejected'`;
}

export function currentPathPredicate(pathAlias: string, relationshipAlias = 'currentRel'): string {
  const safePathAlias = assertCypherAlias(pathAlias);
  const safeRelationshipAlias = assertCypherAlias(relationshipAlias);
  return `ALL(${safeRelationshipAlias} IN relationships(${safePathAlias}) WHERE ${currentEdgePredicate(
    safeRelationshipAlias
  )})`;
}
