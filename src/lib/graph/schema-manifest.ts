/**
 * Neo4j schema manifest — the SINGLE SOURCE OF TRUTH for the graph's
 * constraints, indexes, vector indexes, and seeded relation types.
 *
 * Consumed by:
 *   - scripts/init-neo4j-schema.ts   (applies it; fails loudly on any error)
 *   - src/lib/graph/neo4j-client.ts  (initializeSchema delegates here)
 *   - scripts/graph-health.ts        (assertSchema diffs live SHOW vs expected)
 *
 * This module is dependency-free (plain data + pure functions) so it is safe to
 * import from tsx scripts, the server runtime, and Jest alike.
 *
 * History (CRIT-2 / schema-consolidation, 2026-07-03):
 *   - Previously the schema lived in three places that had drifted apart. The
 *     entity vector indexes (technology/company/signal_embedding) existed only
 *     in an unused legacy Cypher file, so entity semantic search failed.
 *   - The runtime client created assertion schema under the names `claim_*`,
 *     the exact names the init script DROPS as deprecated — a drop/create
 *     collision. Runtime assertion schema is now named `assertion_*`.
 */

// ---------------------------------------------------------------------------
// SCHEMA STATEMENTS
// ---------------------------------------------------------------------------

/** Unique constraints for entity IDs and other identity keys. */
export const CONSTRAINTS: string[] = [
  // Core entities
  'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE',
  'CREATE CONSTRAINT technology_id IF NOT EXISTS FOR (t:Technology) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT company_id IF NOT EXISTS FOR (c:Company) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT usecase_id IF NOT EXISTS FOR (u:UseCase) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT prototype_id IF NOT EXISTS FOR (p:Prototype) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT strategy_id IF NOT EXISTS FOR (s:Strategy) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT signal_id IF NOT EXISTS FOR (s:Signal) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT painpoint_id IF NOT EXISTS FOR (p:PainPoint) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT initiative_id IF NOT EXISTS FOR (i:Initiative) REQUIRE i.id IS UNIQUE',
  'CREATE CONSTRAINT orgunit_id IF NOT EXISTS FOR (o:OrgUnit) REQUIRE o.id IS UNIQUE',

  // Documents & chunks
  'CREATE CONSTRAINT document_id IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE',
  'CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE',

  // Concepts
  'CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE',
  'CREATE CONSTRAINT concept_slug IF NOT EXISTS FOR (c:Concept) REQUIRE c.slug IS UNIQUE',

  // Provenance (was created by neo4j-client under the colliding name `claim_id`)
  'CREATE CONSTRAINT assertion_id IF NOT EXISTS FOR (a:Assertion) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT evidence_id IF NOT EXISTS FOR (e:Evidence) REQUIRE e.id IS UNIQUE',

  // Agents, users, relation-type metadata
  'CREATE CONSTRAINT agent_id IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT reltype_name IF NOT EXISTS FOR (r:RelationType) REQUIRE r.name IS UNIQUE',

  // Graph learning-loop MERGE keys. Each of these is the key a hot write path
  // MERGEs on: interest-profile.ts (ip.userId), relation-assertion-sync.ts
  // (Assertion.relationId), asserter-reliability.ts (AsserterReliability.asserter),
  // community-reports.ts (CommunityReport.id). Previously only ip_userId was
  // constrained, and only inside a manual migration (schema-migrations.ts), so a
  // fresh clone MERGEd these unconstrained until the migration was run by hand.
  // Declaring them here (with the same ip_userId name the migration uses, so the
  // two are idempotent) makes the manifest the single source init applies and
  // graph:health diffs.
  'CREATE CONSTRAINT ip_userId IF NOT EXISTS FOR (ip:InterestProfile) REQUIRE ip.userId IS UNIQUE',
  'CREATE CONSTRAINT assertion_relationId IF NOT EXISTS FOR (a:Assertion) REQUIRE a.relationId IS UNIQUE',
  'CREATE CONSTRAINT asserter_reliability_asserter IF NOT EXISTS FOR (r:AsserterReliability) REQUIRE r.asserter IS UNIQUE',
  'CREATE CONSTRAINT community_report_id IF NOT EXISTS FOR (cr:CommunityReport) REQUIRE cr.id IS UNIQUE',
  // GRAPH-066 — RadarPlacement pair identity. On a clean install these create
  // fresh (no duplicates); on an existing graph the guarded manual migration
  // (2026-07-22-radar-placement-pair-identity) preflights + backfills first.
  'CREATE CONSTRAINT radar_id IF NOT EXISTS FOR (r:Radar) REQUIRE r.id IS UNIQUE',
  'CREATE CONSTRAINT radar_placement_id IF NOT EXISTS FOR (p:RadarPlacement) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT radar_placement_pair_key IF NOT EXISTS FOR (p:RadarPlacement) REQUIRE p.pairKey IS UNIQUE',
];

