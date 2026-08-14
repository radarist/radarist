/**
 * @file lib/agent-runs.ts
 * @description Data access layer for AgentRuns
 *
 * AgentRuns record individual agent execution results. Each time an agent
 * completes a task (via a mission or a scheduled sweep), an AgentRun is
 * created to capture token usage, cost, duration, and outcome.
 *
 * Used by:
 * - Inngest mission function (B1.4): calls createAgentRun after each step
 * - Activity API routes (B3.2): calls listAgentRuns and getTokenUsageSummary
 * - Activity page hooks: consume the API data
 *
 * Uses firebase-admin (server-side SDK) because agent runs are created and
 * queried exclusively through API routes and Inngest functions.
 *
 * NOTE: AgentRuns do NOT use entity-factory because they don't need
 * slug generation, Neo4j sync, or other entity lifecycle features.
 * They use direct Firestore Admin operations instead.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { createLogger } from '@/lib/logger';
import { observabilityPrincipals } from '@/lib/system-principals';
import {
  agentRunKindSchema,
  createAgentRunSchema,
  inferAgentRunKind,
  inferAgentRunProvider,
} from '@/lib/schemas/agent-run';
import type { AgentRun, AgentRunKind, CreateAgentRunInput } from '@/lib/schemas/agent-run';
import type { AgentTokenBreakdown } from '@/lib/schemas/agent-run';
import type { Mission } from '@/lib/schemas/mission';
import { missionUsageSnapshot } from '@/lib/mission-usage';
import { agentRunUsageSnapshot, type AgentRunUsageProvenance } from '@/lib/agent-run-usage';
import { resolveAgentRunCorrelation } from '@/lib/graph/agent-run-correlation';
import { summarizeChatToolCalls } from '@/lib/chat-tool-summary';

const log = createLogger('agent-runs');
const COLLECTION = 'agentRuns';

/** The agent label build spend is attributed to in the per-agent breakdown. */
const BUILD_AGENT_LABEL = 'builder';

/**
 * ARUN-004: build missions record cost + token usage on their OWN `missions`
 * doc (run-build-mission accumulates `result.usage` there) and NEVER write an
 * `agentRuns` doc, so the token-usage summaries — which read only `agentRuns` —
 * excluded 100% of build spend even though the runs table lists builds right
 * beside the cards. Fold them in by reading builds over the same principal
 * union + window the summaries already use. The `(userId, createdAt)` missions
 * index is the same shape as the agentRuns query, so no new index is required;
 * `kind === 'build'` is filtered in memory (other kinds are counted via their
 * agentRuns docs, so re-adding them here would double-count).
 */
async function fetchBuildMissionsForUsage(userId: string, sinceIso: string): Promise<Mission[]> {
  const snapshot = await db
    .collection('missions')
    .where('userId', 'in', observabilityPrincipals(userId))
    .where('createdAt', '>=', sinceIso)
    .orderBy('createdAt', 'desc')
    .get();
  return snapshot.docs.map((doc) => doc.data() as Mission).filter((m) => m.kind === 'build');
}

/**
 * Generate a unique agent run ID.
 * Format: run-<timestamp>-<random 6 chars>
 */
export function generateAgentRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateAgentRunOptions {
  /** Internal reservation used when downstream receipts must survive a write failure. */
  id?: string;
  /** Defer projection until a terminal accounting patch supplies the final cost truth. */
  deferGraphSync?: boolean;
}

async function syncAgentRunProjectionBestEffort(run: AgentRun): Promise<void> {
  try {
    const { syncAgentRunToNeo4j } = await import('@/lib/graph/agent-run-sync');
    await syncAgentRunToNeo4j({
      id: run.id,
      agentName: run.agentName,
      action: run.action,
      status: run.status,
      userId: run.userId,
      createdAt: run.createdAt,
      costUsd: run.costUsd,
      costState: run.costState,
      duration: run.duration,
      missionId: run.missionId,
      sweepId: run.sweepId,
    });
  } catch {
    /* projection must never break agent execution */
  }
}

/**
 * Normalize historical Firestore rows at the read boundary without rewriting
 * them. This supplies the explicit UI contract while dropping malformed
 * provider/model/tool-summary values rather than reflecting them to clients.
 */
