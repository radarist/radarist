import { createHash } from 'node:crypto';

import { validateRelation } from '@/lib/linker/relation-ontology';
import type {
  CreateProposedRelationInput,
  EntitySnapshot,
  EntityType,
  MinimalEntitySnapshot,
  RelationType,
} from '@/lib/types';

/** Business labels traversed by the product graph and GraphRAG tools. */
export const BUSINESS_ENTITY_LABELS = [
  'Technology',
  'Company',
  'UseCase',
  'PainPoint',
  'OrgUnit',
  'Initiative',
  'Strategy',
  'Prototype',
  'Document',
  'Signal',
] as const;

export const GRAPH_REACHABILITY_OPERATION = 'graph-reachability-audit-v2' as const;
export const GRAPH_REACHABILITY_ALGORITHM = 'ontology-valid-tag-overlap-v2' as const;
export const GRAPH_REACHABILITY_SCHEMA_VERSION = 2 as const;

const BUSINESS_LABEL_SET = new Set<string>(BUSINESS_ENTITY_LABELS);
const MIN_TOKEN_LENGTH = 3;

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeForCanonicalJson(nested)])
    );
  }
  return value;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeForCanonicalJson(value))).digest('hex');
}

export type DecisionLabel = 'PainPoint' | 'UseCase' | 'Signal';
export type CandidateLabel = 'Technology' | 'OrgUnit' | 'Initiative' | 'Document';
export type SupportedDecisionLabel = Exclude<DecisionLabel, 'Signal'>;

const LABEL_TO_ENTITY_TYPE: Record<DecisionLabel | CandidateLabel, EntityType> = {
  PainPoint: 'painPoint',
  UseCase: 'useCase',
  Signal: 'signal',
  Technology: 'technology',
  OrgUnit: 'orgUnit',
  Initiative: 'initiative',
  Document: 'document',
};

export interface GraphReachabilityTarget {
  neo4jUri: string;
  neo4jDatabase: string;
  neo4jDatabaseId: string;
  firestoreProjectId: string;
  firestoreDatabaseId: string;
  firestoreMode: 'emulator' | 'live';
  firestoreEndpoint: string;
}

export type ExpectedGraphReachabilityTarget = GraphReachabilityTarget;

export interface DecisionNodeFact {
  label: DecisionLabel;
  id: string;
  name: string;
  tags: string[];
  /** Label arrays for each distinct incident neighbor. */
  neighborLabels: string[][];
}

export interface CandidateEntity {
  id: string;
  label: CandidateLabel;
  name: string;
  tags: string[];
}

export type ReachabilityClass = 'business-reachable' | 'memory-only' | 'disconnected';
export type DisconnectedSignalClass = 'policy-correct-inbox' | 'eligible-but-unlinked';
export type DecisionGapClass =
  | 'inferable-candidate'
  | 'ambiguous-candidate'
  | 'curation-gap-no-evidence'
  | 'untagged-gap'
  | 'graph-only-source-drift';

export interface CanonicalRelationSuggestion {
  sourceId: string;
  sourceType: EntityType;
  sourceName: string;
  targetId: string;
  targetType: EntityType;
  targetName: string;
  relationType: RelationType;
}

export interface RankedCandidate {
  candidate: CandidateEntity;
  relation: CanonicalRelationSuggestion;
  overlap: number;
  sharedTokens: string[];
  sourceEvidenceFingerprint: string;
  targetEvidenceFingerprint: string;
}

export interface DecisionGapResult {
  classification: DecisionGapClass;
  topCandidate: RankedCandidate | null;
  /** Stable evidence for why an equally-ranked candidate was not guessed. */
  ambiguousCandidates: RankedCandidate[];
}

export interface ClassifiedDisconnected {
  node: DecisionNodeFact;
  classification: DecisionGapClass;
  topCandidate: RankedCandidate | null;
  ambiguousCandidates: RankedCandidate[];
}

export interface LabelReachability {
  label: DecisionLabel;
  total: number;
  businessReachable: number;
  memoryOnly: number;
  disconnected: number;
}

export interface LabelReachabilityScore extends LabelReachability {
  usefulReachability: number;
  densityReachability: number;
  inflationFromMemoryOnly: number;
}

