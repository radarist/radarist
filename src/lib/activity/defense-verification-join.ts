/**
 * @file lib/activity/defense-verification-join.ts
 * @description Owner-scoped join/correlation read model for the Background
 * Verifications facet.
 *
 * This module consumes the producer facts that already exist:
 * - `job-runs` collection (durable id `inngest-${runId}`)
 * - `operationReceipts` (owner + correlation scoped)
 * - `operationAccountingMarkers` (owner + correlation scoped)
 * - `operationSettlements` (resolved per receipt)
 * - Neo4j `VerificationResult` / `EdgeVerificationResult`
 *
 * It never modifies producers, fabricates AgentRuns, or manufactures facts the
 * data cannot prove.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { createLogger } from '@/lib/logger';
import type { JobRun } from '@/lib/inngest/observability';
import { listOperationReceiptsByCorrelation } from '@/lib/operation-receipt-repository';
import { getParentAccountingState } from '@/lib/operation-accounting-marker-repository';
import { type ParentAccountingState } from '@/lib/schemas/operation-accounting-marker';
import { resolveSettledAmount } from '@/lib/operation-settlement-repository';
import { type SettlementResolution } from '@/lib/schemas/operation-settlement';
import { type OperationReceipt } from '@/lib/schemas/operation-receipt';
import { summarizeOperationAccounting } from '@/lib/operation-accounting-summary';
import {
  getVerificationForEntity,
  type VerificationResult,
  type EdgeVerificationResult,
} from '@/lib/graph/verification';
import {
  parseVerificationOutput,
  type VerificationOutputFieldName,
  type VerificationOutputFields,
} from '@/lib/verification-output-contract';
import {
  type DefenseVerificationCost,
  type DefenseVerificationCostState,
  type DefenseVerificationKind,
  type DefenseVerificationListPage,
  type DefenseVerificationPartialReason,
  type DefenseVerificationRow,
  type DefenseVerificationStatus,
  type DefenseVerificationTargetSubIds,
  type ListDefenseVerificationsInput,
} from './defense-verification-types';
import { getVerificationForEdge } from './defense-verification-graph';

const log = createLogger('activity/defense-verification-join');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const RAW_PAGE_BATCH = 100;
const MAX_PAGINATION_LOOPS = 20;

interface Cursor {
  startedAt: number;
  id: string;
}

function kindFromFunctionId(functionId: string): DefenseVerificationKind | null {
  if (functionId === 'verify-entity') return 'entity';
  if (functionId === 'verify-edge') return 'edge';
  return null;
}

function decodeCursor(raw: string): Cursor {
  const json = Buffer.from(raw, 'base64url').toString('utf-8');
  return JSON.parse(json) as Cursor;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

const TERMINAL_STATUSES = new Set<DefenseVerificationStatus>(['completed', 'failed', 'cancelled']);

function sanitizeErrorMessage(input: unknown): string | undefined {
  if (input == null) return undefined;
  const text = typeof input === 'string' ? input : String(input);
  const cleaned = text.replace(/\r?\n/g, ' ').trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : undefined;
}

function microsToDollars(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}

function formatCostDisplay(state: DefenseVerificationCostState, amountMicros?: number, currency?: string): string {
  if (state === 'unavailable') return '—';
  if (state === 'partial' || state === 'incomplete') {
    if (amountMicros != null && currency) {
      return `$${microsToDollars(amountMicros)} ${currency} (${state})`;
    }
    return state === 'partial' ? 'Partial' : 'Incomplete';
  }
  if (amountMicros == null || !currency) return '—';
  const suffix = state === 'settled' ? 'settled' : 'est.';
  return `$${microsToDollars(amountMicros)} ${currency} ${suffix}`;
}

function buildCost(
  state: DefenseVerificationCostState,
  amountMicros?: number,
  currency?: string
): DefenseVerificationCost {
  return {
    state,
    amountMicros,
    currency,
    display: formatCostDisplay(state, amountMicros, currency),
  };
}

/**
 * Read the JobRun output through the ONE shared verification contract.
 *
 * OBS-007 — this used to be a whole-object `zod.parse` against a 0-1 `score`
 * bound the producers never emitted, so a correct 0-100 verdict threw and the
 * caller returned before joining receipts, markers, or the graph result. The row
 * then reported "Malformed output" while every one of those facts existed.
 *
 * Field-level problems now come back as `degradedFields` and never cost the row
 * its other lineage. Only two whole-payload refusals remain, and they mean
 * different things — see `buildDefenseVerificationRow`.
 */
