import { runWriteTransaction } from '@/lib/graph/neo4j-client';

export interface EdgeRule {
  relationship: string;
  targetLabel: string;
  sourceProperty: string;
  isArray?: boolean;
  /** 'outgoing' = (source)-[:REL]->(target), 'incoming' = (target)-[:REL]->(source) */
  direction: 'outgoing' | 'incoming';
  targetProperty?: string;
}

const EDGE_RULES: Record<string, EdgeRule[]> = {
  Chunk: [{ relationship: 'CONTAINS', targetLabel: 'Document', sourceProperty: 'documentId', direction: 'incoming' }],
  // Mission IDs are correlation properties, not Entity IDs. Episode ownership
  // therefore remains property-based; only a real User node is edge-eligible.
  Episode: [{ relationship: 'BELONGS_TO', targetLabel: 'User', sourceProperty: 'userId', direction: 'outgoing' }],
  AgentRun: [
    { relationship: 'EXECUTED', targetLabel: 'User', sourceProperty: 'userId', direction: 'incoming' },
    // EXECUTED_DURING is identity-critical and is converged atomically by
    // agent-run-sync.ts. It must not use this best-effort generic helper.
  ],
  AgentObservation: [
    { relationship: 'ABOUT', targetLabel: 'Entity', sourceProperty: 'entityId', direction: 'outgoing' },
  ],
  RadarPlacement: [
    { relationship: 'PLACES', targetLabel: 'Technology', sourceProperty: 'technologyId', direction: 'outgoing' },
    { relationship: 'ON_RADAR', targetLabel: 'Radar', sourceProperty: 'radarId', direction: 'outgoing' },
  ],
  Concept: [
    { relationship: 'PARENT_CONCEPT', targetLabel: 'Concept', sourceProperty: 'parentId', direction: 'outgoing' },
    // HAS_CONCEPT edges require Firestore cross-query (entities have conceptIds, not concepts having entityIds).
    // Created via sync-concept-to-neo4j.ts or backfill, not ensure-edges.
  ],
  Document: [
    {
      relationship: 'MENTIONS',
      targetLabel: 'Entity',
      sourceProperty: 'mentionedEntityIds',
      isArray: true,
      direction: 'outgoing',
    },
  ],
  Session: [{ relationship: 'BELONGS_TO', targetLabel: 'User', sourceProperty: 'userId', direction: 'outgoing' }],
  VerificationResult: [
    { relationship: 'VERIFIES', targetLabel: 'Entity', sourceProperty: 'entityId', direction: 'outgoing' },
  ],
  CuriosityGap: [
    {
      relationship: 'RELEVANT_TO',
      targetLabel: 'Entity',
      sourceProperty: 'entityIds',
      isArray: true,
      direction: 'outgoing',
    },
    { relationship: 'FOR_MISSION', targetLabel: 'Entity', sourceProperty: 'missionId', direction: 'outgoing' },
  ],
  // Discovery loop (P0): the per-user interest learning store. The PROFILE_FOR
  // edge is MERGEd inline by interest-profile.ts (upsert/touch), which is its
  // sole writer. This entry is the canonical registry record only — it is NOT a
  // valid `ensureEdgesForNode` path: that helper matches the source by `id`,
  // but InterestProfile is keyed by `userId` (no `id` property), so a call would
  // silently no-op. Do not wire ensureEdgesForNode('…','InterestProfile',…).
  InterestProfile: [
    { relationship: 'PROFILE_FOR', targetLabel: 'User', sourceProperty: 'userId', direction: 'outgoing' },
  ],
};

export function getEdgeRulesForType(nodeType: string): EdgeRule[] {
  return EDGE_RULES[nodeType] ?? [];
}

export async function ensureEdgesForNode(
  nodeId: string,
  nodeType: string,
  properties: Record<string, unknown>
): Promise<{ edgesCreated: number }> {
  const rules = getEdgeRulesForType(nodeType);
  if (rules.length === 0) return { edgesCreated: 0 };

  let totalEdges = 0;

  for (const rule of rules) {
    const sourceValue = properties[rule.sourceProperty];
    if (sourceValue === undefined || sourceValue === null) continue;

    const targetProp = rule.targetProperty ?? 'id';

    try {
      if (rule.isArray && Array.isArray(sourceValue)) {
        if (sourceValue.length === 0) continue;
        const cypher =
          rule.direction === 'outgoing'
            ? `MATCH (src {id: $nodeId}) WHERE $nodeType IN labels(src)
               UNWIND $ids AS targetId
               MATCH (tgt:${rule.targetLabel} {${targetProp}: targetId})
               MERGE (src)-[:${rule.relationship}]->(tgt)
               RETURN count(*) AS edgesCreated`
            : `MATCH (src {id: $nodeId}) WHERE $nodeType IN labels(src)
               UNWIND $ids AS targetId
               MATCH (tgt:${rule.targetLabel} {${targetProp}: targetId})
               MERGE (tgt)-[:${rule.relationship}]->(src)
               RETURN count(*) AS edgesCreated`;
        const result = await runWriteTransaction<{ edgesCreated: number }>(cypher, {
          nodeId,
          nodeType,
          ids: sourceValue,
        });
        totalEdges += result.records?.[0]?.edgesCreated ?? 0;
      } else {
        const cypher =
          rule.direction === 'outgoing'
            ? `MATCH (src {id: $nodeId}) WHERE $nodeType IN labels(src)
               MATCH (tgt:${rule.targetLabel} {${targetProp}: $targetId})
               MERGE (src)-[:${rule.relationship}]->(tgt)
               RETURN count(*) AS edgesCreated`
            : `MATCH (src {id: $nodeId}) WHERE $nodeType IN labels(src)
               MATCH (tgt:${rule.targetLabel} {${targetProp}: $targetId})
               MERGE (tgt)-[:${rule.relationship}]->(src)
               RETURN count(*) AS edgesCreated`;
        const result = await runWriteTransaction<{ edgesCreated: number }>(cypher, {
          nodeId,
          nodeType,
          targetId: String(sourceValue),
        });
        totalEdges += result.records?.[0]?.edgesCreated ?? 0;
      }
    } catch {
      // Edge creation is best-effort — never break the caller
    }
  }

  return { edgesCreated: totalEdges };
}