export interface ReachabilityBenchmark {
  perLabel: LabelReachabilityScore[];
  aggregate: {
    total: number;
    businessReachable: number;
    memoryOnly: number;
    disconnected: number;
    usefulReachability: number;
  };
}

export interface TriageCandidate {
  nodeId: string;
  nodeLabel: SupportedDecisionLabel;
  sourceId: string;
  sourceType: EntityType;
  sourceName: string;
  targetId: string;
  targetType: EntityType;
  targetName: string;
  relationType: RelationType;
  overlap: number;
  sharedTokens: string[];
  sourceEvidence: { field: 'tags'; fingerprint: string };
  targetEvidence: { field: 'tags'; fingerprint: string };
  status: 'triage-candidate';
  claimStatus: 'proposed';
  autoApprove: false;
}

export interface TriageCandidateBatch {
  inferableTotal: number;
  emittedCount: number;
  omittedCount: number;
  candidates: TriageCandidate[];
}

export interface EntityProjectionResync {
  label: DecisionLabel;
  authoritativeCount: number;
  graphCount: number;
  missingGraphCount: number;
  missingGraphIds: string[];
  graphOnlyCount: number;
  graphOnlyIds: string[];
  duplicateGraphIdCount: number;
  duplicateGraphIds: string[];
}

export interface RelationProjectionResync {
  sourceId: string;
  sourceType: EntityType;
  targetId: string;
  targetType: EntityType;
  relationType: RelationType;
  relationId: string;
  reason: 'firestore-relation-missing-active-graph-edge';
}

export interface CandidateProjectionResync {
  label: CandidateLabel;
  authoritativeCount: number;
  graphCount: number;
  missingGraphIds: string[];
  duplicateGraphIds: string[];
  graphOnlyIds: string[];
}

export interface GraphReachabilityPlanPayload {
  schemaVersion: typeof GRAPH_REACHABILITY_SCHEMA_VERSION;
  operation: typeof GRAPH_REACHABILITY_OPERATION;
  algorithm: typeof GRAPH_REACHABILITY_ALGORITHM;
  target: GraphReachabilityTarget;
  policy: {
    minTagOverlap: number;
    triageTopN: number;
    signalProjection: 'approved-or-referenced';
  };
  benchmark: ReachabilityBenchmark;
  signalPolicyBreakdown: {
    policyCorrectInbox: number;
    eligibleButUnlinked: number;
    policyIneligibleProjected: number;
    policyIneligibleProjectedIds: string[];
  };
  entityProjectionResync: EntityProjectionResync[];
  candidateProjectionResync: CandidateProjectionResync[];
  relationProjectionResync: RelationProjectionResync[];
  gapBreakdown: Record<SupportedDecisionLabel, Record<DecisionGapClass, number>>;
  triage: TriageCandidateBatch;
}

export interface GraphReachabilityPlan extends GraphReachabilityPlanPayload {
  planSha256: string;
}

export interface StageAuthorizationInput {
  plannedTarget: GraphReachabilityTarget;
  currentTarget: GraphReachabilityTarget;
  planSha256: string;
  expectedPlanSha256: string;
  confirmation: string;
}

export interface ProposalCreationResult {
  created: boolean;
  proposal: { id: string };
  reason?: string;
}

export interface StageTriageDependencies {
  resolveEvidenceEntity(
    id: string,
    type: EntityType
  ): Promise<{ snapshot: EntitySnapshot; tags: string[] }>;
  assertStillBusinessUnreachable(candidate: TriageCandidate): Promise<void>;
  findExistingRelation(
    sourceId: string,
    targetId: string,
    relationType: RelationType
  ): Promise<{ id: string } | null>;
  createProposal(input: CreateProposedRelationInput): Promise<ProposalCreationResult>;
  now?: () => number;
}

export type StageCandidateOutcome =
  | { candidateKey: string; status: 'created'; proposalId: string }
  | { candidateKey: string; status: 'deduplicated'; proposalId: string; reason?: string }
  | { candidateKey: string; status: 'relation-resync-required'; relationId: string }
  | { candidateKey: string; status: 'failed'; phase: 'preflight' | 'write'; error: string };

