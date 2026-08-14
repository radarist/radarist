/**
 * @file business-entity-identity.ts
 * @description AI-026 — the ONE answer to "is this graph node the business
 * entity it claims to be?", for every read that hands an entity to a user, an
 * Assistant tool, or a recommendation.
 *
 * ## The defect
 *
 * Neo4j stores first-class domain entities alongside internal-memory
 * bookkeeping nodes, and several bookkeeping writers copy the `entityType` of
 * the entity they are ABOUT onto their OWN node: an `:AgentObservation`
 * recorded about a Technology is created with `entityType: 'technology'`
 * (`proactive-insights.ts` `recordAgentObservation` / `recordInterestWatch`,
 * `sweep-observations.ts`). A read that decides identity from that property
 * alone therefore answers "yes, this is a Technology" about an observation.
 * That is not hypothetical — a live Assistant turn had
 * `recommendTechInvestments` recommend an `:AgentObservation`, rendered as
 * "[Unnamed Technology]" because such a node carries `entityName`, never `name`.
 *
 * ## Why not a deny-list, and why not a bare allow-list either
 *
 * A deny-list over known bookkeeping labels is open-ended: the previous
 * `GRAPH_RETRIEVAL_EXCLUDED_LABELS` named 10 labels while 15 more bookkeeping
 * labels were being written (`Assertion`, `Evidence`, `Chunk`, `Concept`,
 * `CommunityReport`, `RelationType`, `AgentReflection`, `AsserterReliability`,
 * `InterestProfile`, `UserPreference`, `PreferenceEngagementReceipt`,
 * `VerificationResult`, `EdgeVerificationResult`, `SchemaMigration`,
 * `MigrationCensus`), and every future label leaks until someone remembers.
 *
 * A bare allow-list over `BUSINESS_ENTITY_GRAPH_LABELS` fails the other way.
 * Relation and assertion sync legitimately mint an endpoint placeholder with
 * NO specific label — `MERGE (subject:Entity {id: $subjectId}) ON CREATE SET
 * subject.entityType = $subjectType` (`assertions.ts`,
 * `relation-assertion-sync.ts` `buildEndpointMergeClause`) — when a relation
 * reaches the graph before its endpoint's own entity projection. Requiring a
 * canonical label would silently drop those real entities from retrieval.
 *
 * ## The rule
 *
 * Identity is decided by the node's LABEL SET, which no bookkeeping writer can
 * fake, and the `entityType` property is only ever allowed to narrow within an
 * already-proven identity:
 *
 *   1. no label may be internal-memory vocabulary (explicit, defense in depth);
 *   2. no label may be FOREIGN — every label must be `Entity` or a canonical
 *      entity label. This is the closed half: `Assertion`, `Chunk`, `Concept`,
 *      `Radar`, and any label added tomorrow are foreign by construction;
 *   3. `entityType` may not be internal-memory vocabulary;
 *   4. when a specific type is requested, either a canonical label proves that
 *      type, or — only for a node carrying no canonical label at all, i.e. an
 *      endpoint placeholder — the `entityType` property may stand in.
 *
 * `deleteEntityFromGraph` (`assertions.ts`) already resolves its endpoint with
 * the same shape (`$endpointLabel IN labels(endpoint) OR ('Entity' IN
 * labels(endpoint) AND endpoint.entityType IN $entityTypes)`); this module makes
 * that the single reusable contract instead of one hand-rolled copy per read.
 *
 * Labels only need string interpolation when they appear inside a Cypher
 * PATTERN. Every predicate here compares them as parameter-bound string values,
 * so no label from this module ever reaches a query string.
 *
 * Dependency-free (pure data + functions over `entity-type-vocab`) so it is safe
 * to import from any read boundary.
 */

import type { EntityType } from '@/lib/types';
import { BUSINESS_ENTITY_GRAPH_LABELS, ENTITY_TYPE_GRAPH_LABEL } from './entity-type-vocab';

/**
 * The generic label every entity projection carries alongside its specific one
 * (`MERGE (e:Entity:${label} {id: $entityId})` in `sync-entity-to-neo4j.ts`),
 * and the only label an endpoint placeholder has.
 */