/** B-tree indexes for common query patterns. */
export const INDEXES: string[] = [
  'CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entityType)',
  'CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name)',
  'CREATE INDEX technology_name IF NOT EXISTS FOR (t:Technology) ON (t.name)',
  'CREATE INDEX company_name IF NOT EXISTS FOR (c:Company) ON (c.name)',
  'CREATE INDEX company_type IF NOT EXISTS FOR (c:Company) ON (c.type)',

  // Provenance (was created by neo4j-client under colliding names `claim_*`)
  'CREATE INDEX assertion_confidence IF NOT EXISTS FOR (a:Assertion) ON (a.confidence)',
  'CREATE INDEX assertion_status IF NOT EXISTS FOR (a:Assertion) ON (a.status)',
  'CREATE INDEX assertion_created IF NOT EXISTS FOR (a:Assertion) ON (a.createdAt)',
  // Endpoint reads use each property independently and combine the two seeks
  // for bidirectional pair lookups. Two single-property RANGE indexes are the
  // minimal Neo4j Community-compatible shape; a composite index would not
  // accelerate object-only reads.
  'CREATE INDEX assertion_subject IF NOT EXISTS FOR (a:Assertion) ON (a.subjectId)',
  'CREATE INDEX assertion_object IF NOT EXISTS FOR (a:Assertion) ON (a.objectId)',
  // explainConnection intentionally preserves a :Claim compatibility branch
  // until the operator runs the manual 2026-04-18 schema migration. Keep that
  // branch bounded too; these can be removed with the runtime branch once a
  // migration receipt is mandatory for every supported workspace.
  'CREATE INDEX legacy_claim_subject IF NOT EXISTS FOR (c:Claim) ON (c.subjectId)',
  'CREATE INDEX legacy_claim_object IF NOT EXISTS FOR (c:Claim) ON (c.objectId)',
  'CREATE INDEX evidence_type IF NOT EXISTS FOR (e:Evidence) ON (e.sourceType)',
  // Evidence accrual key (addEvidenceToAssertion MERGEs on assertionId+sourceKey).
  'CREATE INDEX evidence_assertion_sourcekey IF NOT EXISTS FOR (e:Evidence) ON (e.assertionId, e.sourceKey)',

  // Concepts
  'CREATE INDEX concept_type IF NOT EXISTS FOR (c:Concept) ON (c.type)',
  'CREATE INDEX concept_name IF NOT EXISTS FOR (c:Concept) ON (c.canonicalName)',
  'CREATE INDEX concept_parent IF NOT EXISTS FOR (c:Concept) ON (c.parentId)',
  'CREATE INDEX concept_entity_count IF NOT EXISTS FOR (c:Concept) ON (c.entityCount)',

  // Chunks & documents
  'CREATE INDEX chunk_document_id IF NOT EXISTS FOR (c:Chunk) ON (c.documentId)',
  'CREATE INDEX chunk_archived IF NOT EXISTS FOR (c:Chunk) ON (c.archived)',
  'CREATE INDEX chunk_document_version IF NOT EXISTS FOR (c:Chunk) ON (c.documentVersion)',
  'CREATE INDEX chunk_embedded_at IF NOT EXISTS FOR (c:Chunk) ON (c.embeddedAt)',
  'CREATE INDEX document_domain IF NOT EXISTS FOR (d:Document) ON (d.domain)',
  'CREATE INDEX document_type IF NOT EXISTS FOR (d:Document) ON (d.type)',
  'CREATE INDEX document_status IF NOT EXISTS FOR (d:Document) ON (d.status)',
  'CREATE INDEX document_version IF NOT EXISTS FOR (d:Document) ON (d.version)',
  'CREATE INDEX document_workspace IF NOT EXISTS FOR (d:Document) ON (d.workspaceId)',
  'CREATE INDEX document_linked_count IF NOT EXISTS FOR (d:Document) ON (d.linkedEntityCount)',

  // Discovery-loop learning store (mirrors the ip_userId constraint above; the
  // ip_updatedAt index was previously only created by schema-migrations.ts).
  'CREATE INDEX ip_updatedAt IF NOT EXISTS FOR (ip:InterestProfile) ON (ip.updatedAt)',
];