export function normalizeAgentRunForRead(value: unknown): AgentRun {
  const raw =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const {
    kind: _rawKind,
    provider: _rawProvider,
    model: _rawModel,
    costUsd: rawCostUsd,
    costState: rawCostState,
    costUnavailableReason: rawCostUnavailableReason,
    toolSummary: rawToolSummary,
    toolSummaryTruncated: rawToolSummaryTruncated,
    ...rest
  } = raw;

  const kind = inferAgentRunKind(raw);
  const provider = inferAgentRunProvider({ ...raw, kind });
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim().slice(0, 200) : undefined;
  const summary = summarizeChatToolCalls(rawToolSummary);
  const includeToolSummary = kind === 'chat' || Array.isArray(rawToolSummary);
  const hasCost = typeof rawCostUsd === 'number' && Number.isFinite(rawCostUsd) && rawCostUsd >= 0;
  const validCostState = rawCostState === 'estimated' || rawCostState === 'settled';
  const costStateAbsent = rawCostState === undefined;
  const validUnavailableReason =
    rawCostUnavailableReason === 'unknown-pricing' || rawCostUnavailableReason === 'accounting-incomplete'
      ? rawCostUnavailableReason
      : undefined;
  const costFields: Pick<AgentRun, 'costUsd' | 'costState' | 'costUnavailableReason'> =
    hasCost && (costStateAbsent || validCostState)
      ? {
          costUsd: rawCostUsd,
          ...(validCostState ? { costState: rawCostState } : {}),
        }
      : hasCost || rawCostState !== undefined
        ? { costUnavailableReason: 'accounting-incomplete' }
        : validUnavailableReason
          ? { costUnavailableReason: validUnavailableReason }
          : {};

  return {
    ...rest,
    kind,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...costFields,
    ...(includeToolSummary ? { toolSummary: summary.toolSummary } : {}),
    ...(includeToolSummary
      ? { toolSummaryTruncated: rawToolSummaryTruncated === true || summary.toolSummaryTruncated }
      : {}),
  } as AgentRun;
}

/**
 * Create a new agent run record.
 *
 * Validates input against the createAgentRunSchema, generates a unique ID,
 * and persists the document to Firestore.
 *
 * @param input - The agent run creation input
 * @returns The created AgentRun document
 * @throws {ZodError} If input validation fails
 * @throws {Error} If Firestore write fails
 */
export async function createAgentRun(
  input: CreateAgentRunInput,
  options: CreateAgentRunOptions = {}
): Promise<AgentRun> {
  const validated = createAgentRunSchema.parse(input);
  const kind = inferAgentRunKind(validated);
  const provider = inferAgentRunProvider({ ...validated, kind });
  const classified: CreateAgentRunInput = {
    ...validated,
    kind,
    ...(provider ? { provider } : {}),
  };
  // A run has one lifecycle owner. Validate before Firestore commits so the
  // graph adapter can never receive an ambiguous mission/sweep projection.
  resolveAgentRunCorrelation(classified);
  const id = options.id ?? generateAgentRunId();
  if (!/^run-[A-Za-z0-9._:-]+$/.test(id) || id.length > 200) {
    throw new Error('Invalid reserved AgentRun id');
  }
  const now = new Date().toISOString();

  const agentRun: AgentRun = {
    ...classified,
    id,
    createdAt: now,
  };

  // Firestore rejects undefined values — strip them at every depth (the
  // mirrored skillPrelude entries carry optional fields like `target`).
  const firestoreData = sanitizeForFirestore(agentRun);

  try {
    await db.collection(COLLECTION).doc(id).set(firestoreData);

    if (!options.deferGraphSync) void syncAgentRunProjectionBestEffort(agentRun);
    log.info('Agent run recorded', {
      runId: id,
      agent: classified.agentName,
      status: classified.status,
    });
    return agentRun;
  } catch (error) {
    log.error('Failed to create agent run', error instanceof Error ? error : new Error(String(error)), {
      runId: id,
      agent: classified.agentName,
    });
    throw error;
  }
}

/** ARUN-021: the global newest-N recency window. Also the only window that can
 * surface legacy rows written before `kind` was persisted (they cannot match a
 * `kind ==` floor query). */
const GLOBAL_WINDOW_LIMIT = 100;

