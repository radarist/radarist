import { runReadTransaction } from './neo4j-client';

/**
 * Counts Assertions whose scalar topology and structural role edges disagree.
 *
 * Keep this query in the graph library so scheduled diagnostics and the
 * operator benchmark cannot drift into different definitions of integrity.
 */
export const ASSERTION_STRUCTURAL_DRIFT_CYPHER = `
  MATCH (a:Assertion)
  WITH a,
       [(a)-[:ABOUT_SUBJECT]->(s) | s.id] AS subjects,
       [(a)-[:ABOUT_OBJECT]->(o) | o.id] AS objects,
       [(a)-[:HAS_PREDICATE]->(p:RelationType) | p.name] AS predicates,
       [(a)-[:ASSERTED_BY]->(actor) | actor.id] AS actors
  WHERE coalesce(a.subjectId, '') = '' OR coalesce(head(subjects), '') = ''
     OR coalesce(a.objectId, '') = '' OR coalesce(head(objects), '') = ''
     OR coalesce(a.predicate, '') = '' OR coalesce(head(predicates), '') = ''
     OR coalesce(a.assertedBy, '') = '' OR coalesce(head(actors), '') = ''
     OR size(subjects) <> 1 OR head(subjects) <> a.subjectId
     OR size(objects) <> 1 OR head(objects) <> a.objectId
     OR size(predicates) <> 1 OR head(predicates) <> a.predicate
     OR size(actors) <> 1 OR head(actors) <> a.assertedBy
  RETURN count(a) AS c
`;

/** Read-only operational diagnostic. Repair remains an explicit operator action. */
export async function countAssertionStructuralDrift(): Promise<number> {
  const result = await runReadTransaction<{ c: number }>(ASSERTION_STRUCTURAL_DRIFT_CYPHER);
  return result.records[0]?.c ?? 0;
}