export const GENERIC_ENTITY_GRAPH_LABEL = 'Entity';

/**
 * Node labels that mark a node as internal memory / bookkeeping rather than a
 * domain entity. Historically `GRAPH_RETRIEVAL_EXCLUDED_LABELS` in
 * `vector-search.ts`; moved here so the identity contract has one home and the
 * label vocabulary cannot fork between the exact, semantic and traversal paths.
 *
 * Deliberately the MEMORY subset, not every non-entity label in the schema.
 * Structural and derived labels (`Assertion`, `Claim`, `Evidence`, `Chunk`,
 * `Concept`, `CommunityReport`, `RelationType`, `Radar`, `VerificationResult`,
 * `EdgeVerificationResult`, `SchemaMigration`, `MigrationCensus`) need no entry
 * here: rule 2 refuses them for being foreign, which is also what makes the
 * contract hold for labels nobody has written yet. This list exists for the one
 * case rule 2 cannot cover — a node that acquired a canonical label AND a
 * bookkeeping label — and so the vocabulary the row speaks of ("internal memory")
 * has a name in code.
 */
export const INTERNAL_MEMORY_GRAPH_LABELS = [
  'Agent',
  'AgentRun',
  'AgentObservation',
  'AgentReflection',
  'Episode',
  'Observation',
  'Session',
  'User',
  'UserPreference',
  'PreferenceEngagementReceipt',
  'InterestProfile',
  'AsserterReliability',
  'Mission',
  'ProactiveInsight',
  'CuriosityGap',
] as const;

/**
 * `entityType` property values that are themselves internal-memory vocabulary.
 * Kept alongside the label rules: a bookkeeping node that lost its label is
 * still refused, and an entity projection can never legitimately claim one of
 * these types (none of them is in `ENTITY_TYPE_GRAPH_LABEL`).
 *
 * This list can never catch the AI-026 case on its own — the masquerading node's
 * `entityType` is a legitimate business value like `'technology'`.
 */
export const INTERNAL_MEMORY_ENTITY_TYPES = [
  'agent',
  'agentrun',
  'agent_run',
  'agentobservation',
  'agent_observation',
  'agentreflection',
  'agent_reflection',
  'episode',
  'observation',
  'session',
  'user',
  'userpreference',
  'user_preference',
  'interestprofile',
  'interest_profile',
  'proactiveinsight',
  'proactive_insight',
  'curiositygap',
  'curiosity_gap',
  'mission',
  'memory',
  'internal',
] as const;

/**
 * Labels an entity projection may legitimately carry. Anything else is FOREIGN
 * and disqualifies the node — this is what makes the contract closed rather than
 * a list someone has to remember to extend.
 */
export const ENTITY_PROJECTION_GRAPH_LABELS: readonly string[] = Object.freeze([
  GENERIC_ENTITY_GRAPH_LABEL,
  ...BUSINESS_ENTITY_GRAPH_LABELS,
]);

/**
 * Every accepted spelling of an entityType, mapped to the single canonical Neo4j
 * label its writer stamps. Keys are normalized (lower-cased, `_`/`-` stripped)
 * so `org_unit`, `orgUnit` and `ORGUNIT` all resolve to `OrgUnit`.
 *
 * Derived from `ENTITY_TYPE_GRAPH_LABEL` rather than restated, so a new entity
 * type cannot be added to the domain without also being resolvable here — the
 * forked, hand-maintained copy in `subgraph-rag.ts` silently omitted `document`
 * and `radarPlacement`, which made a `document`-scoped resolution fall back to
 * matching the `entityType` property alone.
 */
const CANONICAL_LABEL_BY_NORMALIZED_TYPE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENTITY_TYPE_GRAPH_LABEL).map(([entityType, label]) => [normalizeEntityTypeKey(entityType), label])
  )
);

/** Normalize an entityType spelling to the key form used for label lookup. */
function normalizeEntityTypeKey(value: string): string {
  return value.replace(/[_-]/g, '').toLowerCase();
}

/** The canonical Neo4j label for one entityType spelling, or undefined. */
export function graphLabelForEntityType(entityType: string): string | undefined {
  return CANONICAL_LABEL_BY_NORMALIZED_TYPE[normalizeEntityTypeKey(entityType)];
}

