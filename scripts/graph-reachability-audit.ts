#!/usr/bin/env npx tsx
/**
 * GRAPH-046: identity-bound useful-reachability audit and optional triage staging.
 *
 * Default execution is read-only. A staging run can only create pending
 * `proposedRelations`; it has no normalized Relation or Neo4j write surface.
 * Staging requires a separately observed plan hash and an exact confirmation
 * bound to the Firestore project and Neo4j database identity.
 */
import './load-env-local';

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import type { EntityType } from '@/lib/types';
import {
  BUSINESS_ENTITY_LABELS,
  GRAPH_REACHABILITY_ALGORITHM,
  GRAPH_REACHABILITY_OPERATION,
  GRAPH_REACHABILITY_SCHEMA_VERSION,
  assertExactTargetIdentity,
  authorizeAndStageTriageCandidates,
  boundTriageCandidates,
  buildGraphReachabilityPlan,
  buildReachabilityBenchmark,
  buildStageConfirmation,
  classifyDecisionReachability,
  classifyDisconnectedDecisionEntity,
  listTriageCandidates,
  normalizeTarget,
  type CandidateEntity,
  type CandidateLabel,
  type ClassifiedDisconnected,
  type DecisionGapClass,
  type DecisionLabel,
  type DecisionNodeFact,
  type ExpectedGraphReachabilityTarget,
  type GraphReachabilityPlan,
  type GraphReachabilityTarget,
  type LabelReachability,
  type RelationProjectionResync,
  type StageTriageDependencies,
  type StageTriageResult,
  type SupportedDecisionLabel,
  type TriageCandidate,
} from './lib/graph-reachability';

const DECISION_LABELS: DecisionLabel[] = ['PainPoint', 'UseCase', 'Signal'];
const CANDIDATE_LABELS: CandidateLabel[] = ['Technology', 'OrgUnit', 'Initiative', 'Document'];
const DEFAULT_MIN_TAG_OVERLAP = 2;
const DEFAULT_TRIAGE_TOP_N = 25;
const FIRESTORE_DATABASE_ID = '(default)';
const DECISION_ENTITY_TYPES: Record<DecisionLabel, EntityType> = {
  PainPoint: 'painPoint',
  UseCase: 'useCase',
  Signal: 'signal',
};
const CANDIDATE_ENTITY_TYPES: Record<CandidateLabel, EntityType> = {
  Technology: 'technology',
  OrgUnit: 'orgUnit',
  Initiative: 'initiative',
  Document: 'document',
};

export interface SignalProjectionFacts {
  eligibleSignalIds: Set<string>;
}

export interface AuthoritativeDecisionFact {
  id: string;
  name: string;
  tags: string[];
}

export interface CandidateProjectionFact {
  id: string;
  graphCount: number;
}

export interface GraphReachabilityDependencies {
  readTargetIdentity(): Promise<GraphReachabilityTarget>;
  readDecisionNodes(label: DecisionLabel): Promise<DecisionNodeFact[]>;
  readAuthoritativeDecisionNodes(label: DecisionLabel): Promise<AuthoritativeDecisionFact[]>;
  readCandidateEntities(label: CandidateLabel): Promise<CandidateEntity[]>;
  readCandidateProjectionFacts(label: CandidateLabel): Promise<CandidateProjectionFact[]>;
  readSignalProjectionFacts(): Promise<SignalProjectionFacts>;
  stage: StageTriageDependencies;
}

export interface GraphReachabilityAuditOptions {
  expectedTarget: ExpectedGraphReachabilityTarget;
  minTagOverlap: number;
  triageTopN: number;
  stageAuthorization?: {
    expectedPlanSha256: string;
    confirmation: string;
  };
}

export interface GraphReachabilityAuditResult {
  plan: GraphReachabilityPlan;
  staging: StageTriageResult | null;
}