function parseJobRunOutput(
  jobRun: JobRun
):
  | { ok: true; fields: VerificationOutputFields; degradedFields: VerificationOutputFieldName[] }
  | { ok: false; reason: 'malformed-output' | 'hostile-output' } {
  const kind = kindFromFunctionId(jobRun.functionId);
  if (!kind) return { ok: false, reason: 'malformed-output' };
  return parseVerificationOutput(jobRun.output, kind, {
    terminal: TERMINAL_STATUSES.has(jobRun.status),
  });
}

export interface CorrelatedGraphResult {
  resultId?: string;
  resultStatus?: 'verified' | 'unverified' | 'disputed';
  resultScore?: number;
  partialReason?: DefenseVerificationPartialReason;
}

export interface ResolvedReceipt {
  receipt: OperationReceipt;
  resolution: SettlementResolution;
}

/**
 * Present this facet's cost cell from the ONE canonical ledger roll-up.
 *
 * The money rule — a settlement supersedes its receipt's estimate, mixed
 * currencies are not summable, a lost receipt makes a real amount not-whole —
 * lives in `summarizeOperationAccounting` so Defense, Agent Runs, and Builds all
 * reconcile identically and there is one place to fix. This function only
 * formats the canonical result for display.
 */
export function aggregateVerificationCost(
  resolved: readonly ResolvedReceipt[],
  markerState: ParentAccountingState | null
): { cost: DefenseVerificationCost; partialReason?: DefenseVerificationPartialReason } {
  const summary = summarizeOperationAccounting(resolved, markerState);
  return {
    cost: buildCost(summary.state, summary.amountMicros, summary.currency),
    ...(summary.reason ? { partialReason: summary.reason } : {}),
  };
}

async function resolveGraphResult(
  kind: DefenseVerificationKind,
  targetId: string | undefined
): Promise<{
  result: VerificationResult | EdgeVerificationResult | null;
  partialReason?: DefenseVerificationPartialReason;
}> {
  if (!targetId) return { result: null };
  try {
    if (kind === 'entity') {
      const result = await getVerificationForEntity(targetId);
      return { result };
    }
    const result = await getVerificationForEdge(targetId);
    return { result };
  } catch (error) {
    log.error('Graph result lookup failed', error instanceof Error ? error : undefined, {
      kind,
      targetId,
    });
    return { result: null, partialReason: 'dependency-outage' };
  }
}

function correlateGraphResult(
  kind: DefenseVerificationKind,
  fields: VerificationOutputFields,
  graphResult: VerificationResult | EdgeVerificationResult | null,
  receipts: OperationReceipt[]
): CorrelatedGraphResult {
  if (!graphResult) {
    return { partialReason: 'no-graph-result' };
  }

  const resultIds = new Set(
    receipts
      .filter((r) => r.correlation.parentType === 'verification')
      .map((r) => (r.correlation as { verificationResultId?: string }).verificationResultId)
      .filter((id): id is string => Boolean(id))
  );
  if (resultIds.size > 1) {
    return { partialReason: 'ambiguous-graph-result' };
  }

  const targetMatches =
    kind === 'entity'
      ? fields.entityId === (graphResult as VerificationResult).entityId
      : fields.relationId === (graphResult as EdgeVerificationResult).relationId;

  if (!targetMatches) {
    return { partialReason: 'mismatched-graph-result' };
  }

  if (resultIds.size === 1) {
    const claimedResultId = Array.from(resultIds)[0];
    if (claimedResultId && claimedResultId !== graphResult.id) {
      return { partialReason: 'mismatched-graph-result' };
    }
  }

  return {
    resultId: graphResult.id,
    resultStatus: graphResult.status,
    resultScore: graphResult.score,
  };
}

function extractTargetAndSubIds(
  fields: VerificationOutputFields,
  kind: DefenseVerificationKind
): { targetId?: string; targetSubIds?: DefenseVerificationTargetSubIds } {
  if (kind === 'entity') {
    return { targetId: fields.entityId };
  }
  return {
    targetId: fields.relationId,
    targetSubIds:
      fields.sourceEntityId || fields.targetEntityId
        ? { sourceEntityId: fields.sourceEntityId, targetEntityId: fields.targetEntityId }
        : undefined,
  };
}