export interface StageTriageResult {
  ok: boolean;
  attempted: number;
  created: number;
  deduplicated: number;
  relationResyncRequired: number;
  failed: number;
  outcomes: StageCandidateOutcome[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedNonBlank(value: string, label: string, max = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be a bounded non-blank string`);
  return normalized;
}

export function normalizeNeo4jAuditUri(raw: string): string {
  const input = boundedNonBlank(raw, 'Neo4j URI', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Neo4j URI must be an absolute URL');
  }
  const supported = new Set(['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:']);
  if (!supported.has(parsed.protocol)) throw new Error(`Unsupported Neo4j URI protocol ${parsed.protocol}`);
  if (!parsed.hostname || !parsed.port) throw new Error('Neo4j URI must bind an explicit hostname and port');
  if (parsed.username || parsed.password) throw new Error('Neo4j URI must not embed credentials');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Neo4j URI must not contain a path, query, or fragment');
  }
  return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

function normalizeFirestoreEndpoint(mode: GraphReachabilityTarget['firestoreMode'], raw: string): string {
  const input = boundedNonBlank(raw, 'Firestore endpoint', 512).replace(/^https?:\/\//, '');
  if (mode === 'live') {
    if (input !== 'firestore.googleapis.com') {
      throw new Error('Live Firestore endpoint must be firestore.googleapis.com');
    }
    return input;
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${input}`);
  } catch {
    throw new Error('Firestore emulator endpoint must be an explicit loopback host and port');
  }
  const loopback =
    parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!loopback || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Firestore emulator endpoint must be an explicit loopback host and port');
  }
  return parsed.host.toLowerCase();
}

export function normalizeTarget(target: GraphReachabilityTarget): GraphReachabilityTarget {
  if (target.firestoreMode !== 'emulator' && target.firestoreMode !== 'live') {
    throw new Error('Firestore mode must be emulator or live');
  }
  return {
    neo4jUri: normalizeNeo4jAuditUri(target.neo4jUri),
    neo4jDatabase: boundedNonBlank(target.neo4jDatabase, 'Neo4j database', 200),
    neo4jDatabaseId: boundedNonBlank(target.neo4jDatabaseId, 'Neo4j database ID', 200),
    firestoreProjectId: boundedNonBlank(target.firestoreProjectId, 'Firestore project ID', 200),
    firestoreDatabaseId: boundedNonBlank(target.firestoreDatabaseId, 'Firestore database ID', 200),
    firestoreMode: target.firestoreMode,
    firestoreEndpoint: normalizeFirestoreEndpoint(target.firestoreMode, target.firestoreEndpoint),
  };
}

export function assertExactTargetIdentity(
  expected: ExpectedGraphReachabilityTarget,
  actual: GraphReachabilityTarget
): GraphReachabilityTarget {
  const normalizedExpected = normalizeTarget(expected);
  const normalizedActual = normalizeTarget(actual);
  for (const key of Object.keys(normalizedExpected) as Array<keyof GraphReachabilityTarget>) {
    if (normalizedExpected[key] !== normalizedActual[key]) {
      throw new Error(
        `Graph reachability target mismatch for ${key}: expected ${normalizedExpected[key]}, received ${normalizedActual[key]}`
      );
    }
  }
  return normalizedActual;
}

export function classifyDecisionReachability(node: DecisionNodeFact): ReachabilityClass {
  if (node.neighborLabels.length === 0) return 'disconnected';
  const hasBusinessNeighbor = node.neighborLabels.some((labels) =>
    labels.some((label) => BUSINESS_LABEL_SET.has(label))
  );
  return hasBusinessNeighbor ? 'business-reachable' : 'memory-only';
}

export function classifyDisconnectedSignal(input: { eligible: boolean }): DisconnectedSignalClass {
  return input.eligible ? 'eligible-but-unlinked' : 'policy-correct-inbox';
}

export function normalizeTagTokens(tags: readonly string[]): string[] {
  const stopTokens = new Set([
    'and',
    'case',
    'document',
    'for',
    'from',
    'initiative',
    'into',
    'pain',
    'point',
    'technology',
    'the',
    'unit',
    'use',
    'using',
    'with',
  ]);
  const tokens = new Set<string>();
  for (const tag of tags) {
    for (const raw of String(tag).toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= MIN_TOKEN_LENGTH && !stopTokens.has(raw)) tokens.add(raw);
    }
  }
  return [...tokens].sort(compareText);
}