/** ARUN-021: guaranteed newest-N floor PER KIND, so one chatty kind can never
 * crowd the others out of the list entirely. */
const KIND_FLOOR_LIMIT = 50;

export interface AgentRunListResult {
  runs: AgentRun[];
  /** Kinds whose bounded floor query failed. The global recency window still
   * serves, but callers must disclose that older history may be missing. */
  degradedKinds: AgentRunKind[];
}

/**
 * List agent runs for a specific user, ordered by creation date descending.
 *
 * ARUN-021 — bounded, kind-aware querying. Chat runs are persisted
 * symmetrically with missions/sweeps, so a wall of chat turns could occupy an
 * entire global newest-N window and hide every older mission/sweep. The list
 * is therefore the deduplicated union of:
 *
 *   - one global newest-{@link GLOBAL_WINDOW_LIMIT} window (recency + legacy
 *     rows that predate the persisted `kind` field), and
 *   - one newest-{@link KIND_FLOOR_LIMIT} floor per known kind
 *     (chat/mission/sweep), via the `(userId, kind, createdAt desc)`
 *     composite index.
 *
 * Every query is limit-bounded — never an unbounded collection read; the
 * response is capped at GLOBAL_WINDOW_LIMIT + 3×KIND_FLOOR_LIMIT docs.
 * Ordering is stable: createdAt descending with the id as tiebreaker.
 *
 * ARUN-005: in local single-user mode the list unions in system-initiated
 * runs (sweep/discovery) via the compiled-in principal set — the caller
 * passes ONLY the verified auth uid, never a client-supplied principal.
 *
 * @param userId - The Firebase Auth user ID
 * @returns Array of AgentRun documents, newest first
 */
