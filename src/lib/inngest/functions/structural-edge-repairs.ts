/** Metadata minted only when reconciliation creates missing structural wiring. */
const STRUCTURAL_EDGE_ON_CREATE = `
  ON CREATE SET edge.createdAt = timestamp(),
                edge.t_observed = toString(datetime()),
                edge.t_valid = toString(datetime()),
                edge.confidence = 100,
                edge.assertedConfidence = 100,
                edge.effectiveConfidence = 100
`;

export const STRUCTURAL_EDGE_REPAIRS = [
  {
    name: 'Chunks->Documents',
    relationship: 'CONTAINS',
    cypher: `MATCH (c:Chunk) WHERE c.documentId IS NOT NULL AND NOT (c)<-[:CONTAINS]-()
             WITH c MATCH (d:Document {id: c.documentId}) MERGE (d)-[edge:CONTAINS]->(c)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
  {
    name: 'Placements->Technologies',
    relationship: 'PLACES',
    cypher: `MATCH (rp:RadarPlacement) WHERE rp.technologyId IS NOT NULL AND NOT (rp)-[:PLACES]->()
             WITH rp MATCH (t:Technology {id: rp.technologyId}) MERGE (rp)-[edge:PLACES]->(t)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
  {
    name: 'Placements->Radars',
    relationship: 'ON_RADAR',
    cypher: `MATCH (rp:RadarPlacement) WHERE rp.radarId IS NOT NULL AND NOT (rp)-[:ON_RADAR]->()
             WITH rp MATCH (r:Radar {id: rp.radarId}) MERGE (rp)-[edge:ON_RADAR]->(r)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
  {
    name: 'Episodes->Users',
    relationship: 'BELONGS_TO',
    cypher: `MATCH (e:Episode) WHERE e.userId IS NOT NULL AND NOT (e)-[:BELONGS_TO]->()
             MATCH (u:User {id: e.userId}) MERGE (e)-[edge:BELONGS_TO]->(u)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
  {
    name: 'AgentRuns->Users',
    relationship: 'EXECUTED',
    cypher: `MATCH (ar:AgentRun) WHERE ar.userId IS NOT NULL AND NOT (ar)<-[:EXECUTED]-()
             MATCH (u:User {id: ar.userId}) MERGE (u)-[edge:EXECUTED]->(ar)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
  {
    name: 'Observations->Entities',
    relationship: 'ABOUT',
    cypher: `MATCH (ao:AgentObservation) WHERE ao.entityId IS NOT NULL AND NOT (ao)-[:ABOUT]->()
             MATCH (e:Entity {id: ao.entityId}) MERGE (ao)-[edge:ABOUT]->(e)
             ${STRUCTURAL_EDGE_ON_CREATE}
             RETURN count(*) AS fixed`,
  },
] as const;