/** Impulse Context DB schema (agent observations, sessions, insights, verification). */
export const CONTEXT_SCHEMA: string[] = [
  'CREATE CONSTRAINT agent_observation_id IF NOT EXISTS FOR (n:AgentObservation) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT observation_id IF NOT EXISTS FOR (n:Observation) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT curiosity_gap_id IF NOT EXISTS FOR (n:CuriosityGap) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT proactive_insight_id IF NOT EXISTS FOR (n:ProactiveInsight) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT agent_run_id IF NOT EXISTS FOR (n:AgentRun) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT session_id IF NOT EXISTS FOR (n:Session) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE',
  'CREATE INDEX agent_observation_timestamp IF NOT EXISTS FOR (n:AgentObservation) ON (n.timestamp)',
  'CREATE INDEX curiosity_gap_priority IF NOT EXISTS FOR (n:CuriosityGap) ON (n.priority)',
  'CREATE INDEX proactive_insight_user IF NOT EXISTS FOR (n:ProactiveInsight) ON (n.userId)',
  // NOTE (M-series): the sync handler writes `agentName`, not `agentType`. Index the real property.
  'CREATE INDEX agent_run_agent_name IF NOT EXISTS FOR (n:AgentRun) ON (n.agentName)',
  'CREATE INDEX session_user IF NOT EXISTS FOR (n:Session) ON (n.userId)',
  'CREATE INDEX episode_mission IF NOT EXISTS FOR (e:Episode) ON (e.missionId)',
  'CREATE INDEX episode_user IF NOT EXISTS FOR (e:Episode) ON (e.userId)',
  'CREATE INDEX episode_agent IF NOT EXISTS FOR (e:Episode) ON (e.agentName)',
  'CREATE CONSTRAINT verification_result_id IF NOT EXISTS FOR (vr:VerificationResult) REQUIRE vr.id IS UNIQUE',
  'CREATE INDEX verification_entity IF NOT EXISTS FOR (vr:VerificationResult) ON (vr.entityId)',
  'CREATE INDEX verification_status IF NOT EXISTS FOR (vr:VerificationResult) ON (vr.status)',
  'CREATE CONSTRAINT user_preference_id IF NOT EXISTS FOR (up:UserPreference) REQUIRE up.id IS UNIQUE',
  'CREATE CONSTRAINT user_preference_user_topic IF NOT EXISTS FOR (up:UserPreference) REQUIRE (up.userId, up.topic) IS UNIQUE',
  'CREATE CONSTRAINT preference_engagement_receipt_id IF NOT EXISTS FOR (receipt:PreferenceEngagementReceipt) REQUIRE receipt.id IS UNIQUE',
  'CREATE INDEX preference_user IF NOT EXISTS FOR (up:UserPreference) ON (up.userId)',
  'CREATE INDEX preference_topic IF NOT EXISTS FOR (up:UserPreference) ON (up.topic)',
];