/** Owner-scoped accounting facts, keyed by JobRun id — independent of the payload. */
async function joinAccounting(
  jobRunId: string,
  accountingOwner: string
): Promise<
  | { ok: false }
  | {
      ok: true;
      receipts: OperationReceipt[];
      resolved: ResolvedReceipt[];
      markerState: ParentAccountingState | null;
      hasSettlementFailure: boolean;
    }
> {
  const [receiptOutcome, markerOutcome] = await Promise.allSettled([
    listOperationReceiptsByCorrelation(accountingOwner, 'verification', jobRunId),
    getParentAccountingState(accountingOwner, 'verification', jobRunId),
  ]);
  if (receiptOutcome.status === 'rejected' || markerOutcome.status === 'rejected') {
    return { ok: false };
  }

  const receipts = receiptOutcome.value;
  const markerState = markerOutcome.value;
  const resolutionOutcomes = await Promise.allSettled(
    receipts.map((receipt) => resolveSettledAmount(accountingOwner, receipt.id))
  );
  const resolved: ResolvedReceipt[] = receipts.map((receipt, i) => {
    const outcome = resolutionOutcomes[i];
    return {
      receipt,
      resolution:
        outcome?.status === 'fulfilled' ? outcome.value : { status: 'conflicted', reason: 'settlement-read-failed' },
    };
  });

  return {
    ok: true,
    receipts,
    resolved,
    markerState,
    hasSettlementFailure: resolutionOutcomes.some((o) => o.status === 'rejected'),
  };
}

function distinctProviders(receipts: readonly OperationReceipt[]): string[] {
  return Array.from(new Set(receipts.map((r) => r.provider).filter(Boolean)));
}

function distinctModels(receipts: readonly OperationReceipt[]): string[] {
  return Array.from(new Set(receipts.filter((r) => r.model).map((r) => r.model as string)));
}