interface CliOptions extends GraphReachabilityAuditOptions {
  outPath: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyGapCounts(): Record<DecisionGapClass, number> {
  return {
    'inferable-candidate': 0,
    'ambiguous-candidate': 0,
    'curation-gap-no-evidence': 0,
    'untagged-gap': 0,
    'graph-only-source-drift': 0,
  };
}

function assertBoundedInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}`);
  }
}

export async function runGraphReachabilityAudit(
  dependencies: GraphReachabilityDependencies,
  options: GraphReachabilityAuditOptions
): Promise<GraphReachabilityAuditResult> {
  assertBoundedInteger(options.minTagOverlap, 'minTagOverlap', 1, 20);
  assertBoundedInteger(options.triageTopN, 'triageTopN', 0, 1_000);

  const initialTarget = assertExactTargetIdentity(
    options.expectedTarget,
    await dependencies.readTargetIdentity()
  );
  const [candidateGroups, candidateProjectionGroups, signalFacts, decisionGroups, authoritativeGroups] = await Promise.all([
    Promise.all(CANDIDATE_LABELS.map((label) => dependencies.readCandidateEntities(label))),
    Promise.all(CANDIDATE_LABELS.map((label) => dependencies.readCandidateProjectionFacts(label))),
    dependencies.readSignalProjectionFacts(),
    Promise.all(DECISION_LABELS.map((label) => dependencies.readDecisionNodes(label))),
    Promise.all(DECISION_LABELS.map((label) => dependencies.readAuthoritativeDecisionNodes(label))),
  ]);
  const candidates: CandidateEntity[] = [];
  const candidateProjectionResync: GraphReachabilityPlan['candidateProjectionResync'] = [];
  for (let index = 0; index < CANDIDATE_LABELS.length; index += 1) {
    const label = CANDIDATE_LABELS[index];
    const authoritativeCandidates = [...candidateGroups[index]].sort((left, right) => compareText(left.id, right.id));
    const projectionById = new Map(
      candidateProjectionGroups[index].map((entry) => [entry.id, entry.graphCount])
    );
    const authoritativeIds = new Set(authoritativeCandidates.map((entry) => entry.id));
    const missingGraphIds = authoritativeCandidates
      .filter((entry) => !projectionById.has(entry.id))
      .map((entry) => entry.id);
    const duplicateGraphIds = authoritativeCandidates
      .filter((entry) => (projectionById.get(entry.id) ?? 0) > 1)
      .map((entry) => entry.id);
    const graphOnlyIds = [...projectionById.keys()]
      .filter((id) => !authoritativeIds.has(id))
      .sort(compareText);
    candidateProjectionResync.push({
      label,
      authoritativeCount: authoritativeCandidates.length,
      graphCount: [...projectionById.keys()].filter((id) => authoritativeIds.has(id)).length,
      missingGraphIds,
      duplicateGraphIds,
      graphOnlyIds,
    });
    candidates.push(
      ...authoritativeCandidates.filter((entry) => projectionById.get(entry.id) === 1)
    );
  }
  candidates.sort((left, right) => compareText(left.label, right.label) || compareText(left.id, right.id));

  const perLabel: LabelReachability[] = [];
  const disconnectedDecision: ClassifiedDisconnected[] = [];
  const signalPolicyBreakdown = {
    policyCorrectInbox: 0,
    eligibleButUnlinked: 0,
    policyIneligibleProjected: 0,
    policyIneligibleProjectedIds: [] as string[],
  };
  const gapBreakdown: Record<SupportedDecisionLabel, Record<DecisionGapClass, number>> = {
    PainPoint: emptyGapCounts(),
    UseCase: emptyGapCounts(),
  };
  const entityProjectionResync: GraphReachabilityPlan['entityProjectionResync'] = [];

  for (let index = 0; index < DECISION_LABELS.length; index += 1) {
    const label = DECISION_LABELS[index];
    const nodes = [...decisionGroups[index]].sort((left, right) => compareText(left.id, right.id));
    const authoritative = [...authoritativeGroups[index]].sort((left, right) => compareText(left.id, right.id));
    const authoritativeForProjection =
      label === 'Signal'
        ? authoritative.filter((entry) => signalFacts.eligibleSignalIds.has(entry.id))
        : authoritative;
    const graphById = new Map<string, DecisionNodeFact[]>();
    for (const node of nodes) graphById.set(node.id, [...(graphById.get(node.id) ?? []), node]);
    const authoritativeIds = new Set(authoritativeForProjection.map((entry) => entry.id));
    const allAuthoritativeIds = new Set(authoritative.map((entry) => entry.id));
    const missingGraphIds = authoritativeForProjection
      .filter((entry) => !graphById.has(entry.id))
      .map((entry) => entry.id);
    const graphOnlyIds = [...graphById.keys()]
      .filter((id) => !allAuthoritativeIds.has(id))
      .sort(compareText);
    const duplicateGraphIds = [...graphById.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([id]) => id)
      .sort(compareText);
    entityProjectionResync.push({
      label,
      authoritativeCount: authoritativeForProjection.length,
      graphCount: [...graphById.keys()].filter((id) => authoritativeIds.has(id)).length,
      missingGraphCount: missingGraphIds.length,
      missingGraphIds,
      graphOnlyCount: graphOnlyIds.length,
      graphOnlyIds,
      duplicateGraphIdCount: duplicateGraphIds.length,
      duplicateGraphIds,
    });
    let businessReachable = 0;
    let memoryOnly = 0;
    let disconnected = 0;
    if (label === 'Signal') {
      const ineligible = authoritative.filter((entry) => !signalFacts.eligibleSignalIds.has(entry.id));
      const projectedIneligibleIds = ineligible
        .filter((entry) => graphById.has(entry.id))
        .map((entry) => entry.id);
      signalPolicyBreakdown.policyCorrectInbox += ineligible.length - projectedIneligibleIds.length;
      signalPolicyBreakdown.policyIneligibleProjected += projectedIneligibleIds.length;
      signalPolicyBreakdown.policyIneligibleProjectedIds.push(...projectedIneligibleIds);
    } else {
      gapBreakdown[label]['graph-only-source-drift'] += graphOnlyIds.length;
    }
    for (const authoritativeNode of authoritativeForProjection) {
      const graphRows = graphById.get(authoritativeNode.id) ?? [];
      if (graphRows.length !== 1) {
        disconnected += 1;
        if (label === 'Signal') signalPolicyBreakdown.eligibleButUnlinked += 1;
        continue;
      }
      const node = graphRows[0];
      const reachability = classifyDecisionReachability(node);
      if (reachability === 'business-reachable') businessReachable += 1;
      else if (reachability === 'memory-only') memoryOnly += 1;
      else disconnected += 1;

      if (reachability !== 'business-reachable' && label === 'Signal') {
        signalPolicyBreakdown.eligibleButUnlinked += 1;
      } else if (reachability !== 'business-reachable' && label !== 'Signal') {
        const result = classifyDisconnectedDecisionEntity({
          node: { ...node, name: authoritativeNode.name, tags: authoritativeNode.tags },
          candidates,
          minOverlap: options.minTagOverlap,
        });
        disconnectedDecision.push({
          node: { ...node, name: authoritativeNode.name, tags: authoritativeNode.tags },
          ...result,
        });
        gapBreakdown[label][result.classification] += 1;
      }
    }
    perLabel.push({
      label,
      total: authoritativeForProjection.length,
      businessReachable,
      memoryOnly,
      disconnected,
    });
  }

  const allTriageCandidates = listTriageCandidates(disconnectedDecision);
  const relationProjectionResync: RelationProjectionResync[] = [];
  const proposalCandidates: TriageCandidate[] = [];
  for (const candidate of allTriageCandidates) {
    const existing = await dependencies.stage.findExistingRelation(
      candidate.sourceId,
      candidate.targetId,
      candidate.relationType
    );
    if (existing) {
      relationProjectionResync.push({
        sourceId: candidate.sourceId,
        sourceType: candidate.sourceType,
        targetId: candidate.targetId,
        targetType: candidate.targetType,
        relationType: candidate.relationType,
        relationId: existing.id,
        reason: 'firestore-relation-missing-active-graph-edge',
      });
    } else {
      proposalCandidates.push(candidate);
    }
  }

  const plan = buildGraphReachabilityPlan({
    schemaVersion: GRAPH_REACHABILITY_SCHEMA_VERSION,
    operation: GRAPH_REACHABILITY_OPERATION,
    algorithm: GRAPH_REACHABILITY_ALGORITHM,
    target: initialTarget,
    policy: {
      minTagOverlap: options.minTagOverlap,
      triageTopN: options.triageTopN,
      signalProjection: 'approved-or-referenced',
    },
    benchmark: buildReachabilityBenchmark(perLabel),
    signalPolicyBreakdown,
    entityProjectionResync,
    candidateProjectionResync,
    relationProjectionResync,
    gapBreakdown,
    triage: boundTriageCandidates(proposalCandidates, { topN: options.triageTopN }),
  });

  if (!options.stageAuthorization) return { plan, staging: null };

  // Re-read both stores' exact identity after the complete audit and directly
  // before exposing the pending-proposal writer.
  const currentTarget = assertExactTargetIdentity(
    options.expectedTarget,
    await dependencies.readTargetIdentity()
  );
  return {
    plan,
    staging: await authorizeAndStageTriageCandidates(
      plan,
      {
        currentTarget,
        expectedPlanSha256: options.stageAuthorization.expectedPlanSha256,
        confirmation: options.stageAuthorization.confirmation,
      },
      dependencies.stage
    ),
  };
}

function requiredValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseIntegerFlag(args: string[], flag: string, fallback: number): number {
  const value = optionalValue(args, flag);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be an integer`);
  return Number(value);
}