/**
 * Vector indexes for semantic similarity search (Neo4j 5.11+, 768-dim cosine).
 * The three entity indexes were previously present only in an unapplied legacy
 * definition; porting them here makes entity semantic search possible.
 */
const VECTOR_INDEX_LABELS: Array<{ name: string; label: string; prop: string }> = [
  { name: 'chunk_embedding', label: 'Chunk', prop: 'embedding' },
  { name: 'technology_embedding', label: 'Technology', prop: 'embedding' },
  { name: 'company_embedding', label: 'Company', prop: 'embedding' },
  { name: 'signal_embedding', label: 'Signal', prop: 'embedding' },
];

export const VECTOR_INDEXES: string[] = VECTOR_INDEX_LABELS.map(
  ({ name, label, prop }) =>
    `CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.${prop}) ` +
    "OPTIONS {indexConfig: {`vector.dimensions`: 768, `vector.similarity_function`: 'cosine'}}"
);

/**
 * Full-text indexes. `entity_name_idx` supports name-based fulltext lookup
 * (`CALL db.index.fulltext.queryNodes("entity_name_idx", …)`) for ad-hoc /
 * NL-generated Cypher. The dedicated SEARCH_NODES_FULLTEXT template was
 * removed as dead code (P4 wire-or-delete) — the index stays because
 * generated queries may still target it.
 */
export const FULLTEXT_INDEXES: string[] = [
  'CREATE FULLTEXT INDEX entity_name_idx IF NOT EXISTS FOR (e:Entity) ON EACH [e.name]',
];

/**
 * Idempotent drops for deprecated schema (legacy :Claim / :Decision labels).
 * Run BEFORE the CREATE pass. NOTE: the runtime assertion schema is now named
 * `assertion_*`, so these drops no longer collide with anything we create.
 */
export const DEPRECATED_DROPS: string[] = [
  'DROP CONSTRAINT claim_id IF EXISTS',
  'DROP INDEX claim_status IF EXISTS',
  'DROP INDEX claim_confidence IF EXISTS',
  'DROP INDEX claim_predicate IF EXISTS',
  'DROP INDEX claim_created IF EXISTS',
  'DROP CONSTRAINT decision_id IF EXISTS',
];

export interface RelationTypeSeed {
  name: string;
  description: string;
  category: string;
}

/**
 * Standard relation types seeded as :RelationType metadata nodes.
 *
 * NOTE: this is a display/seed catalog, not the predicate vocabulary — it is
 * intentionally NOT derived from `relation-registry.ts`. See that module for
 * the canonical relation-type → Neo4j-predicate mapping.
 */