export function scoreTagOverlap(tagsA: readonly string[], tagsB: readonly string[]): number {
  const setB = new Set(normalizeTagTokens(tagsB));
  return normalizeTagTokens(tagsA).filter((token) => setB.has(token)).length;
}

function relationFromPair(
  node: DecisionNodeFact,
  candidate: CandidateEntity,
  source: 'node' | 'candidate',
  relationType: RelationType
): CanonicalRelationSuggestion | null {
  const sourceEntity = source === 'node' ? node : candidate;
  const targetEntity = source === 'node' ? candidate : node;
  const sourceType = LABEL_TO_ENTITY_TYPE[sourceEntity.label];
  const targetType = LABEL_TO_ENTITY_TYPE[targetEntity.label];
  const validation = validateRelation(sourceType, targetType, relationType);
  if (!validation.valid || validation.shouldSwap) return null;
  return {
    sourceId: sourceEntity.id,
    sourceType,
    sourceName: sourceEntity.name,
    targetId: targetEntity.id,
    targetType,
    targetName: targetEntity.name,
    relationType,
  };
}

/**
 * Conservative semantic mappings only. Unsupported pairs are deliberately
 * omitted instead of falling back to `custom` or guessing a direction.
 */
export function resolveCanonicalTriageRelation(
  node: DecisionNodeFact,
  candidate: CandidateEntity
): CanonicalRelationSuggestion | null {
  if (node.label === 'Signal') return null;
  if (node.label === 'PainPoint') {
    switch (candidate.label) {
      case 'Technology':
        return relationFromPair(node, candidate, 'candidate', 'solves');
      case 'OrgUnit':
        return relationFromPair(node, candidate, 'node', 'impacts');
      case 'Initiative':
        return relationFromPair(node, candidate, 'node', 'drives');
      case 'Document':
        return relationFromPair(node, candidate, 'candidate', 'about');
    }
  }
  switch (candidate.label) {
    case 'Technology':
      return relationFromPair(node, candidate, 'node', 'requires');
    case 'OrgUnit':
      return relationFromPair(node, candidate, 'node', 'owned_by');
    case 'Document':
      return relationFromPair(node, candidate, 'candidate', 'about');
    case 'Initiative':
      return null;
  }
}

function rankedCandidateKey(candidate: RankedCandidate): string {
  return [
    candidate.relation.sourceType,
    candidate.relation.sourceId,
    candidate.relation.relationType,
    candidate.relation.targetType,
    candidate.relation.targetId,
  ].join('\u0000');
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return right.overlap - left.overlap || compareText(rankedCandidateKey(left), rankedCandidateKey(right));
}

export function classifyDisconnectedDecisionEntity(input: {
  node: DecisionNodeFact;
  candidates: readonly CandidateEntity[];
  minOverlap: number;
}): DecisionGapResult {
  if (input.node.label === 'Signal') {
    throw new Error('Signals use the approved-or-referenced projection classifier');
  }
  const nodeTokens = normalizeTagTokens(input.node.tags);
  if (nodeTokens.length === 0) {
    return { classification: 'untagged-gap', topCandidate: null, ambiguousCandidates: [] };
  }
  const nodeTokenSet = new Set(nodeTokens);
  const ranked = input.candidates
    .map((candidate): RankedCandidate | null => {
      const relation = resolveCanonicalTriageRelation(input.node, candidate);
      if (!relation) return null;
      const sharedTokens = normalizeTagTokens(candidate.tags).filter((token) =>
        nodeTokenSet.has(token)
      );
      const overlap = sharedTokens.length;
      if (overlap < input.minOverlap) return null;
      const nodeFingerprint = sha256Json(normalizeTagTokens(input.node.tags));
      const candidateFingerprint = sha256Json(normalizeTagTokens(candidate.tags));
      const sourceIsNode = relation.sourceId === input.node.id;
      return {
        candidate,
        relation,
        overlap,
        sharedTokens,
        sourceEvidenceFingerprint: sourceIsNode ? nodeFingerprint : candidateFingerprint,
        targetEvidenceFingerprint: sourceIsNode ? candidateFingerprint : nodeFingerprint,
      };
    })
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort(compareRankedCandidates);

  if (ranked.length === 0) {
    return { classification: 'curation-gap-no-evidence', topCandidate: null, ambiguousCandidates: [] };
  }
  const topScore = ranked[0].overlap;
  const tied = ranked.filter((candidate) => candidate.overlap === topScore);
  if (tied.length > 1) {
    return { classification: 'ambiguous-candidate', topCandidate: null, ambiguousCandidates: tied };
  }
  return { classification: 'inferable-candidate', topCandidate: ranked[0], ambiguousCandidates: [] };
}

