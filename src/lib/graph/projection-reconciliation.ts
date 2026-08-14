import { createHash } from 'node:crypto';
import { CLAIM_RELATION_PREDICATES, RELATION_TYPES_LOWER, resolveNeo4jPredicate } from './relation-registry';
import { agentRunStatusSchema } from '@/lib/schemas/agent-run';
import { relationSourceFingerprintPayload } from '@/lib/relation-source-version';
import type { EntityType, Relation } from '@/lib/types';
import type { AgentRunSyncParams } from './agent-run-sync';

export const RECONCILIATION_CURSOR_VERSION = 1;
export const RECONCILIATION_SCAN_LIMIT = 100;
export const RECONCILIATION_ACTION_LIMIT = 6;

export const RECONCILIATION_KINDS = [
  'companies',
  'technologies',
  'strategies',
  'painPoints',
  'useCases',
  'documents',
  'signals',
  'orgUnits',
  'initiatives',
  'prototypes',
  'radars',
  'radarPlacements',
  'concepts',
  'relations',
  'documentLinks',
  'agentRuns',
] as const;

export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export interface ReconciliationCursor {
  version: typeof RECONCILIATION_CURSOR_VERSION;
  afterId: string | null;
  cycle: number;
}

export interface ReconciliationRow<T = Record<string, unknown>> {
  id: string;
  data: T;
}