/**
 * Canonical labels for a set of requested entityTypes — deduped and sorted for a
 * stable Cypher parameter, silently dropping spellings with no canonical label.
 * Callers that must know whether every requested type was resolvable compare the
 * returned length against their input.
 */
export function graphLabelsForEntityTypes(entityTypes: readonly string[]): string[] {
  const labels = new Set<string>();
  for (const entityType of entityTypes) {
    const label = graphLabelForEntityType(entityType);
    if (label) labels.add(label);
  }
  return [...labels].sort();
}

export interface BusinessEntityIdentityParams {
  /** Every canonical domain-entity label. */
  readonly businessEntityLabels: readonly string[];
  /** `Entity` plus every canonical label — anything else on a node is foreign. */
  readonly entityProjectionLabels: readonly string[];
  /** Bookkeeping labels that disqualify a node even if it also looks canonical. */
  readonly internalMemoryLabels: readonly string[];
  /** Lower-cased `entityType` values that are internal-memory vocabulary. */
  readonly internalMemoryEntityTypes: readonly string[];
}

/** The parameter bundle every predicate below expects to be bound. */
export function businessEntityIdentityParams(): BusinessEntityIdentityParams {
  return {
    businessEntityLabels: BUSINESS_ENTITY_GRAPH_LABELS,
    entityProjectionLabels: ENTITY_PROJECTION_GRAPH_LABELS,
    internalMemoryLabels: INTERNAL_MEMORY_GRAPH_LABELS,
    internalMemoryEntityTypes: INTERNAL_MEMORY_ENTITY_TYPES,
  };
}

/**
 * Cypher predicate proving `variable` is a business entity at all (rules 1–3).
 * Says nothing about WHICH entity type — compose with
 * `businessEntityTypeScopeCypher` when a specific type was requested.
 */
export function businessEntityIdentityCypher(variable: string): string {
  return [
    `NONE(identityLabel IN labels(${variable}) WHERE identityLabel IN $internalMemoryLabels)`,
    `NONE(identityLabel IN labels(${variable}) WHERE NOT identityLabel IN $entityProjectionLabels)`,
    `NOT toLower(coalesce(${variable}.entityType, '')) IN $internalMemoryEntityTypes`,
  ].join('\n      AND ');
}

/**
 * Cypher predicate narrowing an already-identity-proven `variable` to the
 * requested type(s) (rule 4).
 *
 * `labelsParam` holds the canonical label(s) of the requested types;
 * `typesParam` holds the accepted `entityType` spellings. The property branch
 * fires ONLY for a node with no canonical label at all — the endpoint
 * placeholder — so a mislabelled or bookkeeping node can never reach it.
 *
 * Pass a `typesParam` that may be NULL to make the whole predicate a no-op for
 * unscoped reads; callers that always scope can rely on the label branch.
 */
export function businessEntityTypeScopeCypher(
  variable: string,
  labelsParam = '$targetLabels',
  typesParam = '$targetTypes'
): string {
  return (
    `(\n` +
    `        ${businessEntityLabelScopeCypher(variable, labelsParam)}\n` +
    `        OR (\n` +
    `          NONE(identityLabel IN labels(${variable}) WHERE identityLabel IN $businessEntityLabels)\n` +
    `          AND (${typesParam} IS NULL OR ${variable}.entityType IN ${typesParam})\n` +
    `        )\n` +
    `      )`
  );
}

/**
 * The label-only half of rule 4, with NO placeholder branch. For reads whose
 * candidate set is already label-scoped by construction — a vector index
 * declared `FOR (n:<Label>)` cannot contain a placeholder — so admitting the
 * property branch there would only widen the predicate past what it can reach.
 */
export function businessEntityLabelScopeCypher(variable: string, labelsParam = '$targetLabels'): string {
  return `ANY(identityLabel IN labels(${variable}) WHERE identityLabel IN ${labelsParam})`;
}

/**
 * The canonical label to REPORT for an identity-proven node. Iterates the
 * constant parameter list rather than `labels(n)`, because Neo4j does not
 * guarantee label order and the reported label must be stable across reads.
 * Evaluates to NULL for an endpoint placeholder, exactly as the previous
 * `[l IN labels(n) WHERE l <> 'Entity'][0]` projection did.
 */