export function buildReachabilityBenchmark(perLabel: readonly LabelReachability[]): ReachabilityBenchmark {
  const scored = perLabel.map((row) => ({
    ...row,
    usefulReachability: row.total === 0 ? 0 : row.businessReachable / row.total,
    densityReachability: row.total === 0 ? 0 : (row.businessReachable + row.memoryOnly) / row.total,
    inflationFromMemoryOnly: row.memoryOnly,
  }));
  const total = scored.reduce((sum, row) => sum + row.total, 0);
  const businessReachable = scored.reduce((sum, row) => sum + row.businessReachable, 0);
  return {
    perLabel: scored,
    aggregate: {
      total,
      businessReachable,
      memoryOnly: scored.reduce((sum, row) => sum + row.memoryOnly, 0),
      disconnected: scored.reduce((sum, row) => sum + row.disconnected, 0),
      usefulReachability: total === 0 ? 0 : businessReachable / total,
    },
  };
}

export function triageCandidateKey(candidate: TriageCandidate): string {
  return [
    candidate.sourceType,
    candidate.sourceId,
    candidate.relationType,
    candidate.targetType,
    candidate.targetId,
  ].join('\u0000');
}

export function listTriageCandidates(classified: readonly ClassifiedDisconnected[]): TriageCandidate[] {
  return classified
    .filter(
      (entry): entry is ClassifiedDisconnected & {
        node: DecisionNodeFact & { label: SupportedDecisionLabel };
        topCandidate: RankedCandidate;
      } => entry.classification === 'inferable-candidate' && entry.topCandidate !== null
    )
    .map((entry): TriageCandidate => ({
      nodeId: entry.node.id,
      nodeLabel: entry.node.label,
      ...entry.topCandidate.relation,
      overlap: entry.topCandidate.overlap,
      sharedTokens: [...entry.topCandidate.sharedTokens].sort(compareText),
      sourceEvidence: {
        field: 'tags',
        fingerprint: entry.topCandidate.sourceEvidenceFingerprint,
      },
      targetEvidence: {
        field: 'tags',
        fingerprint: entry.topCandidate.targetEvidenceFingerprint,
      },
      status: 'triage-candidate',
      claimStatus: 'proposed',
      autoApprove: false,
    }))
    .sort(
      (left, right) =>
        right.overlap - left.overlap || compareText(triageCandidateKey(left), triageCandidateKey(right))
    );
}

export function boundTriageCandidates(
  all: readonly TriageCandidate[],
  options: { topN: number }
): TriageCandidateBatch {
  if (!Number.isSafeInteger(options.topN) || options.topN < 0 || options.topN > 1_000) {
    throw new Error('topN must be a safe integer from 0 through 1000');
  }
  const candidates = all.slice(0, options.topN);
  return {
    inferableTotal: all.length,
    emittedCount: candidates.length,
    omittedCount: all.length - candidates.length,
    candidates,
  };
}

export function buildTriageCandidateBatch(
  classified: readonly ClassifiedDisconnected[],
  options: { topN: number }
): TriageCandidateBatch {
  return boundTriageCandidates(listTriageCandidates(classified), options);
}

export function buildGraphReachabilityPlan(payload: GraphReachabilityPlanPayload): GraphReachabilityPlan {
  const normalized: GraphReachabilityPlanPayload = {
    ...payload,
    target: normalizeTarget(payload.target),
  };
  return { ...normalized, planSha256: sha256Json(normalized) };
}