export async function buildDefenseVerificationRow(
  jobRun: JobRun,
  accountingOwner: string
): Promise<DefenseVerificationRow> {
  const kind = kindFromFunctionId(jobRun.functionId) ?? 'entity';
  const attempts = jobRun.retryCount + 1;
  const startedAt = typeof jobRun.startedAt === 'number' ? jobRun.startedAt : null;
  const completedAt = typeof jobRun.completedAt === 'number' ? jobRun.completedAt : undefined;
  const durationMs = startedAt != null && completedAt != null ? completedAt - startedAt : undefined;
  const errorMessage = sanitizeErrorMessage(jobRun.error?.message);

  const outputParse = parseJobRunOutput(jobRun);

  // A HOSTILE payload is adversarial: refuse it whole. A field that happens to
  // validate inside a poisoned object is not evidence, so nothing is mined and
  // nothing is joined.
  if (!outputParse.ok && outputParse.reason === 'hostile-output') {
    return {
      id: jobRun.id,
      kind,
      status: jobRun.status,
      attempts,
      startedAt,
      completedAt,
      durationMs,
      providers: [],
      models: [],
      cost: buildCost('unavailable'),
      partialReason: 'hostile-output',
      errorMessage,
    };
  }

  // A MALFORMED payload is merely unreadable, not adversarial. Receipts and
  // markers are keyed by JobRun id in a trusted store — they do not come from
  // this payload — so reporting "no cost" for a run that provably billed a
  // provider would replace one false statement with another. Join the accounting
  // facts; skip only what the payload itself would have proven (target, verifier,
  // graph correlation).
  if (!outputParse.ok) {
    const accounting = await joinAccounting(jobRun.id, accountingOwner);
    if (!accounting.ok) {
      return {
        id: jobRun.id,
        kind,
        status: jobRun.status,
        attempts,
        startedAt,
        completedAt,
        durationMs,
        providers: [],
        models: [],
        cost: buildCost('partial'),
        partialReason: 'dependency-outage',
        errorMessage,
      };
    }
    const { cost } = aggregateVerificationCost(accounting.resolved, accounting.markerState);
    return {
      id: jobRun.id,
      kind,
      status: jobRun.status,
      attempts,
      startedAt,
      completedAt,
      durationMs,
      providers: distinctProviders(accounting.receipts),
      models: distinctModels(accounting.receipts),
      cost,
      partialReason: 'malformed-output',
      errorMessage,
    };
  }

  const { fields, degradedFields } = outputParse;
  const { targetId, targetSubIds } = extractTargetAndSubIds(fields, kind);
  const verifierModel = fields.verifierModel;

  const [accounting, graphOutcome] = await Promise.all([
    joinAccounting(jobRun.id, accountingOwner),
    // `allSettled` on one promise: resolveGraphResult already converts an outage
    // into a partial reason, but a throw must not lose the accounting join.
    Promise.allSettled([resolveGraphResult(kind, targetId)]).then((r) => r[0]),
  ]);

  if (!accounting.ok) {
    return {
      id: jobRun.id,
      kind,
      status: jobRun.status,
      attempts,
      startedAt,
      completedAt,
      durationMs,
      targetKind: kind,
      targetId,
      targetSubIds,
      verifierModel,
      providers: [],
      models: [],
      cost: buildCost('partial'),
      partialReason: 'dependency-outage',
      degradedFields: degradedFields.length > 0 ? degradedFields : undefined,
      errorMessage,
    };
  }

  const { receipts, resolved, markerState, hasSettlementFailure } = accounting;
  const graphResult = graphOutcome.status === 'fulfilled' ? graphOutcome.value.result : null;
  const graphDegraded = graphOutcome.status === 'fulfilled' ? graphOutcome.value.partialReason : 'dependency-outage';

  const { cost, partialReason: costPartialReason } = aggregateVerificationCost(resolved, markerState);

  const providers = distinctProviders(receipts);
  const models = distinctModels(receipts);

  const baseRow: DefenseVerificationRow = {
    id: jobRun.id,
    kind,
    status: jobRun.status,
    attempts,
    startedAt,
    completedAt,
    durationMs,
    targetKind: kind,
    targetId,
    targetSubIds,
    verifierModel,
    providers,
    models,
    cost,
    // Names WHICH fields were unreadable, independently of whichever reason wins
    // the single `partialReason` slot below — so a score gap stays visible even
    // when a graph or accounting defect outranks it.
    degradedFields: degradedFields.length > 0 ? degradedFields : undefined,
    errorMessage,
  };

  const correlation =
    graphOutcome.status === 'fulfilled'
      ? correlateGraphResult(kind, fields, graphResult, receipts)
      : { partialReason: graphDegraded };

  if (receipts.length === 0 && costPartialReason) {
    // No accounting facts at all — surface that before any graph ambiguity.
    baseRow.partialReason = costPartialReason;
  } else if (costPartialReason && costPartialReason !== 'no-receipts') {
    // Provable accounting incompleteness (marker loss, mixed currency, conflicted
    // settlement) outranks graph-result ambiguity when cost truth is at stake.
    baseRow.partialReason = costPartialReason;
  } else if (correlation.partialReason) {
    baseRow.partialReason = correlation.partialReason;
  } else if (costPartialReason) {
    baseRow.partialReason = costPartialReason;
  } else if (hasSettlementFailure && cost.state !== 'settled') {
    baseRow.partialReason = 'dependency-outage';
  } else if (degradedFields.length > 0) {
    // Everything else proved out; the only gap left is the unreadable field(s).
    baseRow.partialReason = 'malformed-output';
  }

  if (!correlation.partialReason) {
    baseRow.resultId = correlation.resultId;
    baseRow.resultStatus = correlation.resultStatus;
    baseRow.resultScore = correlation.resultScore;
  }

  if (!targetId && kind === 'edge' && jobRun.status === 'failed') {
    baseRow.partialReason = 'orphan-target';
  }

  return baseRow;
}

function docToJobRun(doc: { id: string; data(): Record<string, unknown> }): JobRun {
  const data = doc.data();
  const startedAtValue = data.startedAt;
  const startedAt =
    typeof startedAtValue === 'number'
      ? startedAtValue
      : typeof startedAtValue === 'object' &&
          startedAtValue !== null &&
          typeof (startedAtValue as { toMillis?: unknown }).toMillis === 'function'
        ? (startedAtValue as { toMillis: () => number }).toMillis()
        : 0;
  const completedAtValue = data.completedAt;
  const completedAt =
    typeof completedAtValue === 'number'
      ? completedAtValue
      : typeof completedAtValue === 'object' &&
          completedAtValue !== null &&
          typeof (completedAtValue as { toMillis?: unknown }).toMillis === 'function'
        ? (completedAtValue as { toMillis: () => number }).toMillis()
        : undefined;
  return {
    ...data,
    id: doc.id,
    startedAt,
    completedAt,
  } as JobRun;
}

function mergeRuns(a: JobRun[], b: JobRun[]): JobRun[] {
  const merged: JobRun[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].startedAt !== b[j].startedAt) {
      if (a[i].startedAt > b[j].startedAt) {
        merged.push(a[i]);
        i += 1;
      } else {
        merged.push(b[j]);
        j += 1;
      }
    } else if (a[i].id > b[j].id) {
      merged.push(a[i]);
      i += 1;
    } else {
      merged.push(b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    merged.push(a[i]);
    i += 1;
  }
  while (j < b.length) {
    merged.push(b[j]);
    j += 1;
  }
  return merged;
}