export const RELATION_TYPES: RelationTypeSeed[] = [
  { name: 'USES', description: 'Technology uses another technology', category: 'tech' },
  { name: 'ENABLES', description: 'Technology enables another technology', category: 'tech' },
  { name: 'COMPETES_WITH', description: 'Technologies compete in the same space', category: 'tech' },
  { name: 'EXTENDS', description: 'Technology extends or builds on another', category: 'tech' },
  { name: 'REPLACES', description: 'Technology replaces an older one', category: 'tech' },
  { name: 'VENDOR', description: 'Company provides/sells technology', category: 'company' },
  { name: 'USER', description: 'Company uses technology', category: 'company' },
  { name: 'PARTNER', description: 'Company partners on technology', category: 'company' },
  { name: 'COMPETITOR', description: 'Company competes in technology space', category: 'company' },
  { name: 'ACQUIRED', description: 'Company acquired another company', category: 'company' },
  { name: 'ADDRESSES', description: 'Technology addresses use case', category: 'usecase' },
  { name: 'REQUIRES', description: 'Use case requires technology', category: 'usecase' },
  { name: 'DEMONSTRATES', description: 'Prototype demonstrates use case', category: 'usecase' },
  { name: 'ALIGNS_WITH', description: 'Technology/Initiative aligns with strategy', category: 'strategy' },
  { name: 'SUPPORTS', description: 'Entity supports strategic goal', category: 'strategy' },
  { name: 'CONFLICTS_WITH', description: 'Entity conflicts with strategic direction', category: 'strategy' },
  { name: 'SOLVES', description: 'Technology/Prototype solves pain point', category: 'painpoint' },
  { name: 'IMPACTS', description: 'Pain point impacts org unit', category: 'painpoint' },
  { name: 'EXPERIENCES', description: 'Org unit experiences pain point', category: 'painpoint' },
  { name: 'DRIVES', description: 'Pain point drives initiative', category: 'initiative' },
  { name: 'FUNDS', description: 'Initiative funds prototype', category: 'initiative' },
  { name: 'SPONSORS', description: 'OrgUnit sponsors initiative', category: 'initiative' },
  { name: 'IMPLEMENTS', description: 'Initiative implements strategy', category: 'initiative' },
  { name: 'OWNS', description: 'Org unit owns entity', category: 'orgunit' },
  { name: 'OWNED_BY', description: 'Entity owned by org unit', category: 'orgunit' },
  { name: 'REPORTS_TO', description: 'Org unit reports to another', category: 'orgunit' },
  { name: 'COLLABORATES_WITH', description: 'Org units collaborate', category: 'orgunit' },
  { name: 'MENTIONS', description: 'Document mentions entity', category: 'document' },
  { name: 'CITES', description: 'Document cites evidence', category: 'document' },
  { name: 'CONTAINS', description: 'Document contains chunk', category: 'document' },
  { name: 'HAS_CONCEPT', description: 'Entity has/tagged with concept', category: 'concept' },
  { name: 'RELATED_CONCEPT', description: 'Concept is related to another concept', category: 'concept' },
  { name: 'PARENT_CONCEPT', description: 'Concept is a parent of another (hierarchy)', category: 'concept' },
  { name: 'SYNONYM_OF', description: 'Concepts are synonyms/aliases', category: 'concept' },
  { name: 'RELATED_TO', description: 'Generic relationship', category: 'generic' },
  { name: 'SIMILAR_TO', description: 'Entities are similar', category: 'generic' },
  { name: 'CUSTOM', description: 'Custom relationship type', category: 'generic' },
];

// ---------------------------------------------------------------------------
// PURE HELPERS
// ---------------------------------------------------------------------------

/**
 * Extract the object name from a `CREATE CONSTRAINT|INDEX|VECTOR INDEX|FULLTEXT
 * INDEX <name> ...` statement. Returns null for non-create statements (DROPs).
 */
export function parseSchemaObjectName(statement: string): string | null {
  const m = statement.match(/CREATE\s+(?:VECTOR\s+INDEX|FULLTEXT\s+INDEX|CONSTRAINT|INDEX)\s+(\w+)/i);
  return m ? m[1] : null;
}

export interface SchemaResult {
  label: string;
  ok: boolean;
}

export interface SchemaSummary {
  total: number;
  ok: number;
  failed: number;
  failures: string[];
}

/** Aggregate per-statement results — collects EVERY failure (never swallows). */
export function summarizeSchemaResults(results: SchemaResult[]): SchemaSummary {
  const failures = results.filter((r) => !r.ok).map((r) => r.label);
  return {
    total: results.length,
    ok: results.length - failures.length,
    failed: failures.length,
    failures,
  };
}

/** The set of schema object names this manifest is expected to create. */
export function expectedSchemaObjects(): {
  constraints: string[];
  indexes: string[];
  vectorIndexes: string[];
  fulltextIndexes: string[];
} {
  const names = (arr: string[]) => arr.map(parseSchemaObjectName).filter((n): n is string => n !== null);
  const isConstraint = (s: string) => /CREATE\s+CONSTRAINT/i.test(s);
  const allDdl = [...CONSTRAINTS, ...INDEXES, ...CONTEXT_SCHEMA];
  return {
    constraints: names(allDdl.filter(isConstraint)),
    indexes: names(allDdl.filter((s) => !isConstraint(s))),
    vectorIndexes: names(VECTOR_INDEXES),
    fulltextIndexes: names(FULLTEXT_INDEXES),
  };
}