function isExpectedCandidateTopology(candidate: TriageCandidate): boolean {
  const key = [
    candidate.nodeLabel,
    candidate.sourceType,
    candidate.relationType,
    candidate.targetType,
  ].join(':');
  const allowed = new Set([
    'PainPoint:technology:solves:painPoint',
    'PainPoint:painPoint:impacts:orgUnit',
    'PainPoint:painPoint:drives:initiative',
    'PainPoint:document:about:painPoint',
    'UseCase:useCase:requires:technology',
    'UseCase:useCase:owned_by:orgUnit',
    'UseCase:document:about:useCase',
  ]);
  if (!allowed.has(key)) return false;
  const expectedNodeType = LABEL_TO_ENTITY_TYPE[candidate.nodeLabel];
  return (
    (candidate.sourceType === expectedNodeType && candidate.sourceId === candidate.nodeId) ||
    (candidate.targetType === expectedNodeType && candidate.targetId === candidate.nodeId)
  );
}

function assertCandidateIntegrity(candidate: TriageCandidate): void {
  if (
    candidate.status !== 'triage-candidate' ||
    candidate.claimStatus !== 'proposed' ||
    candidate.autoApprove !== false
  ) {
    throw new Error('GRAPH-046 candidate must remain a pending human-triage candidate');
  }
  for (const [label, value, max] of [
    ['nodeId', candidate.nodeId, 512],
    ['sourceId', candidate.sourceId, 512],
    ['sourceName', candidate.sourceName, 500],
    ['targetId', candidate.targetId, 512],
    ['targetName', candidate.targetName, 500],
  ] as const) {
    boundedNonBlank(value, `Candidate ${label}`, max);
  }
  if (
    !Number.isSafeInteger(candidate.overlap) ||
    candidate.overlap < 1 ||
    candidate.overlap > 100 ||
    candidate.sharedTokens.length !== candidate.overlap
  ) {
    throw new Error('GRAPH-046 candidate overlap evidence is malformed');
  }
  const normalizedTokens = normalizeTagTokens(candidate.sharedTokens);
  if (
    normalizedTokens.length !== candidate.sharedTokens.length ||
    normalizedTokens.some((token, index) => token !== candidate.sharedTokens[index])
  ) {
    throw new Error('GRAPH-046 candidate shared tokens must be unique, normalized, and sorted');
  }
  if (
    candidate.sourceEvidence.field !== 'tags' ||
    candidate.targetEvidence.field !== 'tags' ||
    !/^[a-f0-9]{64}$/.test(candidate.sourceEvidence.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(candidate.targetEvidence.fingerprint)
  ) {
    throw new Error('GRAPH-046 candidate evidence fingerprints are malformed');
  }
  const ontology = validateRelation(candidate.sourceType, candidate.targetType, candidate.relationType);
  if (!ontology.valid || ontology.shouldSwap || candidate.relationType === 'custom') {
    throw new Error('GRAPH-046 candidate violates canonical relation ontology/direction');
  }
  if (!isExpectedCandidateTopology(candidate)) {
    throw new Error('GRAPH-046 candidate is outside the reviewed decision-entity mapping');
  }
}

export function assertGraphReachabilityPlanIntegrity(plan: GraphReachabilityPlan): void {
  const { planSha256, ...payload } = plan;
  if (!/^[a-f0-9]{64}$/.test(planSha256) || sha256Json(payload) !== planSha256) {
    throw new Error('GRAPH-046 plan payload no longer matches its SHA-256');
  }
  normalizeTarget(plan.target);
  if (
    plan.schemaVersion !== GRAPH_REACHABILITY_SCHEMA_VERSION ||
    plan.operation !== GRAPH_REACHABILITY_OPERATION ||
    plan.algorithm !== GRAPH_REACHABILITY_ALGORITHM
  ) {
    throw new Error('GRAPH-046 plan contract/version is not supported');
  }
  if (
    !Number.isSafeInteger(plan.policy.minTagOverlap) ||
    plan.policy.minTagOverlap < 1 ||
    plan.policy.minTagOverlap > 20 ||
    !Number.isSafeInteger(plan.policy.triageTopN) ||
    plan.policy.triageTopN < 0 ||
    plan.policy.triageTopN > 1_000
  ) {
    throw new Error('GRAPH-046 plan policy bounds are invalid');
  }
  const { triage } = plan;
  if (
    triage.emittedCount !== triage.candidates.length ||
    triage.emittedCount > plan.policy.triageTopN ||
    triage.inferableTotal < triage.emittedCount ||
    triage.omittedCount !== triage.inferableTotal - triage.emittedCount
  ) {
    throw new Error('GRAPH-046 plan triage counts are inconsistent');
  }
  const keys = new Set<string>();
  let previous: TriageCandidate | null = null;
  for (const candidate of triage.candidates) {
    assertCandidateIntegrity(candidate);
    const key = triageCandidateKey(candidate);
    if (keys.has(key)) throw new Error(`GRAPH-046 plan contains duplicate candidate ${key}`);
    if (
      previous &&
      (candidate.overlap > previous.overlap ||
        (candidate.overlap === previous.overlap && compareText(key, triageCandidateKey(previous)) < 0))
    ) {
      throw new Error('GRAPH-046 plan candidates are not in deterministic rank order');
    }
    keys.add(key);
    previous = candidate;
  }
}

export function buildStageConfirmation(target: GraphReachabilityTarget, planSha256: string): string {
  const normalized = normalizeTarget(target);
  if (!/^[a-f0-9]{64}$/.test(planSha256)) throw new Error('Plan SHA-256 must be 64 lowercase hex characters');
  return [
    'STAGE GRAPH-046 PROPOSALS',
    `project=${normalized.firestoreProjectId}`,
    `database=${normalized.neo4jDatabase}`,
    `databaseId=${normalized.neo4jDatabaseId}`,
    `firestoreDatabase=${normalized.firestoreDatabaseId}`,
    `firestoreMode=${normalized.firestoreMode}`,
    `firestoreEndpoint=${normalized.firestoreEndpoint}`,
    `plan=${planSha256}`,
  ].join(' ');
}

export function assertStageAuthorization(input: StageAuthorizationInput): void {
  const planned = normalizeTarget(input.plannedTarget);
  const graphHostname = new URL(planned.neo4jUri).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(graphHostname)) {
    throw new Error('GRAPH-046 staging requires a loopback Neo4j target');
  }
  assertExactTargetIdentity(planned, input.currentTarget);
  if (input.expectedPlanSha256 !== input.planSha256) {
    throw new Error(
      `Graph reachability plan hash mismatch: expected ${input.expectedPlanSha256}, received ${input.planSha256}`
    );
  }
  const expectedConfirmation = buildStageConfirmation(planned, input.planSha256);
  if (input.confirmation !== expectedConfirmation) {
    throw new Error(`Staging confirmation mismatch. Required exact phrase: ${expectedConfirmation}`);
  }
}