async function fetchFunctionBatch(
  functionId: string,
  streamCursor: Cursor | undefined,
  globalCursor: Cursor | undefined,
  batchSize: number
): Promise<{ runs: JobRun[]; nextStreamCursor: Cursor | undefined }> {
  let query = db
    .collection('job-runs')
    .where('functionId', '==', functionId)
    .orderBy('startedAt', 'desc')
    .orderBy('id', 'desc');
  const effectiveCursor = streamCursor ?? globalCursor;
  if (effectiveCursor) {
    query = query.startAfter(Timestamp.fromMillis(effectiveCursor.startedAt), effectiveCursor.id);
  }
  const snap = await query.limit(batchSize).get();
  const runs = snap.docs.map(docToJobRun);
  const nextStreamCursor =
    runs.length > 0 ? { startedAt: runs[runs.length - 1].startedAt, id: runs[runs.length - 1].id } : streamCursor;
  return { runs, nextStreamCursor };
}

async function readVerificationJobRuns(
  globalCursor: Cursor | undefined,
  limit: number,
  accountingOwner: string,
  kindFilter?: DefenseVerificationKind,
  statusFilter?: DefenseVerificationStatus
): Promise<{ rows: DefenseVerificationRow[]; nextCursor: Cursor | null }> {
  const functionIds: string[] =
    kindFilter === 'edge'
      ? ['verify-edge']
      : kindFilter === 'entity'
        ? ['verify-entity']
        : ['verify-entity', 'verify-edge'];

  const streams = new Map<string, { cursor: Cursor | undefined; exhausted: boolean }>();
  for (const functionId of functionIds) {
    streams.set(functionId, { cursor: undefined, exhausted: false });
  }

  const collected: DefenseVerificationRow[] = [];
  let lastConsumedCursor: Cursor | null = null;
  let reachedLimitWithUnconsumedRows = false;

  for (let loop = 0; loop < MAX_PAGINATION_LOOPS && collected.length < limit; loop += 1) {
    const batches = await Promise.all(
      functionIds.map(async (functionId) => {
        const stream = streams.get(functionId)!;
        if (stream.exhausted) {
          return { functionId, runs: [] as JobRun[] };
        }
        const { runs, nextStreamCursor } = await fetchFunctionBatch(
          functionId,
          stream.cursor,
          globalCursor,
          RAW_PAGE_BATCH
        );
        if (runs.length < RAW_PAGE_BATCH) {
          stream.exhausted = true;
        }
        stream.cursor = nextStreamCursor;
        return { functionId, runs };
      })
    );

    const runsByFunction = new Map<string, JobRun[]>();
    for (const { functionId, runs } of batches) {
      runsByFunction.set(functionId, runs);
    }

    const merged = mergeRuns(runsByFunction.get('verify-entity') ?? [], runsByFunction.get('verify-edge') ?? []);
    if (merged.length === 0) {
      break;
    }

    const rows = await Promise.all(merged.map((jobRun) => buildDefenseVerificationRow(jobRun, accountingOwner)));

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const rawRun = merged[i];
      lastConsumedCursor = { startedAt: rawRun.startedAt, id: rawRun.id };
      if (statusFilter && row.status !== statusFilter) {
        continue;
      }
      collected.push(row);
      if (collected.length >= limit) {
        reachedLimitWithUnconsumedRows = i < merged.length - 1;
        break;
      }
    }
  }

  const allExhausted = functionIds.every((functionId) => streams.get(functionId)!.exhausted);
  const hasMore = reachedLimitWithUnconsumedRows || !allExhausted;
  return {
    rows: collected,
    nextCursor: hasMore && lastConsumedCursor ? lastConsumedCursor : null,
  };
}

export async function listDefenseVerifications(
  input: ListDefenseVerificationsInput
): Promise<DefenseVerificationListPage> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

  try {
    const { rows, nextCursor } = await readVerificationJobRuns(
      cursor,
      limit,
      input.accountingOwner,
      input.kind,
      input.status
    );

    return {
      verifications: rows,
      nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
    };
  } catch (error) {
    log.error('Failed to list defense verifications', error instanceof Error ? error : undefined, {
      cursor: input.cursor,
      limit,
    });
    throw error;
  }
}