export function businessEntityLabelProjection(variable: string): string {
  return `head([identityLabel IN $businessEntityLabels WHERE identityLabel IN labels(${variable})])`;
}

interface IdentifiableNode {
  readonly labels?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

/**
 * TypeScript-side twin of the Cypher predicates, for results that arrive from a
 * backend Cypher cannot constrain (the Firestore fallback, the mock service) or
 * from a read whose query shape predates the contract. Backend-agnostic: it
 * needs only the node's labels and `entityType`.
 *
 * `requiredEntityType` applies rule 4 — the check a caller asking for "a
 * Technology" actually wants.
 */
export function isBusinessEntityNode(node: IdentifiableNode, requiredEntityType?: EntityType | string): boolean {
  const labels = node.labels ?? [];
  const internalLabels = INTERNAL_MEMORY_GRAPH_LABELS as readonly string[];
  const internalTypes = INTERNAL_MEMORY_ENTITY_TYPES as readonly string[];

  if (labels.some((label) => internalLabels.includes(label))) return false;
  if (labels.some((label) => !ENTITY_PROJECTION_GRAPH_LABELS.includes(label))) return false;

  const rawEntityType = node.properties?.entityType;
  const entityType = typeof rawEntityType === 'string' ? rawEntityType : undefined;
  if (entityType !== undefined && internalTypes.includes(entityType.toLowerCase())) return false;

  if (requiredEntityType === undefined) return true;

  const required = graphLabelForEntityType(requiredEntityType);
  // An unmappable requested type cannot be proven, so refuse rather than fall
  // through to the placeholder branch.
  if (required === undefined) return false;
  if (labels.includes(required)) return true;
  // Placeholder branch: no canonical label at all, so the property may stand in.
  if (labels.some((label) => BUSINESS_ENTITY_GRAPH_LABELS.includes(label))) return false;
  return entityType !== undefined && normalizeEntityTypeKey(entityType) === normalizeEntityTypeKey(requiredEntityType);
}

/** Canonical label → the domain `EntityType` its writer stamps. */
const ENTITY_TYPE_BY_CANONICAL_LABEL: Readonly<Record<string, EntityType>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ENTITY_TYPE_GRAPH_LABEL).map(([entityType, label]) => [label, entityType as EntityType])
  )
);

/**
 * The entity type to REPORT for a node.
 *
 * Derived from the canonical LABEL first — the inverse of what the render helpers
 * used to do (`String(node.properties?.entityType || node.labels?.[0] ||
 * 'unknown')`), which is how a bookkeeping node's copied property became the type
 * shown to the user. Returns undefined when the type cannot be proven, so callers
 * report "unknown" or drop the node rather than defaulting it to a type.
 *
 * Gated on the full identity contract, which is load-bearing twice over:
 *  - without it, an `:AgentObservation` carrying `entityType:'technology'` gets a
 *    property that maps cleanly onto a canonical label, reproducing the exact
 *    defect at the render boundary;
 *  - and a node that acquired BOTH a canonical and a bookkeeping label would
 *    otherwise be named by its canonical label despite every read refusing it.
 */
export function businessEntityGraphType(node: IdentifiableNode): EntityType | undefined {
  if (!isBusinessEntityNode(node)) return undefined;
  for (const label of node.labels ?? []) {
    const entityType = ENTITY_TYPE_BY_CANONICAL_LABEL[label];
    if (entityType) return entityType;
  }
  // No canonical label: the endpoint placeholder, where the property may stand in.
  const rawEntityType = node.properties?.entityType;
  if (typeof rawEntityType !== 'string') return undefined;
  const canonicalLabel = graphLabelForEntityType(rawEntityType);
  return canonicalLabel ? ENTITY_TYPE_BY_CANONICAL_LABEL[canonicalLabel] : undefined;
}

/** Keep only the nodes whose identity is proven. Order-preserving. */
export function filterBusinessEntityNodes<T extends IdentifiableNode>(
  nodes: readonly T[],
  requiredEntityType?: EntityType | string
): T[] {
  return nodes.filter((node) => isBusinessEntityNode(node, requiredEntityType));
}