function toMinimalSnapshot(snapshot: EntitySnapshot): MinimalEntitySnapshot {
  return {
    type: snapshot.type,
    id: snapshot.id,
    name: snapshot.name.slice(0, 100),
    ...(snapshot.description ? { description: snapshot.description.slice(0, 500) } : {}),
    ...(snapshot.status ? { status: snapshot.status } : {}),
    snapshotAt: snapshot.snapshotAt,
  };
}

function evidenceForCandidate(candidate: TriageCandidate, extractedAt: number): CreateProposedRelationInput['evidence'] {
  const snippet = `Shared normalized tags: ${candidate.sharedTokens.join(', ')}`.slice(0, 500);
  const snippetHash = createHash('sha256').update(snippet).digest('hex');
  return [candidate.sourceId, candidate.targetId].map((sourceId, index) => ({
    sourceType: 'entity_field' as const,
    sourceId,
    location: {
      entityType: index === 0 ? candidate.sourceType : candidate.targetType,
      field: 'tags',
    },
    snippet,
    snippetHash,
    extractedAt,
  }));
}

function stageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

/**
 * Stage pending triage proposals only. It exposes no normalized-relation write
 * dependency, so approval remains exclusively in the human triage workflow.
 */
async function stageTriageCandidates(
  plan: GraphReachabilityPlan,
  dependencies: StageTriageDependencies
): Promise<StageTriageResult> {
  const outcomes: StageCandidateOutcome[] = [];
  const now = dependencies.now?.() ?? Date.now();

  for (const candidate of plan.triage.candidates) {
    const candidateKey = triageCandidateKey(candidate);
    let sourceSnapshot: EntitySnapshot;
    let targetSnapshot: EntitySnapshot;
    try {
      const [source, target] = await Promise.all([
        dependencies.resolveEvidenceEntity(candidate.sourceId, candidate.sourceType),
        dependencies.resolveEvidenceEntity(candidate.targetId, candidate.targetType),
      ]);
      sourceSnapshot = source.snapshot;
      targetSnapshot = target.snapshot;
      if (
        sourceSnapshot.id !== candidate.sourceId ||
        sourceSnapshot.type !== candidate.sourceType ||
        targetSnapshot.id !== candidate.targetId ||
        targetSnapshot.type !== candidate.targetType
      ) {
        throw new Error('Firestore endpoint identity does not match the audited candidate');
      }
      if (
        sha256Json(normalizeTagTokens(source.tags)) !== candidate.sourceEvidence.fingerprint ||
        sha256Json(normalizeTagTokens(target.tags)) !== candidate.targetEvidence.fingerprint
      ) {
        throw new Error('Firestore tag evidence changed after the GRAPH-046 audit');
      }
      const targetTokens = new Set(normalizeTagTokens(target.tags));
      const currentSharedTokens = normalizeTagTokens(source.tags).filter((token) => targetTokens.has(token));
      if (
        currentSharedTokens.length !== candidate.sharedTokens.length ||
        currentSharedTokens.some((token, index) => token !== candidate.sharedTokens[index])
      ) {
        throw new Error('Firestore shared-tag evidence no longer matches the GRAPH-046 plan');
      }
      await dependencies.assertStillBusinessUnreachable(candidate);
      const existing = await dependencies.findExistingRelation(
        candidate.sourceId,
        candidate.targetId,
        candidate.relationType
      );
      if (existing) {
        outcomes.push({ candidateKey, status: 'relation-resync-required', relationId: existing.id });
        continue;
      }
    } catch (error) {
      outcomes.push({ candidateKey, status: 'failed', phase: 'preflight', error: stageError(error) });
      continue;
    }

    try {
      const result = await dependencies.createProposal({
        sourceId: candidate.sourceId,
        sourceType: candidate.sourceType,
        sourceSnapshot: toMinimalSnapshot(sourceSnapshot),
        targetId: candidate.targetId,
        targetType: candidate.targetType,
        targetSnapshot: toMinimalSnapshot(targetSnapshot),
        relationType: candidate.relationType,
        confidence: Math.min(55, 35 + candidate.overlap * 3),
        reasoning:
          `Heuristic ${candidate.relationType} suggestion between ${sourceSnapshot.name} and ` +
          `${targetSnapshot.name}. The shared tags (${candidate.sharedTokens.join(', ')}) support topical ` +
          `association only; they do not prove the predicate. Human review required.`,
        evidence: evidenceForCandidate(candidate, now),
        discoveredBy: 'linker-agent',
        runId: `graph-046:${plan.planSha256}`,
        promptVersion: GRAPH_REACHABILITY_ALGORITHM,
      });
      outcomes.push(
        result.created
          ? { candidateKey, status: 'created', proposalId: result.proposal.id }
          : {
              candidateKey,
              status: 'deduplicated',
              proposalId: result.proposal.id,
              ...(result.reason ? { reason: result.reason } : {}),
            }
      );
    } catch (error) {
      outcomes.push({ candidateKey, status: 'failed', phase: 'write', error: stageError(error) });
    }
  }

  const count = (status: StageCandidateOutcome['status']): number =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const failed = count('failed');
  return {
    ok: failed === 0,
    attempted: outcomes.length,
    created: count('created'),
    deduplicated: count('deduplicated'),
    relationResyncRequired: count('relation-resync-required'),
    failed,
    outcomes,
  };
}

/**
 * The only exported write entry point. Future script imports cannot stage by
 * calling the internal helper without re-proving the target and confirmation.
 */
export async function authorizeAndStageTriageCandidates(
  plan: GraphReachabilityPlan,
  input: {
    currentTarget: GraphReachabilityTarget;
    expectedPlanSha256: string;
    confirmation: string;
  },
  dependencies: StageTriageDependencies
): Promise<StageTriageResult> {
  assertGraphReachabilityPlanIntegrity(plan);
  assertStageAuthorization({
    plannedTarget: plan.target,
    currentTarget: input.currentTarget,
    planSha256: plan.planSha256,
    expectedPlanSha256: input.expectedPlanSha256,
    confirmation: input.confirmation,
  });
  return stageTriageCandidates(plan, dependencies);
}
