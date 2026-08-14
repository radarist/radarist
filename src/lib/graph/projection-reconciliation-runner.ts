import 'server-only';

import { FieldPath } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { inngest } from '@/lib/inngest/client';
import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import { toMillis } from '@/lib/inngest/utils';
import {
  DOCUMENT_LINK_ENTITY_COLLECTIONS,
  DOCUMENT_LINK_ENTITY_LABELS,
  DOCUMENT_LINK_RELATIONSHIP_TYPES,
  isDocumentLinkEntityType,
  isDocumentRelationshipType,
} from './entity-document-link-graph-contract';
import {
  buildReconciliationRepairPlan,
  classifyAgentRunSource,
  nextReconciliationCursor,
  parseReconciliationCursor,
  parseRelationProjectionSource,
  RECONCILIATION_ACTION_LIMIT,
  RECONCILIATION_KINDS,
  RECONCILIATION_SCAN_LIMIT,
  RECONCILED_RELATION_PREDICATES,
  relationProjectionFingerprint,
  relationNeedsReplay,
  type ReconciliationKind,
  type ReconciliationRepairOperation,
  type ReconciliationRow,
  type RelationProjectionState,
  type RelationSourceShape,
} from './projection-reconciliation';
import {
  buildExpectedAgentRunProjection,
  classifyAgentRunProjection,
  projectAgentRunToNeo4j,
  type AgentRunGraphState,
  type AgentRunProjectionResult,
  type AgentRunSyncParams,
} from './agent-run-sync';
import { decideSignalProjection } from './signal-projection-policy';
import { loadReferencedSignalIds } from './signal-projection-policy-admin';
import type { EntityType } from '@/lib/types';
import { parseCorrelationId } from '@/lib/observability/correlation';
import { resolveRelationSourceFingerprint } from '@/lib/relation-source-version';
import {
  createEntitySourceFingerprint,
  parseEntitySourceFingerprint,
} from '@/lib/entity-source-version';
import {
  clearConvergedEntityGraphSyncAnchor,
  listEntityGraphSyncAnchorsForType,
} from '@/lib/entity-graph-sync-outbox-admin';
import { isEntityGraphSyncAnchorType } from '@/lib/entity-graph-sync-outbox';
import { ENTITY_DOCUMENT_LINK_ANCHOR_TYPE } from '@/lib/entity-document-link-handoff';

const CURSOR_COLLECTION = 'graphReconciliationCursors';
const MAX_RECONCILIATION_ERRORS = 50;

interface EntityProjectionConfig {
  kind: Exclude<
    ReconciliationKind,
    'radars' | 'radarPlacements' | 'concepts' | 'relations' | 'documentLinks' | 'agentRuns'
  >;
  collection: string;
  label: string;
  entityType: EntityType;
  dispatch: 'unified' | 'technology' | 'document';
}

export const ENTITY_PROJECTION_CONFIGS: readonly EntityProjectionConfig[] = [
  { kind: 'companies', collection: 'companies', label: 'Company', entityType: 'company', dispatch: 'unified' },
  {
    kind: 'technologies',
    collection: 'technologies',
    label: 'Technology',
    entityType: 'technology',
    dispatch: 'technology',
  },
  { kind: 'strategies', collection: 'strategies', label: 'Strategy', entityType: 'strategy', dispatch: 'unified' },
  { kind: 'painPoints', collection: 'painPoints', label: 'PainPoint', entityType: 'painPoint', dispatch: 'unified' },
  { kind: 'useCases', collection: 'use-cases', label: 'UseCase', entityType: 'useCase', dispatch: 'unified' },
  { kind: 'documents', collection: 'documents', label: 'Document', entityType: 'document', dispatch: 'document' },
  { kind: 'signals', collection: 'signals', label: 'Signal', entityType: 'signal', dispatch: 'unified' },
  { kind: 'orgUnits', collection: 'org-units', label: 'OrgUnit', entityType: 'orgUnit', dispatch: 'unified' },
  {
    kind: 'initiatives',
    collection: 'initiatives',
    label: 'Initiative',
    entityType: 'initiative',
    dispatch: 'unified',
  },
  { kind: 'prototypes', collection: 'prototypes', label: 'Prototype', entityType: 'prototype', dispatch: 'unified' },
];

const SPECIAL_KINDS = ['radars', 'radarPlacements', 'concepts', 'relations', 'documentLinks', 'agentRuns'] as const;

export function assertReconciliationRegistryComplete(): void {
  const configured = [...ENTITY_PROJECTION_CONFIGS.map((config) => config.kind), ...SPECIAL_KINDS];
  const missing = RECONCILIATION_KINDS.filter((kind) => !configured.includes(kind));
  const duplicate = configured.filter((kind, index) => configured.indexOf(kind) !== index);
  const unknown = configured.filter((kind) => !RECONCILIATION_KINDS.includes(kind));
  if (missing.length || duplicate.length || unknown.length) {
    throw new Error(
      `Incomplete reconciliation registry: missing=${missing.join(',')} duplicate=${duplicate.join(',')} unknown=${unknown.join(',')}`
    );
  }
  if (RECONCILIATION_ACTION_LIMIT * RECONCILIATION_KINDS.length > 100) {
    throw new Error('Per-kind reconciliation limits exceed the global 100-event cycle budget');
  }
}

interface ProjectionCount {
  firestore: number;
  neo4j: number;
  missing: number;
  stale: number;
  excluded?: number;
  source?: number;
  malformed?: number;
}

export interface KindCursorReport {
  scanned: number;
  dispatched: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  cycle: number;
  wrapped: boolean;
  errors: string[];
}

export type AgentRunReconciliationOutcome =
  | 'exact'
  | 'missing-node'
  | 'missing-edge'
  | 'pre-contract'
  | 'standalone'
  | 'malformed-source'
  | 'malformed-graph'
  | 'payload-conflict'
  | 'owner-conflict'
  | 'topology-conflict'
  | 'graph-only';

export interface AgentRunReconciliationEvidence {
  id: string;
  outcome: AgentRunReconciliationOutcome;
  reason: string;
  projectorResult?: AgentRunProjectionResult;
}

export interface AgentRunReconciliationCategory {
  /** Exact IDs only for the bounded pages scanned in this cycle. */
  ids: string[];
  count: number;
}

export interface AgentRunRepairSummary {
  attempted: number;
  applied: number;
  created: number;
  healed: number;
  unchanged: number;
  conflict: number;
  invalidOwnership: number;
}

export interface AgentRunReconciliationReport {
  /** Firestore page evidence, never an all-history total. */
  source: KindCursorReport & { eligible: number; repaired: number };
  /** Neo4j page evidence, never an all-history total. */
  reverse: KindCursorReport & { graphOnlyIds: string[] };
  /** Independently paged corrupt Neo4j nodes that cannot use the string-ID cursor. */
  malformedGraph: KindCursorReport & { elementIds: string[] };
  classifications: AgentRunReconciliationEvidence[];
  categories: Record<AgentRunReconciliationOutcome, AgentRunReconciliationCategory>;
  repairs: AgentRunRepairSummary;
  errors: string[];
  operations: ReconciliationRepairOperation[];
}

export interface ScheduledReconciliationReport {
  timestamp: number;
  entities: Record<string, ProjectionCount>;
  relations: ProjectionCount;
  documentLinks: ProjectionCount & { orphaned: number };
  agentRuns: AgentRunReconciliationReport;
  cursors: Partial<Record<ReconciliationKind, KindCursorReport>>;
  reverse: Partial<Record<ReconciliationKind, string[]>>;
  syncsTriggered: number;
  repairsApplied: number;
  errors: string[];
  repairPlan: ReturnType<typeof buildReconciliationRepairPlan>;
}