export function parseGraphReachabilityCli(args: string[]): CliOptions {
  const knownValueFlags = new Set([
    '--out',
    '--expect-neo4j-uri',
    '--expect-neo4j-database',
    '--expect-neo4j-database-id',
    '--expect-firestore-project',
    '--expect-firestore-database',
    '--expect-firestore-mode',
    '--expect-firestore-endpoint',
    '--min-tag-overlap',
    '--top-n',
    '--expect-plan-hash',
    '--confirm-staging',
  ]);
  const knownBooleanFlags = new Set(['--stage-proposals']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (knownValueFlags.has(token)) {
      index += 1;
      if (index >= args.length) throw new Error(`${token} requires a value`);
    } else if (!knownBooleanFlags.has(token)) {
      throw new Error(`Unknown GRAPH-046 option: ${token}`);
    }
  }

  const stageRequested = args.includes('--stage-proposals');
  const expectedPlanSha256 = optionalValue(args, '--expect-plan-hash');
  const confirmation = optionalValue(args, '--confirm-staging');
  if (stageRequested && (!expectedPlanSha256 || !confirmation)) {
    throw new Error('--stage-proposals requires --expect-plan-hash and --confirm-staging');
  }
  if (!stageRequested && (expectedPlanSha256 || confirmation)) {
    throw new Error('--expect-plan-hash and --confirm-staging are only valid with --stage-proposals');
  }

  return {
    outPath:
      optionalValue(args, '--out') ?? 'reports/graph-data-quality/graph-046-reachability.json',
    expectedTarget: {
      neo4jUri: requiredValue(args, '--expect-neo4j-uri'),
      neo4jDatabase: requiredValue(args, '--expect-neo4j-database'),
      neo4jDatabaseId: requiredValue(args, '--expect-neo4j-database-id'),
      firestoreProjectId: requiredValue(args, '--expect-firestore-project'),
      firestoreDatabaseId: requiredValue(args, '--expect-firestore-database'),
      firestoreMode: requiredValue(args, '--expect-firestore-mode') as 'emulator' | 'live',
      firestoreEndpoint: requiredValue(args, '--expect-firestore-endpoint'),
    },
    minTagOverlap: parseIntegerFlag(args, '--min-tag-overlap', DEFAULT_MIN_TAG_OVERLAP),
    triageTopN: parseIntegerFlag(args, '--top-n', DEFAULT_TRIAGE_TOP_N),
    ...(stageRequested
      ? { stageAuthorization: { expectedPlanSha256: expectedPlanSha256!, confirmation: confirmation! } }
      : {}),
  };
}