export async function listAgentRunsWithDiagnostics(
  userId: string,
  opts?: { kindFloors?: boolean }
): Promise<AgentRunListResult> {
  const kindFloors = opts?.kindFloors ?? true;
  try {
    const base = db.collection(COLLECTION).where('userId', 'in', observabilityPrincipals(userId));
    const globalQuery = base.orderBy('createdAt', 'desc').limit(GLOBAL_WINDOW_LIMIT).get();
    // The floors are BEST-EFFORT: they need the (userId, kind, createdAt)
    // composite index, and an environment where it is not (yet) deployed must
    // degrade to the still-servable global window — never a blank Runs page.
    // Callers that only need recency (e.g. the greeting's last-24h count) pass
    // kindFloors: false and skip the extra reads entirely.
    const floorKinds = kindFloors ? agentRunKindSchema.options : [];
    const floorResults = kindFloors
      ? await Promise.allSettled(
          floorKinds.map((kind) =>
            base.where('kind', '==', kind).orderBy('createdAt', 'desc').limit(KIND_FLOOR_LIMIT).get()
          )
        )
      : [];
    const globalSnapshot = await globalQuery;

    const snapshots = [globalSnapshot];
    const degradedKinds: AgentRunKind[] = [];
    for (const [index, result] of floorResults.entries()) {
      if (result.status === 'fulfilled') {
        snapshots.push(result.value);
      } else {
        const kind = floorKinds[index];
        degradedKinds.push(kind);
        log.warn('Kind-floor query failed — serving the global window only for that kind', {
          userId,
          kind,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    const byId = new Map<string, AgentRun>();
    for (const doc of snapshots.flatMap((snapshot) => snapshot.docs)) {
      const run = normalizeAgentRunForRead(doc.data());
      // Legacy docs may lack an `id` field in their data — key such rows by
      // their document id so they never collapse into one Map entry.
      const key = run.id ?? doc.id;
      if (!byId.has(key)) byId.set(key, { ...run, id: run.id ?? doc.id });
    }
    const runs = [...byId.values()].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1
    );
    return { runs, degradedKinds };
  } catch (error) {
    log.error('Failed to list agent runs', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}

/** Backward-compatible data-only read for callers that do not render history
 * completeness. The Activity API uses the diagnostic variant above. */
export async function listAgentRuns(userId: string, opts?: { kindFloors?: boolean }): Promise<AgentRun[]> {
  return (await listAgentRunsWithDiagnostics(userId, opts)).runs;
}

interface ObservedAgentRunUsage {
  input: number;
  output: number;
  costUsd: number;
  /**
   * ARUN-027: true when the row carries NO usable cost measurement. Such a
   * row is counted, not summed — adding it as 0 would understate spend while
   * looking like a precise figure. A persisted 0 is a real measurement and
   * is NOT flagged here.
   */
  costUnavailable: boolean;
  costState: 'estimated' | 'settled' | null;
  /**
   * ARUN-020: true when the row carries NO usable token measurement — either no
   * counters at all, or a provider that reported none (`tokenUsageProvenance:
   * 'unreported'`, whose stored `{0,0}` is a required-field placeholder, not a
   * measurement). Counted, not summed, exactly like `costUnavailable`.
   */
  tokensUnavailable: boolean;
}

/** Aggregate only finite, non-negative persisted measurements. Historical
 * rows can predate required usage fields; one such row must not crash the
 * entire seven-day telemetry endpoint or poison it with NaN. */
function observedAgentRunUsage(run: unknown): ObservedAgentRunUsage {
  const raw = typeof run === 'object' && run !== null ? (run as Record<string, unknown>) : {};
  const tokenUsage =
    typeof raw.tokenUsage === 'object' && raw.tokenUsage !== null ? (raw.tokenUsage as Record<string, unknown>) : {};
  const measured = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  // ARUN-020: the SAME read rule the runs list, run detail and AgentLog use, so
  // a run whose tokens are unknowable can never be summed here as a measured 0
  // while those surfaces render "—" for it.
  const usage = agentRunUsageSnapshot({
    tokenUsage: { input: measured(tokenUsage.input), output: measured(tokenUsage.output) },
    tokenUsageProvenance:
      raw.tokenUsageProvenance === 'provider-reported' ||
      raw.tokenUsageProvenance === 'partially-reported' ||
      raw.tokenUsageProvenance === 'unreported'
        ? raw.tokenUsageProvenance
        : undefined,
  });
  const hasCost = typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) && raw.costUsd >= 0;
  const costState =
    raw.costState === undefined
      ? 'settled'
      : raw.costState === 'estimated' || raw.costState === 'settled'
        ? raw.costState
        : null;
  const costUsable = hasCost && costState !== null;
  return {
    input: usage.unavailable ? 0 : usage.input,
    output: usage.unavailable ? 0 : usage.output,
    costUsd: costUsable ? measured(raw.costUsd) : 0,
    costUnavailable: !costUsable,
    costState: costUsable ? costState : null,
    tokensUnavailable: usage.unavailable,
  };
}

/**
 * ARUN-027 + BUILD-035 — per-day accounting buckets. `costUsd` is observed or
 * explicitly estimated spend. Authority that may still be consumed lives in
 * `reservedCostUsd`; terminal work without provider truth lives in
 * `unsettledMaximumUsd`. `maximumExposureUsd` is the sum used for budget risk:
 *
 *   settled     — the run reached a terminal state with a recorded cost.
 *   reserved    — an in-flight build's accrued spend; not final, and not the
 *                 same claim as money already spent.
 *   unavailable — rows with no cost measurement at all. Counted so the UI can
 *                 say "+N runs without cost data" instead of implying the
 *                 total covers everything.
 *
 * Build classification comes only from the persisted accounting snapshot. It
 * never guesses from mission status.
 */
interface DailyUsageBuckets {
  input: number;
  output: number;
  costUsd: number;
  settledCostUsd: number;
  estimatedCostUsd: number;
  reservedCostUsd: number;
  unsettledMaximumUsd: number;
  maximumExposureUsd: number;
  unavailableCostRuns: number;
  /** ARUN-020: rows whose token count is unknowable — counted, never summed. */
  unavailableTokenRuns: number;
}

function emptyDailyBuckets(): DailyUsageBuckets {
  return {
    input: 0,
    output: 0,
    costUsd: 0,
    settledCostUsd: 0,
    estimatedCostUsd: 0,
    reservedCostUsd: 0,
    unsettledMaximumUsd: 0,
    maximumExposureUsd: 0,
    unavailableCostRuns: 0,
    unavailableTokenRuns: 0,
  };
}

/** Per-day totals as served to clients (ARUN-027 split + legacy fields). */
export interface DailyUsageTotals {
  input: number;
  output: number;
  total: number;
  /** Observed plus explicitly estimated spend. Excludes authority-only buckets. */
  costUsd: number;
  settledCostUsd: number;
  estimatedCostUsd: number;
  reservedCostUsd: number;
  unsettledMaximumUsd: number;
  /** Settled + estimated + active reservation + unsettled maximum exposure. */
  maximumExposureUsd: number;
  unavailableCostRuns: number;
  /** ARUN-020: rows whose token count is unknowable — counted, never summed. */
  unavailableTokenRuns: number;
}

function toDailyTotals(buckets: DailyUsageBuckets): DailyUsageTotals {
  return {
    input: buckets.input,
    output: buckets.output,
    total: buckets.input + buckets.output,
    costUsd: buckets.costUsd,
    settledCostUsd: buckets.settledCostUsd,
    estimatedCostUsd: buckets.estimatedCostUsd,
    reservedCostUsd: buckets.reservedCostUsd,
    unsettledMaximumUsd: buckets.unsettledMaximumUsd,
    maximumExposureUsd: buckets.maximumExposureUsd,
    unavailableCostRuns: buckets.unavailableCostRuns,
    unavailableTokenRuns: buckets.unavailableTokenRuns,
  };
}

/**
 * Get a token usage summary for a user over the past 7 days.
 *
 * Returns today's totals and a 7-day daily breakdown.
 * Used by the Activity page to render usage charts.
 *
 * @param userId - The Firebase Auth user ID
 * @returns Observed token and cost usage for today and the past 7 days
 */
export async function getTokenUsageSummary(userId: string): Promise<{
  today: DailyUsageTotals;
  thisWeek: Array<DailyUsageTotals & { date: string }>;
}> {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // ARUN-005: same principal union as listAgentRuns — the cost/token cards
    // must reconcile with the runs table rendered directly below them.
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', 'in', observabilityPrincipals(userId))
      .where('createdAt', '>=', weekAgo.toISOString())
      .orderBy('createdAt', 'desc')
      .get();

    const runs = snapshot.docs.map((doc) => doc.data() as AgentRun);
    // Group by date
    const byDate = new Map<string, DailyUsageBuckets>();
    for (const run of runs) {
      const date = run.createdAt.split('T')[0];
      const existing = byDate.get(date) ?? emptyDailyBuckets();
      const usage = observedAgentRunUsage(run);
      existing.input += usage.input;
      existing.output += usage.output;
      existing.costUsd += usage.costUsd;
      if (usage.tokensUnavailable) existing.unavailableTokenRuns += 1;
      if (usage.costUnavailable) existing.unavailableCostRuns += 1;
      else {
        if (usage.costState === 'estimated') existing.estimatedCostUsd += usage.costUsd;
        else existing.settledCostUsd += usage.costUsd;
        existing.maximumExposureUsd += usage.costUsd;
      }
      byDate.set(date, existing);
    }

    // ARUN-004: fold build-mission spend (its own doc, no agentRuns row) into the
    // same per-date buckets so the cost/token cards reconcile with the builds
    // listed in the runs table below them.
    const builds = await fetchBuildMissionsForUsage(userId, weekAgo.toISOString());
    for (const build of builds) {
      const date = build.createdAt.split('T')[0];
      const existing = byDate.get(date) ?? emptyDailyBuckets();
      // ARUN-020: the SAME authoritative snapshot the runs list and run
      // detail read — the totals can never diverge from those surfaces.
      const usage = missionUsageSnapshot(build);
      existing.input += usage.input;
      existing.output += usage.output;
      if (usage.tokens === undefined) existing.unavailableTokenRuns += 1;
      existing.costUsd += usage.costUsd ?? 0;
      existing.settledCostUsd += usage.settledCostUsd ?? 0;
      existing.estimatedCostUsd += usage.estimatedCostUsd ?? 0;
      existing.reservedCostUsd += usage.reservedCostUsd ?? 0;
      existing.unsettledMaximumUsd += usage.unsettledMaximumUsd ?? 0;
      existing.maximumExposureUsd += usage.maximumExposureUsd ?? 0;
      if (usage.costUnavailable) existing.unavailableCostRuns += 1;
      byDate.set(date, existing);
    }

    const todayStr = now.toISOString().split('T')[0];
    const todayData = byDate.get(todayStr) ?? emptyDailyBuckets();

    const thisWeek = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(now);
      date.setDate(date.getDate() - (6 - i));
      const dateStr = date.toISOString().split('T')[0];
      return { date: dateStr, ...toDailyTotals(byDate.get(dateStr) ?? emptyDailyBuckets()) };
    });

    return { today: toDailyTotals(todayData), thisWeek };
  } catch (error) {
    log.error('Failed to get token usage summary', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}

/**
 * Get per-agent token usage breakdown for a user over the past 7 days.
 *
 * Groups all agent runs by agentName and returns total tokens, cost, and run
 * count per agent. Used by the Token Budget dashboard to show cost drivers.
 *
 * @param userId - The Firebase Auth user ID
 * @returns Array of per-agent token breakdowns, sorted by totalTokens desc
 */
export async function getTokenUsageByAgent(userId: string): Promise<AgentTokenBreakdown[]> {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // ARUN-005: unioned for the same reason as getTokenUsageSummary above.
    const snapshot = await db
      .collection(COLLECTION)
      .where('userId', 'in', observabilityPrincipals(userId))
      .where('createdAt', '>=', weekAgo.toISOString())
      .orderBy('createdAt', 'desc')
      .get();

    const runs = snapshot.docs.map((doc) => doc.data() as AgentRun);

    const byAgent = new Map<string, AgentTokenBreakdown>();
    for (const run of runs) {
      const existing = byAgent.get(run.agentName) ?? {
        agentName: run.agentName,
        model: run.model ?? 'unknown',
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
        totalCost: 0,
        settledCost: 0,
        estimatedCost: 0,
        unavailableCostRuns: 0,
        unavailableTokenRuns: 0,
        runCount: 0,
      };
      const usage = observedAgentRunUsage(run);
      existing.totalInput += usage.input;
      existing.totalOutput += usage.output;
      existing.totalTokens += usage.input + usage.output;
      existing.totalCost += usage.costUsd;
      if (usage.tokensUnavailable) existing.unavailableTokenRuns += 1;
      if (usage.costUnavailable) existing.unavailableCostRuns += 1;
      else if (usage.costState === 'estimated') existing.estimatedCost += usage.costUsd;
      else existing.settledCost += usage.costUsd;
      existing.runCount += 1;
      // ARUN-003: rows iterate newest→oldest (createdAt desc), so the model
      // captured at init IS the most recent — older runs must never overwrite
      // it. (The old unconditional assignment made the OLDEST run win.) Older
      // rows only backfill when the newest run carried no model at all.
      if (existing.model === 'unknown' && run.model) existing.model = run.model;
      byAgent.set(run.agentName, existing);
    }

    // ARUN-004: attribute build-mission spend to a 'builder' row so it shows as a
    // cost driver alongside the agentRuns-sourced agents (builds write no
    // agentRuns doc, so they were invisible here).
    const builds = await fetchBuildMissionsForUsage(userId, weekAgo.toISOString());
    for (const build of builds) {
      const agentName = build.agent || BUILD_AGENT_LABEL;
      // ARUN-020: same authoritative snapshot as the summary above.
      const usage = missionUsageSnapshot(build);
      const { input, output, costUsd } = usage;
      const existing = byAgent.get(agentName) ?? {
        agentName,
        model: 'unknown',
        totalInput: 0,
        totalOutput: 0,
        totalTokens: 0,
        totalCost: 0,
        settledCost: 0,
        estimatedCost: 0,
        unavailableCostRuns: 0,
        unavailableTokenRuns: 0,
        runCount: 0,
      };
      if (usage.tokens === undefined) existing.unavailableTokenRuns += 1;
      existing.totalInput += input;
      existing.totalOutput += output;
      existing.totalTokens += input + output;
      existing.totalCost += costUsd ?? 0;
      existing.settledCost += usage.settledCostUsd ?? 0;
      existing.estimatedCost += usage.estimatedCostUsd ?? 0;
      if (usage.costUnavailable) existing.unavailableCostRuns += 1;
      existing.runCount += 1;
      byAgent.set(agentName, existing);
    }

    return Array.from(byAgent.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  } catch (error) {
    log.error('Failed to get token usage by agent', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}

/**
 * ARUN-008: idempotent AgentRun fallback for infrastructure-level mission
 * failures.
 *
 * Inngest's `onFailure` fires when the handler dies after retries — which can
 * happen BEFORE the normal Step-3 AgentRun write (early-step crash) or AFTER
 * it (a later step failed). This helper makes the failure visible in run
 * history without ever duplicating a real row:
 *
 *   1. If ANY AgentRun already exists for the mission, reconcile that row to
 *      failure in place. This closes the terminal split where the AgentRun
 *      write succeeded but the following Mission terminal write failed.
 *   2. Otherwise `create()` a row at the deterministic id
 *      `run-fallback-<missionId>`; a concurrent/retried onFailure loses the
 *      create race (ALREADY_EXISTS) and is treated as skipped, so retries are
 *      idempotent even without the query.
 *
 * The row is honest about what it doesn't know: `durationUnknown: true`
 * (rendered as "—", never a fabricated 0ms) and cost/tokens only from what the
 * mission doc persisted pre-failure (H1 running-cost snapshots). Missing cost
 * is explicitly unavailable, never a settled zero — and ARUN-029 extends the
 * same rule to tokens: an absent `tokenUsage` is recorded as `unreported`
 * rather than the writer's `{0,0}` default, which every surface would
 * otherwise render as a measured "0 tokens" for a run that spent real money.
 * The mission's structured `failureCode` is carried onto the row too, so the
 * run detail can state the durable machine-readable reason instead of leaving
 * the reader to parse `errors[0]`.
 */
export async function recordMissionFailureFallback(input: {
  missionId: string;
  userId: string;
  agentName: string;
  errorMessage: string;
  /** Pre-failure spend persisted on the mission doc, when available. */
  costUsd?: number;
  costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
  tokenUsage?: { input: number; output: number };
  /** ARUN-029: the mission's stable terminal failure code, when one was derived. */
  failureCode?: AgentRun['failureCode'];
}): Promise<{ written: boolean; reason: 'created' | 'reconciled-existing' | 'lost-create-race' }> {
  const existing = await db.collection(COLLECTION).where('missionId', '==', input.missionId).limit(1).get();
  if (!existing.empty) {
    const existingDoc = existing.docs[0];
    const existingData = existingDoc.data() as Partial<AgentRun>;
    if (existingData.userId !== input.userId) {
      throw new Error(`Refusing to reconcile AgentRun ${existingDoc.id}: mission owner mismatch`);
    }

    const failureMessage = input.errorMessage.slice(0, 1000);
    const priorErrors = Array.isArray(existingData.errors)
      ? existingData.errors.filter((value): value is string => typeof value === 'string')
      : [];
    const errors = Array.from(new Set([...priorErrors, failureMessage]));
    await existingDoc.ref.update(
      sanitizeForFirestore({
        status: 'failure',
        errors,
        // ARUN-029: the reconciled row must carry the same durable machine
        // reason the Mission doc got. Never clear an existing code with
        // `undefined` — a later abort with no derivable code is not evidence
        // that the first one was wrong.
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      })
    );
    log.warn('Existing AgentRun reconciled to infrastructure failure', {
      missionId: input.missionId,
      existingRunId: existingDoc.id,
    });
    return { written: true, reason: 'reconciled-existing' };
  }

  const id = `run-fallback-${input.missionId}`;
  const run: AgentRun = {
    id,
    userId: input.userId,
    missionId: input.missionId,
    kind: 'mission',
    agentName: input.agentName,
    action: `Mission failed before completion: ${input.errorMessage.slice(0, 300)}`,
    status: 'failure',
    // ARUN-029: `{0,0}` is a required-field placeholder here, not a
    // measurement — the provenance says so, and `agentRunUsageSnapshot` turns
    // it into "—" on every surface instead of a confident zero.
    tokenUsage: input.tokenUsage ?? { input: 0, output: 0 },
    tokenUsageProvenance: input.tokenUsage ? 'provider-reported' : 'unreported',
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    ...(input.costUsd === undefined || input.costUnavailableReason
      ? { costUnavailableReason: input.costUnavailableReason ?? ('accounting-incomplete' as const) }
      : { costUsd: input.costUsd }),
    duration: 0,
    durationUnknown: true,
    errors: [input.errorMessage.slice(0, 1000)],
    createdAt: new Date().toISOString(),
  };

  try {
    await db.collection(COLLECTION).doc(id).create(run);
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 6 || code === 'already-exists' || /ALREADY_EXISTS/i.test(String(error))) {
      log.info('Failure fallback lost the create race — row already written', { missionId: input.missionId });
      return { written: false, reason: 'lost-create-race' };
    }
    throw error;
  }

  log.info('Infrastructure-failure fallback AgentRun written', { missionId: input.missionId, runId: id });
  return { written: true, reason: 'created' };
}

/**
 * AI-029 — patch an AgentRun's headline cost AFTER the durable operation
 * receipts that justify it have been flushed. The chat route creates its
 * AgentRun with `costUnavailableReason: 'accounting-incomplete'` (the receipts
 * are written next), then calls this to persist the estimated headline once the
 * flush outcome is known. The headline is DERIVED from the receipts (single
 * source of truth); this helper only persists the result.
 *
 * Best-effort and non-fatal: a failure here leaves the row at
 * `accounting-incomplete`, which is honest — it must never fabricate a number.
 * `usage` is derived from durable receipts by the chat terminalization seam.
 * The whole modelUsage map is replaced transactionally; model ids containing
 * dots or slashes remain literal keys and requested/last-model guesses cannot
 * survive the patch.
 */
export interface AgentRunAccountingUsage {
  /** Present only when exactly one provider-reported served model was observed. */
  model?: string;
  /** Authoritative per-provider-reported-model receipt breakdown. */
  modelUsage: NonNullable<CreateAgentRunInput['modelUsage']>;
  /** Authoritative aggregate of the durable receipt counters. */
  tokenUsage: CreateAgentRunInput['tokenUsage'];
  /**
   * ARUN-020 — how much of `tokenUsage` the provider reported. Republished with
   * the counters so a terminal patch can never leave a stale provenance
   * describing a superseded total.
   */
  tokenUsageProvenance: AgentRunUsageProvenance;
}

export async function patchAgentRunAccounting(
  runId: string,
  headline: { costUsd: number | null; costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete' },
  usage: AgentRunAccountingUsage
): Promise<void> {
  const ref = db.collection(COLLECTION).doc(runId);
  let updatedRun: AgentRun | undefined;
  try {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error('AgentRun not found');
      const raw = snapshot.data();
      if (!raw) throw new Error('AgentRun data missing');
      const validated = createAgentRunSchema.parse(raw);
      const patch =
        headline.costUsd === null
          ? {
              costUsd: FieldValue.delete(),
              costState: FieldValue.delete(),
              costUnavailableReason: headline.costUnavailableReason ?? 'accounting-incomplete',
              model: usage.model ?? FieldValue.delete(),
              modelUsage: usage.modelUsage,
              tokenUsage: usage.tokenUsage,
              tokenUsageProvenance: usage.tokenUsageProvenance,
            }
          : {
              costUsd: headline.costUsd,
              costState: 'estimated' as const,
              costUnavailableReason: FieldValue.delete(),
              model: usage.model ?? FieldValue.delete(),
              modelUsage: usage.modelUsage,
              tokenUsage: usage.tokenUsage,
              tokenUsageProvenance: usage.tokenUsageProvenance,
            };
      tx.update(ref, sanitizeForFirestore(patch));
      const nextRun: AgentRun = {
        ...validated,
        id: runId,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        modelUsage: usage.modelUsage,
        tokenUsage: usage.tokenUsage,
        tokenUsageProvenance: usage.tokenUsageProvenance,
        ...(headline.costUsd === null
          ? {
              costUsd: undefined,
              costState: undefined,
              costUnavailableReason: headline.costUnavailableReason ?? 'accounting-incomplete',
            }
          : { costUsd: headline.costUsd, costState: 'estimated', costUnavailableReason: undefined }),
      };
      if (usage.model) nextRun.model = usage.model;
      else delete nextRun.model;
      updatedRun = nextRun;
    });
  } catch (error) {
    log.error('Failed to patch AgentRun accounting', error instanceof Error ? error : new Error(String(error)), {
      runId,
    });
    throw error;
  }
  // Terminal accounting truth is not complete until the graph projection has
  // observed the final cost authority. The adapter remains best-effort and
  // swallows graph failures, but this call is deliberately awaited so the
  // fire-and-forget race cannot strand a permanently incomplete projection.
  if (updatedRun) await syncAgentRunProjectionBestEffort(updatedRun);
}