interface CursorAction {
  reason: string;
  dispatch: () => Promise<void>;
}

interface CursorClassification {
  action?: CursorAction;
  reportOnly?: ReconciliationRepairOperation;
}

async function getOrderedRows(collection: string): Promise<ReconciliationRow[]> {
  const snapshot = await db.collection(collection).orderBy(FieldPath.documentId()).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

async function getCursorRows(
  collection: string,
  afterId: string | null
): Promise<{ rows: ReconciliationRow[]; wrapped: boolean }> {
  const ordered = db.collection(collection).orderBy(FieldPath.documentId());
  const forward =
    afterId === null
      ? await ordered.limit(RECONCILIATION_SCAN_LIMIT).get()
      : await ordered.startAfter(afterId).limit(RECONCILIATION_SCAN_LIMIT).get();
  if (!forward.empty || afterId === null) {
    return {
      rows: forward.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
      wrapped: false,
    };
  }
  const wrapped = await ordered.limit(RECONCILIATION_SCAN_LIMIT).get();
  return {
    rows: wrapped.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
    wrapped: true,
  };
}

async function getNeo4jIds(label: string): Promise<Set<string>> {
  const result = await runReadTransaction<{ id: string }>(`MATCH (node:${label}) RETURN node.id AS id`, {});
  return new Set(result.records.flatMap((record) => (typeof record.id === 'string' ? [record.id] : [])));
}

/** Projected state an entity reconciliation compares the source against. */
interface EntityProjectionState {
  /** Only meaningful for Signals, whose eligibility policy also checks status. */
  status: unknown;
  /** GRAPH-056: fingerprint of the source content that produced this node. */
  sourceFingerprint: unknown;
}

/**
 * Read what the graph currently holds for one label.
 *
 * Before GRAPH-056 this read returned ids alone, so an entity whose projection
 * existed but was several versions behind was reported as healthy forever —
 * exactly the drift a failed handoff leaves. Carrying the stamped fingerprint
 * is what lets staleness be detected rather than only absence.
 */
async function getNeo4jEntityStates(label: string): Promise<Map<string, EntityProjectionState>> {
  const result = await runReadTransaction<{ id: string; status: unknown; sourceFingerprint: unknown }>(
    `MATCH (node:${label}) RETURN node.id AS id, node.status AS status, node.sourceFingerprint AS sourceFingerprint`,
    {}
  );
  return new Map(
    result.records.flatMap((record) =>
      typeof record.id === 'string'
        ? ([
            [record.id, { status: record.status, sourceFingerprint: record.sourceFingerprint }],
          ] as Array<[string, EntityProjectionState]>)
        : []
    )
  );
}

/** Why a projection does not currently match its source document. */
type EntityProjectionDrift =
  | 'missing-projection'
  | 'pre-contract-projection'
  | 'malformed-projection-fingerprint'
  | 'stale-source-version';

/**
 * Compare one document against its projection.
 *
 * A malformed stored fingerprint is healed rather than thrown, and counted
 * separately so the corruption stays visible: throwing would wedge this kind's
 * cursor page on the same document every cycle, while a replay re-stamps a
 * valid fingerprint and converges.
 */
function classifyEntityProjection(
  state: EntityProjectionState | undefined,
  expectedFingerprint: string
): EntityProjectionDrift | null {
  if (!state) return 'missing-projection';
  if (state.sourceFingerprint === undefined || state.sourceFingerprint === null) {
    // Projected before this contract existed; one replay stamps it.
    return 'pre-contract-projection';
  }
  const actual = parseEntitySourceFingerprint(state.sourceFingerprint);
  if (!actual) return 'malformed-projection-fingerprint';
  return actual === expectedFingerprint ? null : 'stale-source-version';
}

async function requireAccepted(send: Promise<{ ids?: string[] }>): Promise<void> {
  const accepted = await send;
  if (!accepted.ids?.length) throw new Error('Inngest accepted no reconciliation event');
}

function eventId(kind: ReconciliationKind, cycle: number, id: string): string {
  return `graph-reconcile-v1:${kind}:${cycle}:${id}`;
}

async function dispatchEntity(config: EntityProjectionConfig, id: string, cycle: number): Promise<void> {
  if (config.dispatch === 'technology') {
    return requireAccepted(
      inngest.send({
        id: eventId(config.kind, cycle, id),
        name: 'app/technology.sync.requested',
        data: { operation: 'update', technologyId: id },
      })
    );
  }
  if (config.dispatch === 'document') {
    return requireAccepted(
      inngest.send({
        id: eventId(config.kind, cycle, id),
        name: 'app/document.sync.requested',
        data: { operation: 'update', documentId: id },
      })
    );
  }
  return requireAccepted(
    inngest.send({
      id: eventId(config.kind, cycle, id),
      name: 'app/unified-entity.sync.requested',
      data: { operation: 'update', entityType: config.entityType, entityId: id },
    })
  );
}

async function loadCursor(kind: string) {
  const snapshot = await db.collection(CURSOR_COLLECTION).doc(kind).get();
  return parseReconciliationCursor(snapshot.exists ? snapshot.data() : null);
}

async function persistCursor(
  kind: string,
  cursor: ReturnType<typeof nextReconciliationCursor>
): Promise<void> {
  await db.collection(CURSOR_COLLECTION).doc(kind).set({ ...cursor, updatedAt: Date.now() });
}

async function processCursorPage(
  kind: ReconciliationKind,
  collection: string,
  classify: (row: ReconciliationRow, cycle: number) => Promise<CursorClassification>
): Promise<{ report: KindCursorReport; operations: ReconciliationRepairOperation[] }> {
  const cursor = await loadCursor(kind);
  const page = await getCursorRows(collection, cursor.afterId);
  const dispatchCycle = cursor.cycle + (page.wrapped ? 1 : 0);
  const errors: string[] = [];
  const operations: ReconciliationRepairOperation[] = [];
  let lastClassifiedId = page.rows.length === 0 ? null : cursor.afterId;
  let dispatched = 0;
  let scanned = 0;

  for (const row of page.rows) {
    let classification: CursorClassification;
    try {
      classification = await classify(row, dispatchCycle);
    } catch (error) {
      errors.push(`${kind}/${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }

    if (classification.reportOnly) operations.push(classification.reportOnly);
    if (classification.action) {
      if (dispatched >= RECONCILIATION_ACTION_LIMIT) break;
      operations.push({ kind, id: row.id, action: 'replay', reason: classification.action.reason });
      try {
        await classification.action.dispatch();
      } catch (error) {
        errors.push(`${kind}/${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      dispatched++;
    }

    // Advance only after classification and any required dispatch succeeded.
    lastClassifiedId = row.id;
    scanned++;
  }

  const completedWrap = page.wrapped && (page.rows.length === 0 || scanned > 0);
  const next = nextReconciliationCursor(cursor, lastClassifiedId, completedWrap);
  // Cursor persistence is part of correctness. Do not downgrade a failed write
  // into a report warning: throwing makes the whole durable step retry.
  await persistCursor(kind, next);
  return {
    report: {
      scanned,
      dispatched,
      cursorBefore: cursor.afterId,
      cursorAfter: next.afterId,
      cycle: next.cycle,
      wrapped: page.wrapped,
      errors,
    },
    operations,
  };
}

function graphOnlyIds(graphIds: ReadonlySet<string>, firestoreIds: ReadonlySet<string>): string[] {
  return [...graphIds].filter((id) => !firestoreIds.has(id)).sort();
}

const AGENT_RUN_REVERSE_CURSOR = 'agentRunsReverse';
const AGENT_RUN_MALFORMED_REVERSE_CURSOR = 'agentRunsMalformedReverse';

function emptyAgentRunCategories(): Record<
  AgentRunReconciliationOutcome,
  AgentRunReconciliationCategory
> {
  return {
    exact: { ids: [], count: 0 },
    'missing-node': { ids: [], count: 0 },
    'missing-edge': { ids: [], count: 0 },
    'pre-contract': { ids: [], count: 0 },
    standalone: { ids: [], count: 0 },
    'malformed-source': { ids: [], count: 0 },
    'malformed-graph': { ids: [], count: 0 },
    'payload-conflict': { ids: [], count: 0 },
    'owner-conflict': { ids: [], count: 0 },
    'topology-conflict': { ids: [], count: 0 },
    'graph-only': { ids: [], count: 0 },
  };
}

function projectionOutcome(result: AgentRunProjectionResult): AgentRunReconciliationOutcome {
  switch (result.reason) {
    case 'exact':
      return 'exact';
    case 'missing-node':
      return 'missing-node';
    case 'missing-edge':
      return 'missing-edge';
    case 'pre-contract':
      return 'pre-contract';
    case 'payload-conflict':
      return 'payload-conflict';
    case 'owner-conflict':
    case 'dual-ownership':
      return 'owner-conflict';
    case 'missing-episode':
    case 'ambiguous-episode':
    case 'topology-conflict':
      return 'topology-conflict';
  }
}

async function loadAgentRunGraphStates(
  params: readonly AgentRunSyncParams[]
): Promise<Map<string, AgentRunGraphState>> {
  if (params.length === 0) return new Map();
  if (params.length > RECONCILIATION_SCAN_LIMIT) {
    throw new Error('AgentRun graph-state lookup exceeded its bounded source page');
  }

  const expectedRows = params.map((entry) => {
    const expected = buildExpectedAgentRunProjection(entry);
    return {
      id: entry.id,
      correlationId: expected.correlationId,
      memoryLane: expected.memoryLane,
      userId: entry.userId,
      agentName: entry.agentName,
    };
  });
  const result = await runReadTransaction<{
    id: string;
    run: AgentRunGraphState['run'];
    owners: AgentRunGraphState['owners'];
    candidates: AgentRunGraphState['candidates'];
  }>(
    `UNWIND $expectedRows AS expected
     OPTIONAL MATCH (run:AgentRun {id: expected.id})
     OPTIONAL MATCH (run)-[ownerLink:EXECUTED_DURING]->(owner)
     WITH expected, run, collect(owner) AS ownerNodes
     OPTIONAL MATCH (candidate:Episode)
     WHERE candidate.missionId = expected.correlationId
       AND candidate.userId = expected.userId
       AND candidate.agentName = expected.agentName
     RETURN expected.id AS id,
            CASE WHEN run IS NULL THEN null ELSE run {
              .id, .agentName, .action, .status, .userId, .createdAt,
              .costUsd, .costState, .duration, .correlationId, .correlationKind,
              .missionId, .sweepId, .memoryLane
            } END AS run,
            [node IN ownerNodes WHERE node IS NOT NULL | node {
              .id, .missionId, .userId, .agentName,
              .memoryLane, .correlationId,
              labels: labels(node)
            }] AS owners,
            [node IN collect(DISTINCT candidate) WHERE node IS NOT NULL | node {
              .id, .missionId, .userId, .agentName,
              .memoryLane, .correlationId,
              labels: labels(node)
            }] AS candidates`,
    { expectedRows }
  );

  const states = new Map<string, AgentRunGraphState>();
  for (const record of result.records) {
    if (typeof record.id !== 'string' || !Array.isArray(record.owners) || !Array.isArray(record.candidates)) {
      throw new Error('AgentRun graph-state lookup returned a malformed row');
    }
    states.set(record.id, {
      run: record.run ?? null,
      owners: record.owners,
      candidates: record.candidates,
    });
  }
  for (const entry of params) {
    if (!states.has(entry.id)) {
      throw new Error(`AgentRun graph-state lookup omitted ${entry.id}`);
    }
  }
  return states;
}

async function getAgentRunReverseRows(
  afterId: string | null
): Promise<{ ids: string[]; wrapped: boolean }> {
  const read = async (cursor: string | null) => {
    const result = await runReadTransaction<{ id: unknown }>(
      `MATCH (run:AgentRun)
       WITH CASE
         WHEN run.id IS NOT NULL
          AND run.id = toString(run.id)
          AND trim(toString(run.id)) <> ''
         THEN toString(run.id)
         ELSE null
       END AS validId
       WHERE validId IS NOT NULL AND ($afterId IS NULL OR validId > $afterId)
       RETURN validId AS id
       ORDER BY validId
       LIMIT ${RECONCILIATION_SCAN_LIMIT}`,
      { afterId: cursor }
    );
    return result.records.map((record) => {
      if (typeof record.id !== 'string') {
        throw new Error('AgentRun reverse cursor encountered a non-string graph ID');
      }
      return record.id;
    });
  };

  const forward = await read(afterId);
  if (forward.length > 0 || afterId === null) return { ids: forward, wrapped: false };
  return { ids: await read(null), wrapped: true };
}

interface MalformedAgentRunGraphRow {
  elementId: string;
  reason: 'missing-id' | 'blank-id' | 'non-string-id';
}

async function getMalformedAgentRunReverseRows(
  afterElementId: string | null
): Promise<{ rows: MalformedAgentRunGraphRow[]; wrapped: boolean }> {
  const read = async (cursor: string | null): Promise<MalformedAgentRunGraphRow[]> => {
    const result = await runReadTransaction<{ elementId: unknown; reason: unknown }>(
      `MATCH (run:AgentRun)
       WITH run, elementId(run) AS graphElementId,
            CASE
              WHEN run.id IS NOT NULL
               AND run.id = toString(run.id)
               AND trim(toString(run.id)) <> ''
              THEN toString(run.id)
              ELSE null
            END AS validId
       WHERE validId IS NULL
         AND ($afterElementId IS NULL OR graphElementId > $afterElementId)
       RETURN graphElementId AS elementId,
              CASE
                WHEN run.id IS NULL THEN 'missing-id'
                WHEN trim(toString(run.id)) = '' THEN 'blank-id'
                ELSE 'non-string-id'
              END AS reason
       ORDER BY graphElementId
       LIMIT ${RECONCILIATION_SCAN_LIMIT}`,
      { afterElementId: cursor }
    );
    return result.records.map((record) => {
      if (
        typeof record.elementId !== 'string' ||
        !['missing-id', 'blank-id', 'non-string-id'].includes(String(record.reason))
      ) {
        throw new Error('Malformed AgentRun reverse scan returned an invalid evidence row');
      }
      return {
        elementId: record.elementId,
        reason: record.reason as MalformedAgentRunGraphRow['reason'],
      };
    });
  };

  const forward = await read(afterElementId);
  if (forward.length > 0 || afterElementId === null) return { rows: forward, wrapped: false };
  return { rows: await read(null), wrapped: true };
}

function agentRunCursorReport(
  cursor: Awaited<ReturnType<typeof loadCursor>>,
  cursorAfter: string | null,
  scanned: number,
  wrapped: boolean,
  errors: string[],
  dispatched = 0
): KindCursorReport {
  return {
    scanned,
    dispatched,
    cursorBefore: cursor.afterId,
    cursorAfter,
    cycle: cursor.cycle + (wrapped ? 1 : 0),
    wrapped,
    errors,
  };
}

/**
 * Reconcile one bounded Firestore AgentRun page plus one independently bounded
 * Neo4j reverse page. All IDs and counts are page evidence, not a full census.
 */
export async function reconcileAgentRuns(): Promise<AgentRunReconciliationReport> {
  const categories = emptyAgentRunCategories();
  const classifications: AgentRunReconciliationEvidence[] = [];
  const operations: ReconciliationRepairOperation[] = [];
  const repairs: AgentRunRepairSummary = {
    attempted: 0,
    applied: 0,
    created: 0,
    healed: 0,
    unchanged: 0,
    conflict: 0,
    invalidOwnership: 0,
  };
  const addEvidence = (evidence: AgentRunReconciliationEvidence) => {
    classifications.push(evidence);
    const category = categories[evidence.outcome];
    category.ids.push(evidence.id);
    category.count++;
  };

  const sourceCursor = await loadCursor('agentRuns');
  const sourcePage = await getCursorRows('agentRuns', sourceCursor.afterId);
  const sourceClassifications = sourcePage.rows.map((row) => ({
    row,
    classification: classifyAgentRunSource(row),
  }));
  const eligibleParams = sourceClassifications.flatMap(({ classification }) =>
    classification.outcome === 'eligible' ? [classification.params] : []
  );
  const graphStates = await loadAgentRunGraphStates(eligibleParams);
  const sourceErrors: string[] = [];
  let sourceLastId = sourcePage.rows.length === 0 ? null : sourceCursor.afterId;
  let sourceScanned = 0;
  let sourceEligible = 0;

  for (const { row, classification } of sourceClassifications) {
    if (classification.outcome === 'standalone') {
      addEvidence({ id: row.id, outcome: 'standalone', reason: classification.reason });
    } else if (classification.outcome === 'malformed-source') {
      addEvidence({ id: row.id, outcome: 'malformed-source', reason: classification.reason });
    } else {
      const state = graphStates.get(row.id);
      if (!state) throw new Error(`AgentRun graph-state lookup omitted ${row.id}`);
      const expected = buildExpectedAgentRunProjection(classification.params);
      const before = classifyAgentRunProjection(expected, state);
      const needsRepair = before.status === 'created' || before.status === 'healed';

      if (needsRepair && repairs.attempted >= RECONCILIATION_ACTION_LIMIT) break;
      let final = before;
      if (needsRepair) {
        repairs.attempted++;
        operations.push({
          kind: 'agentRuns',
          id: row.id,
          action: 'replay',
          reason: before.reason,
        });
        try {
          final = await projectAgentRunToNeo4j(classification.params);
        } catch (error) {
          sourceErrors.push(
            `agentRuns/${row.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          break;
        }
        repairs[final.status]++;
        if (final.status === 'created' || final.status === 'healed') repairs.applied++;
        if (final.reason === 'dual-ownership') repairs.invalidOwnership++;
      }

      sourceEligible++;

      addEvidence({
        id: row.id,
        outcome: projectionOutcome(final),
        reason: final.reason,
        ...(needsRepair ? { projectorResult: final } : {}),
      });
    }

    sourceLastId = row.id;
    sourceScanned++;
  }

  const sourceCompletedWrap = sourcePage.wrapped && (sourcePage.rows.length === 0 || sourceScanned > 0);
  const nextSource = nextReconciliationCursor(sourceCursor, sourceLastId, sourceCompletedWrap);
  await persistCursor('agentRuns', nextSource);
  const source = {
    ...agentRunCursorReport(
      sourceCursor,
      nextSource.afterId,
      sourceScanned,
      sourcePage.wrapped,
      sourceErrors
    ),
    cycle: nextSource.cycle,
    eligible: sourceEligible,
    repaired: repairs.applied,
  };

  const reverseCursor = await loadCursor(AGENT_RUN_REVERSE_CURSOR);
  const reversePage = await getAgentRunReverseRows(reverseCursor.afterId);
  const sourceRefs = reversePage.ids.map((id) => db.collection('agentRuns').doc(id));
  const sourceSnapshots = sourceRefs.length > 0 ? await db.getAll(...sourceRefs) : [];
  const existingSourceIds = new Set(
    sourceSnapshots.flatMap((snapshot) => (snapshot.exists ? [snapshot.id] : []))
  );
  const graphOnly = reversePage.ids.filter((id) => !existingSourceIds.has(id));
  for (const id of graphOnly) {
    addEvidence({ id, outcome: 'graph-only', reason: 'missing-firestore-source' });
    operations.push({
      kind: 'agentRuns',
      id,
      action: 'delete-candidate',
      reason: 'graph-only AgentRun; bounded reverse-page evidence; report-only',
    });
  }
  const reverseLastId = reversePage.ids.at(-1) ?? null;
  const reverseCompletedWrap = reversePage.wrapped;
  const nextReverse = nextReconciliationCursor(reverseCursor, reverseLastId, reverseCompletedWrap);
  await persistCursor(AGENT_RUN_REVERSE_CURSOR, nextReverse);
  const reverse = {
    ...agentRunCursorReport(
      reverseCursor,
      nextReverse.afterId,
      reversePage.ids.length,
      reversePage.wrapped,
      []
    ),
    cycle: nextReverse.cycle,
    graphOnlyIds: graphOnly,
  };

  const malformedCursor = await loadCursor(AGENT_RUN_MALFORMED_REVERSE_CURSOR);
  const malformedPage = await getMalformedAgentRunReverseRows(malformedCursor.afterId);
  for (const row of malformedPage.rows) {
    addEvidence({
      id: `neo4j-element:${row.elementId}`,
      outcome: 'malformed-graph',
      reason: row.reason,
    });
  }
  const malformedLastElementId = malformedPage.rows.at(-1)?.elementId ?? null;
  const nextMalformed = nextReconciliationCursor(
    malformedCursor,
    malformedLastElementId,
    malformedPage.wrapped
  );
  await persistCursor(AGENT_RUN_MALFORMED_REVERSE_CURSOR, nextMalformed);
  const malformedGraph = {
    ...agentRunCursorReport(
      malformedCursor,
      nextMalformed.afterId,
      malformedPage.rows.length,
      malformedPage.wrapped,
      []
    ),
    cycle: nextMalformed.cycle,
    elementIds: malformedPage.rows.map((row) => row.elementId),
  };

  return {
    source,
    reverse,
    malformedGraph,
    classifications,
    categories,
    repairs,
    errors: sourceErrors,
    operations,
  };
}

async function reconcileEntityConfig(
  config: EntityProjectionConfig,
  referencedSignals: Awaited<ReturnType<typeof loadReferencedSignalIds>>
): Promise<{
  count: ProjectionCount;
  cursor: KindCursorReport;
  reverse: string[];
  operations: ReconciliationRepairOperation[];
}> {
  const [rows, graphStates] = await Promise.all([
    getOrderedRows(config.collection),
    getNeo4jEntityStates(config.label),
  ]);
  const graphIds = new Set(graphStates.keys());
  const sourceIds = new Set(rows.map((row) => row.id));

  // GRAPH-056: the expected fingerprint is a pure function of the stored
  // document, so it is derived here rather than read from anywhere. That is
  // what makes this contract need no migration and no backfill — a projection
  // predating it simply reports `pre-contract-projection` and heals on its
  // first replay. Hashing the full census keeps the reported drift counts
  // honest; each digest is an in-memory SHA-256 over one document.
  const expectedFingerprints = new Map<string, string>(
    await Promise.all(
      rows.map(
        async (row) => [
          row.id,
          await createEntitySourceFingerprint(config.entityType, row.id, row.data),
        ] as [string, string]
      )
    )
  );

  /** Drift for a non-Signal entity, or null when the projection is current. */
  const driftFor = (rowId: string): EntityProjectionDrift | null =>
    classifyEntityProjection(graphStates.get(rowId), expectedFingerprints.get(rowId) ?? '');

  let expectedIds = sourceIds;
  let excluded = 0;
  let projectionStale = 0;
  let malformed = 0;

  if (config.kind === 'signals') {
    expectedIds = new Set(
      rows.flatMap((row) => {
        const decision = decideSignalProjection(row.data.status, referencedSignals.get(row.id));
        if (!decision.eligible) excluded++;
        const projected = graphStates.get(row.id);
        if (projected) {
          const statusDrifted = !decision.eligible || projected.status !== row.data.status;
          const contentDrift = decision.eligible && !statusDrifted ? driftFor(row.id) : null;
          if (contentDrift === 'malformed-projection-fingerprint') malformed++;
          if (statusDrifted || contentDrift) projectionStale++;
        }
        return decision.eligible ? [row.id] : [];
      })
    );
  } else {
    for (const row of rows) {
      const drift = driftFor(row.id);
      if (drift === 'malformed-projection-fingerprint') malformed++;
      // `missing` is reported separately below; this counts projections that
      // exist but no longer match their source — the class that was invisible
      // while reconciliation compared entity IDs alone.
      if (drift && drift !== 'missing-projection') projectionStale++;
    }
  }

  const reverse = graphOnlyIds(graphIds, sourceIds);
  const page = await processCursorPage(config.kind, config.collection, async (row, cycle) => {
    if (config.kind === 'signals') {
      const decision = decideSignalProjection(row.data.status, referencedSignals.get(row.id));
      const projected = graphStates.get(row.id);
      const exists = projected !== undefined;
      if (!decision.eligible && !exists) return {};
      if (!decision.eligible) {
        return {
          action: {
            reason: 'reference-safe-downgrade',
            dispatch: () => dispatchEntity(config, row.id, cycle),
          },
        };
      }
      if (!exists) {
        return {
          action: {
            reason: `missing:${decision.reason}`,
            dispatch: () => dispatchEntity(config, row.id, cycle),
          },
        };
      }
      if (projected.status !== row.data.status) {
        return { action: { reason: 'stale-status', dispatch: () => dispatchEntity(config, row.id, cycle) } };
      }
      const drift = driftFor(row.id);
      if (!drift) return {};
      return { action: { reason: drift, dispatch: () => dispatchEntity(config, row.id, cycle) } };
    }

    const drift = driftFor(row.id);
    if (!drift) return {};
    return { action: { reason: drift, dispatch: () => dispatchEntity(config, row.id, cycle) } };
  });

  // Anchors are diagnostic/retry state, not the repair source of truth. Retire
  // them only after a fresh Firestore read and a fresh graph fingerprint read;
  // generation-CAS preserves any newer mutation that arrives during this pass.
  if (isEntityGraphSyncAnchorType(config.entityType)) {
    const anchors = await listEntityGraphSyncAnchorsForType(config.entityType);
    for (const anchor of anchors) {
      const source = await db.collection(config.collection).doc(anchor.entityId).get();
      if (!source.exists) {
        await clearConvergedEntityGraphSyncAnchor(
          config.entityType,
          anchor.entityId,
          anchor.generation
        );
        continue;
      }

      const sourceData = source.data() as Record<string, unknown>;
      const current = await runReadTransaction<{ sourceFingerprint: unknown }>(
        `MATCH (node:${config.label} {id: $id}) RETURN node.sourceFingerprint AS sourceFingerprint`,
        { id: anchor.entityId }
      );
      if (config.kind === 'signals') {
        const decision = decideSignalProjection(sourceData.status, referencedSignals.get(anchor.entityId));
        if (!decision.eligible && current.records.length === 0) {
          await clearConvergedEntityGraphSyncAnchor(
            config.entityType,
            anchor.entityId,
            anchor.generation
          );
          continue;
        }
      }
      const expected = await createEntitySourceFingerprint(
        config.entityType,
        anchor.entityId,
        sourceData
      );
      const actual = parseEntitySourceFingerprint(current.records[0]?.sourceFingerprint);
      if (actual === expected) {
        await clearConvergedEntityGraphSyncAnchor(
          config.entityType,
          anchor.entityId,
          anchor.generation
        );
      }
    }
  }

  return {
    count: {
      firestore: expectedIds.size,
      source: rows.length,
      neo4j: graphIds.size,
      missing: [...expectedIds].filter((id) => !graphIds.has(id)).length,
      stale: reverse.length + projectionStale,
      ...(malformed > 0 ? { malformed } : {}),
      ...(config.kind === 'signals' ? { excluded } : {}),
    },
    cursor: page.report,
    reverse,
    operations: [
      ...page.operations,
      ...reverse.map((id) => ({
        kind: config.kind,
        id,
        action: 'delete-candidate' as const,
        reason: 'graph-only entity; report-only',
      })),
    ],
  };
}

async function reconcileRadars() {
  const [rows, graphResult] = await Promise.all([
    getOrderedRows('radars'),
    runReadTransaction<{ id: string; updatedAt: unknown }>(
      'MATCH (radar:Radar) RETURN radar.id AS id, radar.updatedAt AS updatedAt',
      {}
    ),
  ]);
  const versions = new Map(
    graphResult.records.flatMap((record) => {
      const raw = record.updatedAt;
      const updatedAt =
        typeof raw === 'number'
          ? raw
          : raw && typeof raw === 'object' && 'toNumber' in raw && typeof raw.toNumber === 'function'
            ? raw.toNumber()
            : null;
      return typeof record.id === 'string' ? [[record.id, updatedAt] as const] : [];
    })
  );
  const sourceIds = new Set(rows.map((row) => row.id));
  const reverse = graphOnlyIds(new Set(versions.keys()), sourceIds);
  const stale = rows.filter((row) => {
    const expected = toMillis(row.data.updatedAt, toMillis(row.data.createdAt, 0));
    return versions.has(row.id) && versions.get(row.id) !== expected;
  }).length;
  const page = await processCursorPage('radars', 'radars', async (row, cycle) => {
    const updatedAt = toMillis(row.data.updatedAt, toMillis(row.data.createdAt, 0));
    if (versions.get(row.id) === updatedAt) return {};
    return {
      action: {
        reason: versions.has(row.id) ? 'stale-source-version' : 'missing-projection',
        dispatch: () =>
          requireAccepted(
            inngest.send(createRadarProjectionEvent({ id: row.id, updatedAt }, `reconcile-v1:${cycle}`))
          ),
      },
    };
  });
  return {
    count: {
      firestore: rows.length,
      neo4j: versions.size,
      missing: rows.filter((row) => !versions.has(row.id)).length,
      stale,
    },
    cursor: page.report,
    reverse,
    operations: [
      ...page.operations,
      ...reverse.map((id) => ({
        kind: 'radars' as const,
        id,
        action: 'delete-candidate' as const,
        reason: 'graph-only Radar; report-only',
      })),
    ],
  };
}

async function reconcileSimpleSpecial(
  kind: 'radarPlacements' | 'concepts',
  collection: string,
  graphIds: Set<string>,
  dispatch: (id: string, cycle: number) => Promise<void>
) {
  const rows = await getOrderedRows(collection);
  const sourceIds = new Set(rows.map((row) => row.id));
  const reverse = graphOnlyIds(graphIds, sourceIds);
  const page = await processCursorPage(kind, collection, async (row, cycle) =>
    graphIds.has(row.id)
      ? {}
      : { action: { reason: 'missing-projection', dispatch: () => dispatch(row.id, cycle) } }
  );
  return {
    count: {
      firestore: rows.length,
      neo4j: graphIds.size,
      missing: rows.filter((row) => !graphIds.has(row.id)).length,
      stale: reverse.length,
    },
    cursor: page.report,
    reverse,
    operations: [
      ...page.operations,
      ...reverse.map((id) => ({
        kind,
        id,
        action: 'delete-candidate' as const,
        reason: `graph-only ${kind}; report-only`,
      })),
    ],
  };
}

async function getRelationProjectionStates(): Promise<Map<string, RelationProjectionState>> {
  const [edges, assertions] = await Promise.all([
    runReadTransaction<{
      relationId: string;
      sourceId: unknown;
      targetId: unknown;
      predicate: unknown;
      active: unknown;
      sourceCorrelationId: unknown;
      sourceFingerprint: unknown;
    }>(
      `MATCH (source)-[edge]->(target)
       WHERE edge.relationId IS NOT NULL
       RETURN edge.relationId AS relationId, source.id AS sourceId, target.id AS targetId,
              type(edge) AS predicate, edge.t_invalidated IS NULL AS active,
              edge.sourceCorrelationId AS sourceCorrelationId,
              edge.sourceFingerprint AS sourceFingerprint`,
      {}
    ),
    runReadTransaction<{
      relationId: string;
      assertionId: unknown;
      status: unknown;
      subjectIds: unknown;
      objectIds: unknown;
      predicates: unknown;
      sourceCorrelationId: unknown;
      sourceFingerprint: unknown;
    }>(
      `MATCH (assertion:Assertion)
       WHERE assertion.relationId IS NOT NULL
       OPTIONAL MATCH (assertion)-[:ABOUT_SUBJECT]->(subject)
       OPTIONAL MATCH (assertion)-[:ABOUT_OBJECT]->(object)
       OPTIONAL MATCH (assertion)-[:HAS_PREDICATE]->(relationType:RelationType)
       RETURN assertion.relationId AS relationId, elementId(assertion) AS assertionId, assertion.status AS status,
              collect(DISTINCT subject.id) AS subjectIds,
              collect(DISTINCT object.id) AS objectIds,
              collect(DISTINCT relationType.name) AS predicates,
              assertion.sourceCorrelationId AS sourceCorrelationId,
              assertion.sourceFingerprint AS sourceFingerprint`,
      {}
    ),
  ]);
  const states = new Map<string, RelationProjectionState>();
  const activeEdges = new Map<
    string,
    Array<{
      sourceId: string | null;
      targetId: string | null;
      predicate: string | null;
      sourceCorrelationId: string | null;
      sourceFingerprint: string | null;
    }>
  >();
  const allActiveEdgeCounts = new Map<string, number>();
  for (const edge of edges.records) {
    if (typeof edge.relationId !== 'string') continue;
    const state = states.get(edge.relationId) ?? {
      relationId: edge.relationId,
      activeEdge: false,
      assertionStatus: null,
    };
    states.set(edge.relationId, state);
    if (edge.active === true) {
      allActiveEdgeCounts.set(edge.relationId, (allActiveEdgeCounts.get(edge.relationId) ?? 0) + 1);
    }
    if (
      edge.active === true &&
      typeof edge.predicate === 'string' &&
      RECONCILED_RELATION_PREDICATES.includes(edge.predicate as never)
    ) {
      const current = activeEdges.get(edge.relationId) ?? [];
      current.push({
        sourceId: typeof edge.sourceId === 'string' ? edge.sourceId : null,
        targetId: typeof edge.targetId === 'string' ? edge.targetId : null,
        predicate: edge.predicate,
        sourceCorrelationId:
          typeof edge.sourceCorrelationId === 'string' ? edge.sourceCorrelationId : null,
        sourceFingerprint:
          typeof edge.sourceFingerprint === 'string' ? edge.sourceFingerprint : null,
      });
      activeEdges.set(edge.relationId, current);
    }
  }
  for (const [relationId, state] of states) {
    const active = activeEdges.get(relationId) ?? [];
    state.activeEdge = active.length > 0;
    state.activeEdgeCount = active.length;
    state.edgeSourceId = active.length === 1 ? active[0].sourceId : null;
    state.edgeTargetId = active.length === 1 ? active[0].targetId : null;
    state.edgePredicate = active.length === 1 ? active[0].predicate : null;
    state.edgeSourceCorrelationId =
      active.length === 1 ? active[0].sourceCorrelationId : null;
    state.edgeSourceFingerprint = active.length === 1 ? active[0].sourceFingerprint : null;
    state.unexpectedActiveEdgeCount = (allActiveEdgeCounts.get(relationId) ?? 0) - active.length;
  }
  const assertionsByRelation = new Map<string, typeof assertions.records>();
  for (const assertion of assertions.records) {
    if (typeof assertion.relationId !== 'string') continue;
    const current = assertionsByRelation.get(assertion.relationId) ?? [];
    current.push(assertion);
    assertionsByRelation.set(assertion.relationId, current);
  }
  for (const [relationId, assertionRows] of assertionsByRelation) {
    const current = states.get(relationId);
    const only = assertionRows.length === 1 ? assertionRows[0] : null;
    const one = (value: unknown): string | null =>
      Array.isArray(value) && value.length === 1 && typeof value[0] === 'string' ? value[0] : null;
    states.set(relationId, {
      relationId,
      activeEdge: current?.activeEdge ?? false,
      activeEdgeCount: current?.activeEdgeCount ?? 0,
      edgeSourceId: current?.edgeSourceId ?? null,
      edgeTargetId: current?.edgeTargetId ?? null,
      edgePredicate: current?.edgePredicate ?? null,
      edgeSourceCorrelationId: current?.edgeSourceCorrelationId ?? null,
      edgeSourceFingerprint: current?.edgeSourceFingerprint ?? null,
      unexpectedActiveEdgeCount: current?.unexpectedActiveEdgeCount ?? 0,
      assertionStatus: only && typeof only.status === 'string' ? only.status : null,
      assertionCount: assertionRows.length,
      assertionSourceId: only ? one(only.subjectIds) : null,
      assertionTargetId: only ? one(only.objectIds) : null,
      assertionPredicate: only ? one(only.predicates) : null,
      assertionSourceCorrelationId:
        only && typeof only.sourceCorrelationId === 'string'
          ? only.sourceCorrelationId
          : null,
      assertionSourceFingerprint:
        only && typeof only.sourceFingerprint === 'string' ? only.sourceFingerprint : null,
    });
  }
  return states;
}

function readRelationSourceVersion(relationId: string, source: RelationSourceShape) {
  const hasSourceCorrelationId = source.sourceCorrelationId !== undefined;
  const hasSourceFingerprint = source.sourceFingerprint !== undefined;
  if (hasSourceCorrelationId !== hasSourceFingerprint) {
    throw new Error(`Malformed relation ${relationId}: incomplete source version metadata`);
  }
  const sourceCorrelationId =
    source.sourceCorrelationId === undefined
      ? undefined
      : parseCorrelationId(source.sourceCorrelationId);
  if (source.sourceCorrelationId !== undefined && !sourceCorrelationId) {
    throw new Error(`Malformed relation ${relationId}: invalid source correlation metadata`);
  }
  const sourceFingerprint = resolveRelationSourceFingerprint(source.sourceFingerprint);
  if (sourceFingerprint && sourceFingerprint !== relationProjectionFingerprint(source)) {
    throw new Error(`Malformed relation ${relationId}: source fingerprint does not match authoritative content`);
  }
  return { sourceCorrelationId: sourceCorrelationId ?? undefined, sourceFingerprint };
}

async function reconcileRelations() {
  const [rows, states] = await Promise.all([getOrderedRows('relations'), getRelationProjectionStates()]);
  const sourceIds = new Set(rows.map((row) => row.id));
  const reverse = graphOnlyIds(new Set(states.keys()), sourceIds);
  let malformed = 0;
  let missing = 0;
  for (const row of rows) {
    try {
      const source = parseRelationProjectionSource(row.id, row.data);
      readRelationSourceVersion(row.id, source);
      if (relationNeedsReplay(source, states.get(row.id))) missing++;
    } catch {
      malformed++;
    }
  }
  const page = await processCursorPage('relations', 'relations', async (row, cycle) => {
    const source = parseRelationProjectionSource(row.id, row.data);
    const { sourceCorrelationId, sourceFingerprint } = readRelationSourceVersion(row.id, source);
    if (!relationNeedsReplay(source, states.get(row.id))) return {};
    return {
      action: {
        reason: 'missing-or-stale-relation-projection',
        dispatch: () =>
          requireAccepted(
            inngest.send({
              id: eventId('relations', cycle, row.id),
              name: 'app/relation.sync.requested',
              data: {
                operation: 'update',
                relationId: row.id,
                ...(sourceCorrelationId ? { correlationId: sourceCorrelationId } : {}),
                ...(sourceFingerprint ? { sourceFingerprint } : {}),
              },
            })
          ),
      },
    };
  });
  return {
    count: { firestore: rows.length, neo4j: states.size, missing, stale: reverse.length, malformed },
    cursor: page.report,
    reverse,
    operations: [
      ...page.operations,
      ...reverse.map((id) => ({
        kind: 'relations' as const,
        id,
        action: 'delete-candidate' as const,
        reason: 'graph-only relation/assertion; report-only',
      })),
    ],
  };
}

interface GraphLinkProjection {
  sourceId: string | null;
  sourceLabels: string[];
  documentId: string | null;
  documentLabels: string[];
  relationshipType: string;
  relevance: string | null;
  tags: string[];
  note: string | null;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function documentLinkProjectionMatches(
  projection: GraphLinkProjection,
  data: Record<string, unknown>,
  expectedLabel: string,
  expectedType: string
): boolean {
  const expectedTags = Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return (
    projection.sourceId === data.entityId &&
    projection.sourceLabels.includes(expectedLabel) &&
    projection.documentId === data.documentId &&
    projection.documentLabels.includes('Document') &&
    projection.relationshipType === expectedType &&
    projection.relevance === (typeof data.relevance === 'string' && data.relevance ? data.relevance : 'medium') &&
    sameStringSet(projection.tags, expectedTags) &&
    projection.note === (typeof data.note === 'string' && data.note ? data.note : null)
  );
}

async function getDocumentLinkProjections(): Promise<Map<string, GraphLinkProjection[]>> {
  const result = await runReadTransaction<{
    linkId: string;
    sourceId: string | null;
    sourceLabels: string[];
    documentId: string | null;
    documentLabels: string[];
    relationshipType: string;
    relevance: unknown;
    tags: unknown;
    note: unknown;
  }>(
    `MATCH (source)-[edge]->(document)
     WHERE edge.linkId IS NOT NULL
     RETURN edge.linkId AS linkId, source.id AS sourceId, labels(source) AS sourceLabels,
            document.id AS documentId, labels(document) AS documentLabels,
            type(edge) AS relationshipType, edge.relevance AS relevance,
            edge.tags AS tags, edge.note AS note`,
    {}
  );
  const projections = new Map<string, GraphLinkProjection[]>();
  for (const record of result.records) {
    if (typeof record.linkId !== 'string') continue;
    const current = projections.get(record.linkId) ?? [];
    current.push({
      sourceId: typeof record.sourceId === 'string' ? record.sourceId : null,
      sourceLabels: Array.isArray(record.sourceLabels)
        ? record.sourceLabels.filter((label): label is string => typeof label === 'string')
        : [],
      documentId: typeof record.documentId === 'string' ? record.documentId : null,
      documentLabels: Array.isArray(record.documentLabels)
        ? record.documentLabels.filter((label): label is string => typeof label === 'string')
        : [],
      relationshipType: record.relationshipType,
      relevance: typeof record.relevance === 'string' ? record.relevance : null,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      note: typeof record.note === 'string' ? record.note : null,
    });
    projections.set(record.linkId, current);
  }
  return projections;
}

/**
 * GRAPH-069 — retire entity-document link recovery anchors whose debt is settled.
 *
 * The worker retires an anchor the moment its own write converges, but that
 * only covers anchors that existed when the worker ran. An anchor written by a
 * dispatch that never reached the queue at all has no worker to settle it, so
 * this pass is its terminator: for each anchor, the link's projection must be
 * exactly one edge that matches the authoritative row — the same
 * `documentLinkProjectionMatches` predicate the repair decision uses, so an
 * anchor can never be retired by a weaker test than the one that would flag
 * the projection as broken. An anchor whose source row is gone is also retired:
 * deletes are fail-closed on their own row, so there is no debt left to owe.
 *
 * The clear is compare-and-delete on the generation read at the top of this
 * pass, so a mutation that fails its handoff mid-cycle keeps its own anchor.
 * Anchors are never the repair source of truth — the projection comparison
 * above is — so a failure here can only cost visibility, never convergence.
 */
async function retireConvergedDocumentLinkAnchors(
  rows: readonly { id: string; data: Record<string, unknown> }[],
  projections: Map<string, GraphLinkProjection[]>
): Promise<void> {
  const anchors = await listEntityGraphSyncAnchorsForType(ENTITY_DOCUMENT_LINK_ANCHOR_TYPE);
  if (anchors.length === 0) return;

  const rowsById = new Map(rows.map((row) => [row.id, row.data]));
  for (const anchor of anchors) {
    const data = rowsById.get(anchor.entityId);
    if (!data) {
      await clearConvergedEntityGraphSyncAnchor(ENTITY_DOCUMENT_LINK_ANCHOR_TYPE, anchor.entityId, anchor.generation);
      continue;
    }
    if (!isDocumentLinkEntityType(data.entityType) || !isDocumentRelationshipType(data.relationshipType)) {
      // A malformed row cannot be proven converged; leave the anchor as the
      // durable record that this link still owes the graph a write.
      continue;
    }
    const exact = projections.get(anchor.entityId) ?? [];
    const converged =
      exact.length === 1 &&
      documentLinkProjectionMatches(
        exact[0],
        data,
        DOCUMENT_LINK_ENTITY_LABELS[data.entityType],
        DOCUMENT_LINK_RELATIONSHIP_TYPES[data.relationshipType]
      );
    if (converged) {
      await clearConvergedEntityGraphSyncAnchor(ENTITY_DOCUMENT_LINK_ANCHOR_TYPE, anchor.entityId, anchor.generation);
    }
  }
}

async function reconcileDocumentLinks() {
  const [rows, projections] = await Promise.all([getOrderedRows('entityDocumentLinks'), getDocumentLinkProjections()]);
  const sourceIds = new Set(rows.map((row) => row.id));
  const reverse = graphOnlyIds(new Set(projections.keys()), sourceIds);
  const entityTypes = new Set(
    rows.flatMap((row) => (isDocumentLinkEntityType(row.data.entityType) ? [row.data.entityType] : []))
  );
  const endpointIds = new Map<string, Set<string>>();
  await Promise.all(
    [...entityTypes].map(async (entityType) => {
      const collection = DOCUMENT_LINK_ENTITY_COLLECTIONS[entityType];
      endpointIds.set(collection, new Set((await getOrderedRows(collection)).map((row) => row.id)));
    })
  );
  const documentIds = endpointIds.get('documents') ?? new Set((await getOrderedRows('documents')).map((row) => row.id));
  endpointIds.set('documents', documentIds);
  let missing = 0;
  let malformed = 0;
  const orphanIds = new Map<string, string>();
  for (const row of rows) {
    const data = row.data;
    if (
      typeof data.entityId !== 'string' ||
      typeof data.documentId !== 'string' ||
      !isDocumentLinkEntityType(data.entityType) ||
      !isDocumentRelationshipType(data.relationshipType)
    ) {
      malformed++;
      continue;
    }
    const expectedType = DOCUMENT_LINK_RELATIONSHIP_TYPES[data.relationshipType];
    const expectedLabel = DOCUMENT_LINK_ENTITY_LABELS[data.entityType];
    const exact = projections.get(row.id) ?? [];
    if (
      exact.length !== 1 ||
      !documentLinkProjectionMatches(exact[0], data, expectedLabel, expectedType)
    ) {
      missing++;
    }
    const entityCollection = DOCUMENT_LINK_ENTITY_COLLECTIONS[data.entityType];
    const missingParts = [
      !endpointIds.get(entityCollection)?.has(data.entityId) ? 'entity' : '',
      !documentIds.has(data.documentId) ? 'document' : '',
    ].filter(Boolean);
    if (missingParts.length > 0) orphanIds.set(row.id, missingParts.join('+'));
  }
  await retireConvergedDocumentLinkAnchors(rows, projections);
  const page = await processCursorPage('documentLinks', 'entityDocumentLinks', async (row, cycle) => {
    const data = row.data;
    if (
      typeof data.entityId !== 'string' ||
      typeof data.documentId !== 'string' ||
      !isDocumentLinkEntityType(data.entityType) ||
      !isDocumentRelationshipType(data.relationshipType)
    ) {
      throw new Error('Malformed entity-document link endpoints or relationship type');
    }
    const expectedType = DOCUMENT_LINK_RELATIONSHIP_TYPES[data.relationshipType];
    const expectedLabel = DOCUMENT_LINK_ENTITY_LABELS[data.entityType];
    const exact = projections.get(row.id) ?? [];
    const current =
      exact.length === 1 &&
      documentLinkProjectionMatches(exact[0], data, expectedLabel, expectedType);
    if (current) return {};
    if (orphanIds.has(row.id)) return {};
    return {
      action: {
        reason: exact.length === 0 ? 'missing-link-projection' : 'stale-or-duplicate-link-projection',
        dispatch: () =>
          requireAccepted(
            inngest.send({
              id: eventId('documentLinks', cycle, row.id),
              name: 'app/entity-document-link.sync.requested',
              data: { operation: 'update', linkId: row.id },
            })
          ),
      },
    };
  });
  return {
    count: {
      firestore: rows.length,
      neo4j: projections.size,
      missing,
      stale: reverse.length,
      malformed,
      orphaned: orphanIds.size,
    },
    cursor: page.report,
    reverse,
    operations: [
      ...page.operations,
      ...[...orphanIds].map(([id, missingParts]) => ({
        kind: 'documentLinks' as const,
        id,
        action: 'delete-candidate' as const,
        reason: `orphan Firestore link; missing=${missingParts}; report-only`,
      })),
      ...reverse.map((id) => ({
        kind: 'documentLinks' as const,
        id,
        action: 'delete-candidate' as const,
        reason: 'graph-only document link; report-only',
      })),
    ],
  };
}

export async function runProjectionReconciliationCycle(): Promise<ScheduledReconciliationReport> {
  assertReconciliationRegistryComplete();
  const referencedSignals = await loadReferencedSignalIds();
  const entities: Record<string, ProjectionCount> = {};
  const cursors: ScheduledReconciliationReport['cursors'] = {};
  const reverse: ScheduledReconciliationReport['reverse'] = {};
  const operations: ReconciliationRepairOperation[] = [];
  const errors: string[] = [];
  let syncsTriggered = 0;

  const absorb = (
    kind: ReconciliationKind,
    result: { cursor: KindCursorReport; reverse: string[]; operations: ReconciliationRepairOperation[] }
  ) => {
    cursors[kind] = result.cursor;
    reverse[kind] = result.reverse;
    operations.push(...result.operations);
    syncsTriggered += result.cursor.dispatched;
    for (const error of result.cursor.errors) {
      if (errors.length < MAX_RECONCILIATION_ERRORS) errors.push(error);
    }
  };

  for (const config of ENTITY_PROJECTION_CONFIGS) {
    const result = await reconcileEntityConfig(config, referencedSignals);
    entities[config.kind] = result.count;
    absorb(config.kind, result);
  }

  const radars = await reconcileRadars();
  entities.radars = radars.count;
  absorb('radars', radars);

  const placementGraphIds = new Set(
    (
      await runReadTransaction<{ id: string }>(
        `MATCH (placement:RadarPlacement)-[:ON_RADAR]->(:Radar)
         WHERE EXISTS { (placement)-[:PLACES]->(:Entity) }
         RETURN DISTINCT placement.id AS id`,
        {}
      )
    ).records.map((record) => record.id)
  );
  const placements = await reconcileSimpleSpecial(
    'radarPlacements',
    'radarPlacements',
    placementGraphIds,
    (id, cycle) =>
      requireAccepted(
        inngest.send({
          id: eventId('radarPlacements', cycle, id),
          name: 'app/radar-placement.sync.requested',
          data: { operation: 'update', placementId: id },
        })
      )
  );
  entities.radarPlacements = placements.count;
  absorb('radarPlacements', placements);

  const concepts = await reconcileSimpleSpecial('concepts', 'concepts', await getNeo4jIds('Concept'), (id, cycle) =>
    requireAccepted(
      inngest.send({
        id: eventId('concepts', cycle, id),
        name: 'app/concept.sync.requested',
        data: { operation: 'update', conceptId: id },
      })
    )
  );
  entities.concepts = concepts.count;
  absorb('concepts', concepts);

  const relations = await reconcileRelations();
  absorb('relations', relations);
  const documentLinks = await reconcileDocumentLinks();
  absorb('documentLinks', documentLinks);

  const agentRuns = await reconcileAgentRuns();
  cursors.agentRuns = agentRuns.source;
  operations.push(...agentRuns.operations);
  for (const error of agentRuns.errors) {
    if (errors.length < MAX_RECONCILIATION_ERRORS) errors.push(error);
  }

  return {
    timestamp: Date.now(),
    entities,
    relations: relations.count,
    documentLinks: documentLinks.count,
    agentRuns,
    cursors,
    reverse,
    syncsTriggered,
    repairsApplied: agentRuns.repairs.applied,
    errors,
    repairPlan: buildReconciliationRepairPlan(operations),
  };
}