function configuredProjectId(env: NodeJS.ProcessEnv): string {
  const entries = [
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    env.FIREBASE_PROJECT_ID,
    env.GOOGLE_CLOUD_PROJECT,
    env.GCLOUD_PROJECT,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(entries)];
  if (unique.length !== 1) {
    throw new Error(
      unique.length === 0
        ? 'Firestore project identity must be explicitly configured'
        : `Conflicting Firestore project identities: ${unique.join(', ')}`
    );
  }
  return unique[0];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function productionDependencies(): Promise<GraphReachabilityDependencies> {
  const [{ adminApp, db }, graph, signalPolicy] = await Promise.all([
    import('@/lib/firebase-admin'),
    import('@/lib/graph/neo4j-client'),
    import('@/lib/graph/signal-projection-policy'),
  ]);
  const projectId = configuredProjectId(process.env);
  const adminProjectId = adminApp.options.projectId?.trim();
  if (adminProjectId !== projectId) {
    throw new Error(`Firestore Admin project mismatch: configured ${projectId}, connected ${adminProjectId}`);
  }

  const readTargetIdentity = async (): Promise<GraphReachabilityTarget> => {
    const identity = await graph.runReadTransaction<{ database: string; databaseId: string }>(
      `CALL db.info() YIELD name, id
       RETURN name AS database, toString(id) AS databaseId`
    );
    if (identity.records.length !== 1) throw new Error('Neo4j target identity did not resolve exactly once');
    const row = identity.records[0];
    if (!row?.database || !row.databaseId) throw new Error('Neo4j returned a malformed database identity');
    return normalizeTarget({
      neo4jUri: graph.getNeo4jConfig().uri,
      neo4jDatabase: row.database,
      neo4jDatabaseId: row.databaseId,
      firestoreProjectId: adminProjectId,
      firestoreDatabaseId: FIRESTORE_DATABASE_ID,
      firestoreMode: process.env.FIRESTORE_EMULATOR_HOST ? 'emulator' : 'live',
      firestoreEndpoint: process.env.FIRESTORE_EMULATOR_HOST ?? 'firestore.googleapis.com',
    });
  };

  return {
    readTargetIdentity,
    async readDecisionNodes(label) {
      const result = await graph.runReadTransaction<{
        id: string;
        name: string | null;
        tags: unknown;
        neighborLabels: unknown;
      }>(
        `MATCH (node:${label})
         OPTIONAL MATCH (node)-[edge]-(neighbor)
         WHERE edge.t_invalidated IS NULL
         WITH node, collect(labels(neighbor)) AS neighborLabels
         RETURN node.id AS id,
                coalesce(node.name, node.title, node.id) AS name,
                node.tags AS tags,
                [labels IN neighborLabels WHERE size(labels) > 0] AS neighborLabels`,
        {}
      );
      return result.records.map((row) => {
        if (!row.id) throw new Error(`${label} node is missing its stable id`);
        return {
          label,
          id: row.id,
          name: row.name ?? row.id,
          tags: stringArray(row.tags),
          neighborLabels: Array.isArray(row.neighborLabels)
            ? row.neighborLabels.map(stringArray).filter((labels) => labels.length > 0)
            : [],
        };
      });
    },
    async readAuthoritativeDecisionNodes(label) {
      const collection = ENTITY_COLLECTIONS[DECISION_ENTITY_TYPES[label]];
      const snapshot = await db.collection(collection).select('name', 'title', 'tags').get();
      return snapshot.docs.map((document) => {
        const data = document.data() as { name?: unknown; title?: unknown; tags?: unknown };
        const name =
          typeof data.name === 'string'
            ? data.name
            : typeof data.title === 'string'
              ? data.title
              : document.id;
        return { id: document.id, name, tags: stringArray(data.tags) };
      });
    },
    async readCandidateEntities(label) {
      const collection = ENTITY_COLLECTIONS[CANDIDATE_ENTITY_TYPES[label]];
      const snapshot = await db.collection(collection).select('name', 'title', 'tags').get();
      return snapshot.docs.map((document) => {
        const data = document.data() as { name?: unknown; title?: unknown; tags?: unknown };
        const name =
          typeof data.name === 'string'
            ? data.name
            : typeof data.title === 'string'
              ? data.title
              : document.id;
        return {
          label,
          id: document.id,
          name,
          tags: stringArray(data.tags),
        };
      });
    },
    async readCandidateProjectionFacts(label) {
      const result = await graph.runReadTransaction<{ id: string; graphCount: number }>(
        `MATCH (node:${label})
         RETURN node.id AS id, count(*) AS graphCount`,
        {}
      );
      return result.records.map((row) => {
        if (!row.id || !Number.isSafeInteger(row.graphCount) || row.graphCount < 1) {
          throw new Error(`${label} projection inventory returned malformed identity/count data`);
        }
        return row;
      });
    },
    async readSignalProjectionFacts() {
      const [signals, relations, documentLinks] = await Promise.all([
        db.collection('signals').select('status').get(),
        db.collection('relations').select('sourceSnapshot', 'targetSnapshot').get(),
        db
          .collection('entityDocumentLinks')
          .where('entityType', '==', 'signal')
          .select('entityId')
          .get(),
      ]);
      const references = signalPolicy.collectSignalProjectionReferences({
        relations: relations.docs.map((document) => ({
          ...(document.data() as object),
          id: document.id,
        })),
        documentLinks: documentLinks.docs.map((document) => ({
          ...(document.data() as object),
          id: document.id,
          entityType: 'signal',
        })),
      });
      return {
        eligibleSignalIds: new Set(
          signals.docs
            .filter((document) =>
              signalPolicy.decideSignalProjection(
                (document.data() as { status?: unknown }).status,
                references.get(document.id)
              ).eligible
            )
            .map((document) => document.id)
        ),
      };
    },
    stage: {
      async resolveEvidenceEntity(id, type) {
        const { buildEntitySnapshot } = await import('@/lib/relations-admin');
        const [snapshot, document] = await Promise.all([
          buildEntitySnapshot(id, type),
          db.collection(ENTITY_COLLECTIONS[type]).doc(id).get(),
        ]);
        if (!document.exists) throw new Error(`Authoritative Firestore endpoint not found: ${type}:${id}`);
        return {
          snapshot,
          tags: stringArray((document.data() as { tags?: unknown }).tags),
        };
      },
      async assertStillBusinessUnreachable(candidate) {
        const result = await graph.runReadTransaction<{
          nodeCount: number;
          businessNeighborCount: number;
        }>(
          `MATCH (node:${candidate.nodeLabel} {id: $nodeId})
           OPTIONAL MATCH (node)-[edge]-(neighbor)
           WHERE edge.t_invalidated IS NULL
             AND any(label IN labels(neighbor) WHERE label IN $businessLabels)
           RETURN count(DISTINCT node) AS nodeCount,
                  count(DISTINCT neighbor) AS businessNeighborCount`,
          { nodeId: candidate.nodeId, businessLabels: [...BUSINESS_ENTITY_LABELS] }
        );
        const row = result.records[0];
        if (row?.nodeCount !== 1) {
          throw new Error(`Decision node projection changed or is ambiguous: ${candidate.nodeLabel}:${candidate.nodeId}`);
        }
        if (row.businessNeighborCount !== 0) {
          throw new Error(`Decision node became business-reachable after the GRAPH-046 audit: ${candidate.nodeId}`);
        }
      },
      async findExistingRelation(sourceId, targetId, relationType) {
        const { adminCheckDuplicateRelation } = await import('@/lib/relations-admin');
        return adminCheckDuplicateRelation(sourceId, targetId, relationType);
      },
      async createProposal(input) {
        const { createProposedRelationIfNotExists } = await import('@/lib/proposed-relations-admin');
        return createProposedRelationIfNotExists(input);
      },
    },
  };
}

function writeReceipt(
  outPath: string,
  result: GraphReachabilityAuditResult,
  generatedAt: string
): string {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify(
        {
          generatedAt,
          readOnly: result.staging === null,
          ...result,
        },
        null,
        2
      )}\n`
    );
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return resolved;
}

async function main(): Promise<void> {
  const options = parseGraphReachabilityCli(process.argv.slice(2));
  const dependencies = await productionDependencies();
  const result = await runGraphReachabilityAudit(dependencies, options);
  const output = writeReceipt(options.outPath, result, new Date().toISOString());
  console.log(`GRAPH-046 receipt: ${output}`);
  console.log(`Plan SHA-256: ${result.plan.planSha256}`);
  if (!result.staging) {
    console.log('No writes performed. To stage pending proposals, rerun with:');
    console.log(`--stage-proposals --expect-plan-hash ${result.plan.planSha256}`);
    console.log(`--confirm-staging "${buildStageConfirmation(result.plan.target, result.plan.planSha256)}"`);
  } else {
    console.log(JSON.stringify(result.staging, null, 2));
    if (!result.staging.ok) process.exitCode = 2;
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('graph-reachability-audit failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        const { closeDriver } = await import('@/lib/graph/neo4j-client');
        await closeDriver();
      } catch {
        // The original error/exit code is authoritative.
      }
    });
}