export type AgentRunSourceClassification =
  | {
      outcome: 'eligible';
      params: AgentRunSyncParams;
    }
  | {
      outcome: 'standalone';
      reason: 'no-lifecycle-owner';
    }
  | {
      outcome: 'malformed-source';
      reason: 'dual-owner' | 'invalid-owner' | 'invalid-payload' | 'id-mismatch';
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parse only the immutable fields needed by the graph projector. Historical
 * AgentRuns may predate the current UI schema, so unrelated optional fields do
 * not make an otherwise authoritative lifecycle projection ineligible.
 */
export function classifyAgentRunSource(row: ReconciliationRow): AgentRunSourceClassification {
  const data = row.data;
  if (data.id !== undefined && data.id !== row.id) {
    return { outcome: 'malformed-source', reason: 'id-mismatch' };
  }

  const rawMissionId = data.missionId;
  const rawSweepId = data.sweepId;
  const invalidMissionId =
    rawMissionId !== undefined &&
    (!isNonEmptyString(rawMissionId) || rawMissionId !== rawMissionId.trim());
  const invalidSweepId =
    rawSweepId !== undefined &&
    (!isNonEmptyString(rawSweepId) || rawSweepId !== rawSweepId.trim());
  if (invalidMissionId || invalidSweepId) {
    return { outcome: 'malformed-source', reason: 'invalid-owner' };
  }

  const missionId = isNonEmptyString(rawMissionId) ? rawMissionId : undefined;
  const sweepId = isNonEmptyString(rawSweepId) ? rawSweepId : undefined;
  if (missionId && sweepId) {
    return { outcome: 'malformed-source', reason: 'dual-owner' };
  }

  const costUsdPresent = data.costUsd !== undefined;
  const costUsd = isFiniteNonNegative(data.costUsd) ? data.costUsd : undefined;
  const hasValidCost = costUsd !== undefined;
  const costState =
    data.costState === 'estimated' || data.costState === 'settled'
      ? data.costState
      : undefined;
  const costStateMalformed =
    data.costState !== undefined && costState === undefined;
  // Historical numeric costs without a discriminator remain settled by the
  // projector. Current explicit states must be valid and must have an amount;
  // an unavailable cost is represented by both fields being absent.
  if (
    (costUsdPresent && !hasValidCost) ||
    costStateMalformed ||
    (costState !== undefined && !hasValidCost)
  ) {
    return { outcome: 'malformed-source', reason: 'invalid-payload' };
  }

  if (!missionId && !sweepId) {
    return { outcome: 'standalone', reason: 'no-lifecycle-owner' };
  }

  const status = agentRunStatusSchema.safeParse(data.status);
  if (
    !isNonEmptyString(data.agentName) ||
    !isNonEmptyString(data.action) ||
    !status.success ||
    !isNonEmptyString(data.userId) ||
    !isNonEmptyString(data.createdAt) ||
    !isFiniteNonNegative(data.duration)
  ) {
    return { outcome: 'malformed-source', reason: 'invalid-payload' };
  }

  return {
    outcome: 'eligible',
    params: {
      id: row.id,
      agentName: data.agentName,
      action: data.action,
      status: status.data,
      userId: data.userId,
      createdAt: data.createdAt,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(costState !== undefined ? { costState } : {}),
      duration: data.duration,
      ...(missionId ? { missionId } : { sweepId }),
    },
  };
}

export interface CursorPage<T> {
  rows: ReconciliationRow<T>[];
  wrapped: boolean;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareStableStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function parseReconciliationCursor(value: unknown): ReconciliationCursor {
  if (value === undefined || value === null) {
    return { version: RECONCILIATION_CURSOR_VERSION, afterId: null, cycle: 0 };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed graph reconciliation cursor');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== RECONCILIATION_CURSOR_VERSION ||
    (record.afterId !== null && typeof record.afterId !== 'string') ||
    typeof record.cycle !== 'number' ||
    !Number.isInteger(record.cycle) ||
    record.cycle < 0
  ) {
    throw new Error(`Unsupported or malformed graph reconciliation cursor version: ${String(record.version)}`);
  }
  return record as unknown as ReconciliationCursor;
}

export function pageAfterCursor<T>(
  input: readonly ReconciliationRow<T>[],
  afterId: string | null,
  limit = RECONCILIATION_SCAN_LIMIT
): CursorPage<T> {
  // Firestore orders document IDs by their encoded key bytes. Match that
  // ordering explicitly instead of relying on locale-sensitive collation.
  const rows = [...input].sort((left, right) => compareUtf8(left.id, right.id));
  if (rows.length === 0) return { rows: [], wrapped: afterId !== null };
  if (afterId === null) return { rows: rows.slice(0, limit), wrapped: false };
  const firstGreaterIndex = rows.findIndex((row) => compareUtf8(row.id, afterId) > 0);
  if (firstGreaterIndex === -1) return { rows: rows.slice(0, limit), wrapped: true };
  return { rows: rows.slice(firstGreaterIndex, firstGreaterIndex + limit), wrapped: false };
}

export function nextReconciliationCursor(
  current: ReconciliationCursor,
  lastClassifiedId: string | null,
  wrapped: boolean
): ReconciliationCursor {
  return {
    version: RECONCILIATION_CURSOR_VERSION,
    afterId: lastClassifiedId,
    cycle: current.cycle + (wrapped ? 1 : 0),
  };
}

export interface RelationProjectionState {
  relationId: string;
  activeEdge: boolean;
  assertionStatus: string | null;
  assertionCount?: number;
  activeEdgeCount?: number;
  edgeSourceId?: string | null;
  edgeTargetId?: string | null;
  edgePredicate?: string | null;
  edgeSourceCorrelationId?: string | null;
  edgeSourceFingerprint?: string | null;
  assertionSourceId?: string | null;
  assertionTargetId?: string | null;
  assertionPredicate?: string | null;
  assertionSourceCorrelationId?: string | null;
  assertionSourceFingerprint?: string | null;
  unexpectedActiveEdgeCount?: number;
}

export interface RelationSourceShape {
  sourceSnapshot?: unknown;
  targetSnapshot?: unknown;
  relationType?: unknown;
  aiSuggested?: unknown;
  claimStatus?: unknown;
  confidence?: unknown;
  evidenceRefs?: unknown;
  notes?: unknown;
  reasoningSummary?: unknown;
  agentName?: unknown;
  sourceCorrelationId?: unknown;
  sourceFingerprint?: unknown;
  /** Audit timestamp is intentionally not the projection version. */
  updatedAt?: unknown;
}

export const RELATION_ENDPOINT_ENTITY_TYPES = [
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'document',
  'orgUnit',
  'initiative',
  'painPoint',
  'radarPlacement',
] as const satisfies readonly EntityType[];

const RELATION_ENDPOINT_TYPE_SET = new Set<string>(RELATION_ENDPOINT_ENTITY_TYPES);
const RELATION_TYPE_SET = new Set<string>(RELATION_TYPES_LOWER);
const CLAIM_STATUS_SET = new Set(['proposed', 'curated', 'rejected', 'derived']);

function requireProjectionEndpoint(
  relationId: string,
  side: 'sourceSnapshot' | 'targetSnapshot',
  value: unknown
): Relation['sourceSnapshot'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed relation ${relationId}: ${side} must be an object`);
  }
  const endpoint = value as Record<string, unknown>;
  if (
    typeof endpoint.id !== 'string' ||
    endpoint.id.trim().length === 0 ||
    typeof endpoint.name !== 'string' ||
    endpoint.name.trim().length === 0 ||
    typeof endpoint.type !== 'string' ||
    !RELATION_ENDPOINT_TYPE_SET.has(endpoint.type)
  ) {
    throw new Error(`Malformed relation ${relationId}: ${side} has an invalid id, name, or entity type`);
  }
  return endpoint as unknown as Relation['sourceSnapshot'];
}

export function parseRelationProjectionSource(relationId: string, value: unknown): Relation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed relation ${relationId}: source document must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const sourceSnapshot = requireProjectionEndpoint(relationId, 'sourceSnapshot', raw.sourceSnapshot);
  const targetSnapshot = requireProjectionEndpoint(relationId, 'targetSnapshot', raw.targetSnapshot);
  if (typeof raw.relationType !== 'string' || !RELATION_TYPE_SET.has(raw.relationType)) {
    throw new Error(`Malformed relation ${relationId}: unknown relationType ${String(raw.relationType)}`);
  }
  if (raw.confidence !== undefined && (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence))) {
    throw new Error(`Malformed relation ${relationId}: confidence must be finite`);
  }
  if (raw.evidenceRefs !== undefined && !Array.isArray(raw.evidenceRefs)) {
    throw new Error(`Malformed relation ${relationId}: evidenceRefs must be an array`);
  }
  if (
    raw.claimStatus !== undefined &&
    (typeof raw.claimStatus !== 'string' || !CLAIM_STATUS_SET.has(raw.claimStatus))
  ) {
    throw new Error(`Malformed relation ${relationId}: unknown claimStatus ${String(raw.claimStatus)}`);
  }
  return { ...raw, id: relationId, sourceSnapshot, targetSnapshot } as unknown as Relation;
}

/**
 * Version every field that can change the Neo4j topology/properties. `claimId`
 * is intentionally excluded: it is a worker-owned back-pointer written by the
 * projection itself and does not drive the graph representation.
 */
export function relationProjectionFingerprint(source: RelationSourceShape): string {
  return createHash('sha256').update(relationSourceFingerprintPayload(source)).digest('hex');
}

export function relationNeedsReplay(source: RelationSourceShape, graph?: RelationProjectionState): boolean {
  const evidence = Array.isArray(source.evidenceRefs) && source.evidenceRefs.length > 0;
  const claimStatus = typeof source.claimStatus === 'string' ? source.claimStatus : undefined;
  const needsAssertion = source.aiSuggested === true || (claimStatus !== undefined && claimStatus !== 'curated') || evidence;
  if (!graph) return true;
  if ((graph.unexpectedActiveEdgeCount ?? 0) > 0) return true;

  const sourceEndpoint = source.sourceSnapshot as { id?: unknown } | undefined;
  const targetEndpoint = source.targetSnapshot as { id?: unknown } | undefined;
  const expectedSourceId = typeof sourceEndpoint?.id === 'string' ? sourceEndpoint.id : null;
  const expectedTargetId = typeof targetEndpoint?.id === 'string' ? targetEndpoint.id : null;
  const expectedPredicate =
    typeof source.relationType === 'string' ? resolveNeo4jPredicate(source.relationType) : null;
  const edgeTopologyStale =
    graph.activeEdgeCount !== undefined &&
    (graph.activeEdgeCount !== 1 ||
      graph.edgeSourceId !== expectedSourceId ||
      graph.edgeTargetId !== expectedTargetId ||
      graph.edgePredicate !== expectedPredicate);
  const assertionTopologyStale =
    graph.assertionCount !== undefined &&
    graph.assertionCount === 1 &&
    (graph.assertionSourceId !== expectedSourceId ||
      graph.assertionTargetId !== expectedTargetId ||
      graph.assertionPredicate !== expectedPredicate);

  const assertionCount = graph.assertionCount ?? (graph.assertionStatus === null ? 0 : 1);
  const expectedCorrelationId =
    typeof source.sourceCorrelationId === 'string' ? source.sourceCorrelationId : undefined;
  const expectedSourceFingerprint =
    typeof source.sourceFingerprint === 'string' ? source.sourceFingerprint : undefined;
  const edgeSourceVersionStale =
    (expectedCorrelationId !== undefined &&
      graph.edgeSourceCorrelationId !== expectedCorrelationId) ||
    (expectedSourceFingerprint !== undefined &&
      graph.edgeSourceFingerprint !== expectedSourceFingerprint);
  const assertionSourceVersionStale =
    (expectedCorrelationId !== undefined &&
      graph.assertionSourceCorrelationId !== expectedCorrelationId) ||
    (expectedSourceFingerprint !== undefined &&
      graph.assertionSourceFingerprint !== expectedSourceFingerprint);

  if (!needsAssertion) {
    return assertionCount !== 0 || !graph.activeEdge || edgeTopologyStale || edgeSourceVersionStale;
  }
  if (assertionCount !== 1 || graph.assertionStatus === null) return true;
  if (assertionTopologyStale) return true;
  if (assertionSourceVersionStale) return true;
  if (claimStatus !== undefined && graph.assertionStatus !== claimStatus) return true;

  const effectiveStatus = claimStatus ?? graph.assertionStatus;
  if (effectiveStatus === 'rejected') return graph.activeEdge;
  if (effectiveStatus === 'curated') {
    return !graph.activeEdge || edgeTopologyStale || edgeSourceVersionStale;
  }

  const confidence = typeof source.confidence === 'number' ? source.confidence : source.aiSuggested === true ? 50 : 100;
  const machineProposalMayBeWithheld = source.aiSuggested === true && confidence < 75;
  return machineProposalMayBeWithheld
    ? graph.activeEdge && (edgeTopologyStale || edgeSourceVersionStale)
    : !graph.activeEdge || edgeTopologyStale || edgeSourceVersionStale;
}

export const RECONCILED_RELATION_PREDICATES = CLAIM_RELATION_PREDICATES;

export interface ReconciliationRepairOperation {
  kind: ReconciliationKind;
  id: string;
  action: 'replay' | 'delete-candidate';
  reason: string;
}

export interface ReconciliationRepairPlan {
  version: 1;
  operations: ReconciliationRepairOperation[];
  planHash: string;
  applySupported: false;
  destructiveApplyRequiresBackup: true;
}

export function buildReconciliationRepairPlan(
  operations: readonly ReconciliationRepairOperation[]
): ReconciliationRepairPlan {
  const exact = [...operations].sort((left, right) =>
    left.kind === right.kind
      ? left.id === right.id
        ? compareStableStrings(left.action, right.action)
        : compareStableStrings(left.id, right.id)
      : compareStableStrings(left.kind, right.kind)
  );
  const payload = JSON.stringify({ version: 1, operations: exact });
  return {
    version: 1,
    operations: exact,
    planHash: createHash('sha256').update(payload).digest('hex'),
    applySupported: false,
    destructiveApplyRequiresBackup: true,
  };
}
