/**
 * @file lib/missions.ts
 * @description Data access layer for Missions
 *
 * Missions represent agent tasks dispatched from the UI. A mission tracks
 * the user prompt, executing agent, progress, discovered entities/sources,
 * and eventual result.
 *
 * Uses firebase-admin (server-side SDK) because missions are created and
 * managed exclusively through API routes and Inngest functions.
 *
 * NOTE: Missions do NOT use entity-factory because they don't need
 * slug generation, Neo4j sync, or other entity lifecycle features.
 * They use direct Firestore Admin operations instead.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { db } from '@/lib/firebase-admin';
import { observabilityPrincipals } from '@/lib/system-principals';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { withDeadline } from '@/lib/firestore-deadline';
import { createLogger } from '@/lib/logger';
import { createMissionSchema, missionExecutionEnvelopeSchema, MISSION_PROMPT_MAX_CHARS } from '@/lib/schemas/mission';
import type { Mission, CreateMissionInput, MissionExecutionEnvelope } from '@/lib/schemas/mission';
import type { Slot, ClassifierMetadata } from '@/lib/schemas/mission';
import { ceilingCents } from '@/lib/mission-limits';
import { resolveDesignBrief } from '@/lib/schemas/design-brief';
import { resolveMissionDeliverable } from '@/lib/mission-deliverable';
import { deriveBuildCostAccounting, type BuildCostAccountingSnapshot } from '@/lib/build-mission-budget';

const log = createLogger('missions');
const COLLECTION = 'missions';

/**
 * Generate a unique mission ID.
 * Format: mission-<timestamp>-<random 6 chars>
 */
function generateMissionId(): string {
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a new mission for a user.
 *
 * Validates input against the createMissionSchema, generates a unique ID,
 * and persists the mission document to Firestore.
 *
 * @param userId - The Firebase Auth user ID of the mission creator
 * @param input - The mission creation input (prompt + agent)
 * @returns The created Mission document
 * @throws {ZodError} If input validation fails
 * @throws {Error} If Firestore write fails
 */
export interface CreateMissionExtras {
  slots?: Slot[];
  classifierMetadata?: ClassifierMetadata;
  authorizedMaxCostUsd?: number;
  /**
   * COORD-012: the complete execution envelope the dispatch surface froze at
   * user confirmation. Validated against its own schema (components must sum
   * to the declared total) and, when `authorizedMaxCostUsd` is also present,
   * against that cap in exact cents — a confirmation for one allocation can
   * never persist a different one.
   */
  executionEnvelope?: MissionExecutionEnvelope;
  /**
   * Per-mission opt-out for Step 1.7 skill-activation prelude. When false,
   * Step 1.7 short-circuits even if the prompt has a CRITICAL DIMENSIONS
   * block. Used for controlled A/B benchmarks. Undefined = enabled (default).
   */
  enablePrelude?: boolean;
}

/**
 * Pure mission-document builder: validation + defaults + Firestore-safe
 * payload, with no write. Extracted from createMission so transactional
 * callers (REPORT-005's `ensureExecutionMission`) mint the exact same
 * document shape inside their own transaction instead of hand-rolling one.
 */
export function buildMissionDocument(
  userId: string,
  input: CreateMissionInput,
  extras: CreateMissionExtras = {}
): { id: string; mission: Mission; firestoreData: Record<string, unknown> } {
  const validated = createMissionSchema.parse(input);
  if (
    extras.authorizedMaxCostUsd !== undefined &&
    (!Number.isFinite(extras.authorizedMaxCostUsd) || extras.authorizedMaxCostUsd <= 0)
  ) {
    throw new Error('authorizedMaxCostUsd must be a positive finite number');
  }
  const executionEnvelope =
    extras.executionEnvelope !== undefined ? missionExecutionEnvelopeSchema.parse(extras.executionEnvelope) : undefined;
  if (
    executionEnvelope !== undefined &&
    extras.authorizedMaxCostUsd !== undefined &&
    ceilingCents(executionEnvelope.totalMaxCostUsd) !== ceilingCents(extras.authorizedMaxCostUsd)
  ) {
    throw new Error(
      `executionEnvelope.totalMaxCostUsd $${executionEnvelope.totalMaxCostUsd.toFixed(2)} must equal ` +
        `the confirmed authorizedMaxCostUsd $${extras.authorizedMaxCostUsd.toFixed(2)}`
    );
  }
  const id = generateMissionId();
  const now = new Date().toISOString();

  const proposedSlots = extras.slots ?? [{ name: 'main', intent: 'legacy default (no classifier)' }];

  // MISSION-011: bind the mission to its real deliverable HERE, at the one
  // document builder every dispatch path shares (route, chat tool, chain step,
  // sweep cron, transactional execution mission). A proposal-deliverable agent
  // gets its structured-bundle contract appended and loses any report slot it
  // did not ask for, so no caller can dispatch a report-shaped Linker mission by
  // forgetting a flag.
  const deliverable = resolveMissionDeliverable({
    agent: validated.agent,
    prompt: validated.prompt,
    slots: proposedSlots,
  });
  const slots = deliverable.slots;
  if (deliverable.droppedSlots.length > 0) {
    log.info('Dropped report slots — mission deliverable is a structured proposal', {
      agent: validated.agent,
      droppedSlots: deliverable.droppedSlots.map((slot) => slot.name),
    });
  }
  // The prompt cap was checked against the CALLER's prompt; appending the
  // contract can carry a near-cap prompt over it. Refuse the dispatch rather
  // than persisting a document that violates its own schema — an unparseable
  // mission doc is unreadable to every later reader, which is strictly worse
  // than a dispatch-time error that names the exact overflow.
  if (deliverable.prompt.length > MISSION_PROMPT_MAX_CHARS) {
    throw new Error(
      `Mission prompt plus the required proposal-deliverable contract is ${deliverable.prompt.length} characters, ` +
        `over the ${MISSION_PROMPT_MAX_CHARS} limit. Shorten the prompt by ` +
        `${deliverable.prompt.length - MISSION_PROMPT_MAX_CHARS} characters.`
    );
  }

  // Empower-all: EVERY mission carries a brand brief, so whichever agent ends up
  // rendering charts/infographics produces on-brand output — the styling artifact
  // is shared across all agents, not gated to "report agents". Explicit user
  // directives win; otherwise the default brand theme applies.
  const designBrief = resolveDesignBrief(userId, validated.designBrief);

  const mission: Mission = {
    id,
    userId,
    prompt: deliverable.prompt,
    agent: validated.agent,
    kind: validated.kind,
    status: 'pending',
    progress: 0,
    entities: [],
    sources: [],
    createdAt: now,
    slots,
    ...(designBrief ? { designBrief } : {}),
    ...(validated.modelOverrides ? { modelOverrides: validated.modelOverrides } : {}),
    ...(validated.artifactKind ? { artifactKind: validated.artifactKind } : {}),
    ...(validated.buildMode ? { buildMode: validated.buildMode } : {}),
    ...(validated.motivation ? { motivation: validated.motivation } : {}),
    // OBS-004: the durable sweep→child link. Persisted at CREATE because the
    // mission runner reads it at terminal time, long after the sweep that
    // dispatched it has returned; there is no later moment to establish it.
    ...(validated.sweepId ? { sweepId: validated.sweepId } : {}),
    ...(extras.classifierMetadata ? { classifierMetadata: extras.classifierMetadata } : {}),
    ...(extras.authorizedMaxCostUsd !== undefined ? { authorizedMaxCostUsd: extras.authorizedMaxCostUsd } : {}),
    ...(executionEnvelope !== undefined ? { executionEnvelope } : {}),
    ...(extras.enablePrelude !== undefined ? { enablePrelude: extras.enablePrelude } : {}),
  };

  // Strip undefined at every depth for Firestore (admin SDK rejects undefined,
  // including inside nested arrays like skillPrelude entries).
  const firestoreData = sanitizeForFirestore(mission) as Record<string, unknown>;
  return { id, mission, firestoreData };
}

export async function createMission(
  userId: string,
  input: CreateMissionInput,
  extras: CreateMissionExtras = {}
): Promise<Mission> {
  const { id, mission, firestoreData } = buildMissionDocument(userId, input, extras);

  try {
    await withDeadline(db.collection(COLLECTION).doc(id).set(firestoreData), 'createMission.set');
    log.info('Mission created', { missionId: id, userId, agent: mission.agent, slotCount: mission.slots?.length ?? 0 });
    return mission;
  } catch (error) {
    log.error('Failed to create mission', error instanceof Error ? error : new Error(String(error)), {
      missionId: id,
      userId,
    });
    throw error;
  }
}

/**
 * Retrieve a mission by its ID.
 *
 * @param id - The mission document ID
 * @returns The Mission if found, or null
 */
export async function getMissionById(id: string): Promise<Mission | null> {
  try {
    const docSnap = await withDeadline(db.collection(COLLECTION).doc(id).get(), 'getMissionById.get');
    if (!docSnap.exists) return null;
    return docSnap.data() as Mission;
  } catch (error) {
    log.error('Failed to get mission', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    throw error;
  }
}

/**
 * List missions for a specific user, ordered by creation date descending.
 *
 * Returns at most 50 missions to keep response sizes reasonable.
 *
 * @param userId - The Firebase Auth user ID
 * @returns Array of Mission documents, newest first
 */
export async function listMissions(userId: string): Promise<Mission[]> {
  try {
    const snapshot = await withDeadline(
      // ARUN-005: union in system-dispatched missions (compiled-in list).
      db
        .collection(COLLECTION)
        .where('userId', 'in', observabilityPrincipals(userId))
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get(),
      'listMissions.get'
    );

    return snapshot.docs.map((doc) => doc.data() as Mission);
  } catch (error) {
    log.error('Failed to list missions', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}

/**
 * Update specific fields on an existing mission.
 *
 * Typically called by Inngest functions to update progress, status,
 * entities, and sources during agent execution.
 *
 * @param id - The mission document ID
 * @param updates - Partial mission fields to merge
 * @throws {Error} If Firestore update fails (e.g. document does not exist)
 */
export async function updateMission(
  id: string,
  updates: Partial<Mission>,
  options: { deleteFields?: Array<keyof Mission> } = {}
): Promise<void> {
  // Firestore rejects undefined values — strip them at every depth before
  // updating (skillPrelude entries carry optional fields like `target`).
  const cleanUpdates = sanitizeForFirestore(updates) as Record<string, unknown>;
  const deleteFields = new Set<keyof Mission>(options.deleteFields ?? []);
  // Keep the cost truth encoding mutually exclusive on every writer. A
  // measured total supersedes an older unavailable marker; an unavailable
  // marker removes any in-flight numeric snapshot that would otherwise look
  // settled after terminalization.
  if (typeof cleanUpdates.costUsd === 'number') {
    deleteFields.add('costUnavailableReason');
    deleteFields.add('costUnavailableComponents');
  } else if (typeof cleanUpdates.costUnavailableReason === 'string') {
    deleteFields.add('costUsd');
    deleteFields.add('costBreakdownUsd');
  }
  if (deleteFields.size > 0) {
    const { FieldValue } = await import('firebase-admin/firestore');
    for (const field of deleteFields) cleanUpdates[field] = FieldValue.delete();
  }

  try {
    await withDeadline(db.collection(COLLECTION).doc(id).update(cleanUpdates), 'updateMission.update');
    log.debug('Mission updated', { missionId: id, fields: Object.keys(cleanUpdates) });
  } catch (error) {
    log.error('Failed to update mission', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    throw error;
  }
}

/** Delete the mission record. Callers handle cascade (output entity, sandbox). */
export async function deleteMission(id: string): Promise<void> {
  try {
    await withDeadline(db.collection(COLLECTION).doc(id).delete(), 'deleteMission.delete');
    log.info('Mission deleted', { missionId: id });
  } catch (error) {
    log.error('Failed to delete mission', error instanceof Error ? error : new Error(String(error)), { missionId: id });
    throw error;
  }
}

/**
 * H4 + H8: List missions that have been stuck in a non-terminal state
 * for longer than the threshold. "Stuck" = status is 'running' or
 * 'pending' AND createdAt is older than now - thresholdHours.
 *
 * Inngest's onFailure only fires when the function THROWS — if the worker
 * is killed (process death, OOM, deploy), the mission stays 'running'
 * forever. This query feeds the lifecycle GC that forces them terminal.
 *
 * Implementation: Firestore can't OR across status values in a single
 * query, so we run two queries in parallel and merge. createdAt is an
 * ISO string in this collection, which sorts lexicographically the same
 * way it sorts chronologically — safe to compare directly.
 */
export async function getStuckMissions(thresholdHours: number): Promise<Mission[]> {
  const cutoffIso = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();
  try {
    const [runningSnap, pendingSnap] = await Promise.all([
      withDeadline(
        db.collection(COLLECTION).where('status', '==', 'running').where('createdAt', '<', cutoffIso).get(),
        'getStuckMissions.running'
      ),
      withDeadline(
        db.collection(COLLECTION).where('status', '==', 'pending').where('createdAt', '<', cutoffIso).get(),
        'getStuckMissions.pending'
      ),
    ]);
    return (
      [...runningSnap.docs, ...pendingSnap.docs]
        .map((d) => d.data() as Mission)
        // Build missions legitimately sit 'running' for days at human
        // approval gates (step.waitForEvent); they have their own GC
        // (IMPULSE_BUILD_GC_THRESHOLD_HOURS). Filter in memory — a
        // Firestore where('kind','==','research') would skip legacy docs
        // that predate the field.
        .filter((m) => m.kind !== 'build')
    );
  } catch (error) {
    log.error('Failed to query stuck missions', error instanceof Error ? error : new Error(String(error)), {
      thresholdHours,
    });
    throw error;
  }
}

/**
 * H4 + H8: Force a stuck mission into terminal 'failed' state with a
 * marker error. Stamps completedAt so list queries treat it like a
 * normal failed mission.
 */
export async function markMissionStuck(missionId: string, reason: string): Promise<void> {
  await updateMission(missionId, {
    status: 'failed',
    errors: [reason],
    completedAt: new Date().toISOString(),
  });
}

type BuildSessionRecord = NonNullable<Mission['sessions']>[number];

export type BuildSessionReservation = BuildSessionRecord & {
  reservedCostUsd: number;
  endedAt?: never;
  costUsd?: never;
};

export type BuildSessionCompletion = BuildSessionRecord & {
  endedAt: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
};

export interface BuildSessionAccountingResult {
  applied: boolean;
  chargedCostUsd: number;
  reservedCostUsd: number;
  missionCostUsd: number;
}

export type BuildSessionReservationResult =
  | (BuildSessionAccountingResult & { status: 'reserved' })
  | (BuildSessionAccountingResult & { status: 'budget-exceeded'; applied: false; chargedCostUsd: 0 });

export interface BuildSessionFinalizationResult extends BuildSessionAccountingResult {
  /** Durable timestamp from the first committed completion, stable on replay. */
  endedAt: string;
}

function missionCost(data: Record<string, unknown>): number {
  const value = data.costUsd;
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Build mission has an invalid cumulative cost ledger');
  }
  return value;
}

function missionTokens(data: Record<string, unknown>): { input: number; output: number } {
  const raw = data.tokenUsage;
  if (raw === undefined) return { input: 0, output: 0 };
  if (!raw || typeof raw !== 'object') throw new Error('Build mission has an invalid token ledger');
  const input = (raw as { input?: unknown }).input;
  const output = (raw as { output?: unknown }).output;
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(output) ||
    output < 0
  ) {
    throw new Error('Build mission has an invalid token ledger');
  }
  return { input, output };
}

function missionSessions(data: Record<string, unknown>): BuildSessionRecord[] {
  const sessions = data.sessions;
  if (sessions === undefined) return [];
  if (!Array.isArray(sessions)) throw new Error('Build mission has an invalid session ledger');
  return sessions as BuildSessionRecord[];
}

function sameRecord(left: BuildSessionRecord, right: BuildSessionRecord): boolean {
  const leftEntries = Object.entries(left).filter(([, value]) => value !== undefined);
  const rightEntries = Object.entries(right).filter(([, value]) => value !== undefined);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]));
}

function sameCompletionReplay(left: BuildSessionRecord, right: BuildSessionRecord): boolean {
  const { endedAt: _leftEndedAt, ...leftStable } = left;
  const { endedAt: _rightEndedAt, ...rightStable } = right;
  return sameRecord(leftStable, rightStable);
}

export type PersistedBuildCostAccounting = BuildCostAccountingSnapshot & {
  observedAt: string;
};

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readPersistedBuildCostAccounting(value: unknown): PersistedBuildCostAccounting | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Build mission has invalid persisted build cost accounting');
  }
  const raw = value as Record<string, unknown>;
  const numericFields = [
    'settledActualUsd',
    'estimatedUsd',
    'activeReservedUsd',
    'unsettledMaximumUsd',
    'trackedSpendUsd',
    'maximumExposureUsd',
  ] as const;
  if (numericFields.some((field) => !isFiniteNonNegative(raw[field]))) {
    throw new Error('Build mission has invalid persisted build cost accounting');
  }
  if (!Number.isSafeInteger(raw.unavailableSessionCount) || (raw.unavailableSessionCount as number) < 0) {
    throw new Error('Build mission has invalid persisted build cost accounting');
  }
  if (
    !Array.isArray(raw.invalidSessionIndexes) ||
    raw.invalidSessionIndexes.some((index) => !Number.isSafeInteger(index) || (index as number) < 0) ||
    typeof raw.observedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.observedAt))
  ) {
    throw new Error('Build mission has invalid persisted build cost accounting');
  }

  const accounting = raw as unknown as PersistedBuildCostAccounting;
  const tracked = accounting.settledActualUsd + accounting.estimatedUsd;
  const exposure = tracked + accounting.activeReservedUsd + accounting.unsettledMaximumUsd;
  if (
    Math.abs(accounting.trackedSpendUsd - tracked) > Number.EPSILON ||
    Math.abs(accounting.maximumExposureUsd - exposure) > Number.EPSILON
  ) {
    throw new Error('Build mission has invalid persisted build cost accounting');
  }
  return accounting;
}

function sameAccounting(left: PersistedBuildCostAccounting, right: PersistedBuildCostAccounting): boolean {
  return (
    left.settledActualUsd === right.settledActualUsd &&
    left.estimatedUsd === right.estimatedUsd &&
    left.activeReservedUsd === right.activeReservedUsd &&
    left.unsettledMaximumUsd === right.unsettledMaximumUsd &&
    left.trackedSpendUsd === right.trackedSpendUsd &&
    left.maximumExposureUsd === right.maximumExposureUsd &&
    left.unavailableSessionCount === right.unavailableSessionCount &&
    left.invalidSessionIndexes.length === right.invalidSessionIndexes.length &&
    left.invalidSessionIndexes.every((index, position) => index === right.invalidSessionIndexes[position])
  );
}

/**
 * Derive the next persisted snapshot while retaining any pre-ledger exposure.
 * Historical cost that cannot be attributed to a session stays unavailable
 * and consumes authority; it is never guessed to be settled or reset to zero.
 */
function buildCostAccountingTransition(input: {
  data: Record<string, unknown>;
  currentSessions: BuildSessionRecord[];
  nextSessions: BuildSessionRecord[];
  terminal: boolean;
  observedAt: string;
}): { accounting: PersistedBuildCostAccounting; hadPersistedAccounting: boolean } {
  if (Number.isNaN(Date.parse(input.observedAt))) {
    throw new Error('Build cost accounting observation must be a valid timestamp');
  }
  const persisted = readPersistedBuildCostAccounting(input.data.buildCostAccounting);
  const current = deriveBuildCostAccounting(input.currentSessions, { terminal: false });
  const priorExposure = persisted?.maximumExposureUsd ?? missionCost(input.data);
  if (persisted && missionCost(input.data) !== persisted.maximumExposureUsd) {
    throw new Error('Build mission cost and persisted accounting exposure disagree');
  }
  if (priorExposure + Number.EPSILON < current.maximumExposureUsd) {
    throw new Error('Build session reservation is missing from the cumulative cost ledger');
  }
  const unattributedExposureUsd = Math.max(0, priorExposure - current.maximumExposureUsd);
  const next = deriveBuildCostAccounting(input.nextSessions, { terminal: input.terminal });
  const accounting: PersistedBuildCostAccounting = {
    ...next,
    unsettledMaximumUsd: next.unsettledMaximumUsd + unattributedExposureUsd,
    maximumExposureUsd: next.maximumExposureUsd + unattributedExposureUsd,
    unavailableSessionCount: next.unavailableSessionCount + (unattributedExposureUsd > 0 ? 1 : 0),
    observedAt: input.observedAt,
  };
  return { accounting, hadPersistedAccounting: persisted !== undefined };
}

/**
 * Durably reserve one session index and its full spend envelope before the
 * detached process starts. Identical retries are no-ops; reusing an index for
 * a different launch fails closed. The reservation is charged immediately so
 * a worker crash cannot make already-authorized paid work disappear.
 */
export async function reserveBuildSessionBudget(
  missionId: string,
  reservation: BuildSessionReservation,
  missionCapUsd: number
): Promise<BuildSessionReservationResult> {
  if (!Number.isFinite(reservation.reservedCostUsd) || reservation.reservedCostUsd <= 0) {
    throw new Error('Build session reservation must have a positive finite USD amount');
  }
  if (!Number.isFinite(missionCapUsd) || missionCapUsd <= 0) {
    throw new Error('Build session reservation must have a positive finite mission cap');
  }
  if (!Number.isSafeInteger(reservation.index) || reservation.index < 0) {
    throw new Error('Build session reservation has an invalid index');
  }

  const ref = db.collection(COLLECTION).doc(missionId);
  const observedAt = new Date().toISOString();
  return withDeadline(
    db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Mission ${missionId} not found`);
      const data = (snapshot.data() ?? {}) as Record<string, unknown>;
      const sessions = missionSessions(data);
      const sameIndex = sessions.filter((session) => session.index === reservation.index);
      if (sameIndex.length > 0) {
        if (sameIndex.length === 1 && sameRecord(sameIndex[0], reservation)) {
          const transition = buildCostAccountingTransition({
            data,
            currentSessions: sessions,
            nextSessions: sessions,
            terminal: false,
            observedAt,
          });
          const currentExposure = transition.accounting.maximumExposureUsd;
          if (currentExposure > missionCapUsd) {
            return {
              status: 'budget-exceeded',
              applied: false,
              chargedCostUsd: 0,
              reservedCostUsd: reservation.reservedCostUsd,
              missionCostUsd: currentExposure,
            };
          }
          if (!transition.hadPersistedAccounting) {
            transaction.update(ref, {
              buildCostAccounting: transition.accounting,
              costUsd: currentExposure,
            });
          }
          return {
            status: 'reserved',
            applied: false,
            chargedCostUsd: reservation.reservedCostUsd,
            reservedCostUsd: reservation.reservedCostUsd,
            missionCostUsd: currentExposure,
          };
        }
        throw new Error(`Build session index ${reservation.index} is already reserved with different data`);
      }

      const nextSessions = [...sessions, reservation];
      const { accounting } = buildCostAccountingTransition({
        data,
        currentSessions: sessions,
        nextSessions,
        terminal: false,
        observedAt,
      });
      if (accounting.maximumExposureUsd > missionCapUsd) {
        return {
          status: 'budget-exceeded',
          applied: false,
          chargedCostUsd: 0,
          reservedCostUsd: reservation.reservedCostUsd,
          missionCostUsd: accounting.maximumExposureUsd - reservation.reservedCostUsd,
        };
      }
      transaction.update(ref, {
        sessions: nextSessions,
        // Legacy readers still treat costUsd as authority consumed. User-facing
        // spend reads buildCostAccounting's disjoint buckets instead.
        costUsd: accounting.maximumExposureUsd,
        buildCostAccounting: accounting,
      });
      return {
        status: 'reserved',
        applied: true,
        chargedCostUsd: reservation.reservedCostUsd,
        reservedCostUsd: reservation.reservedCostUsd,
        missionCostUsd: accounting.maximumExposureUsd,
      };
    }),
    'reserveBuildSessionBudget.transaction'
  );
}

/**
 * Reconcile a reserved envelope with the authoritative result cost. A missing
 * or invalid result is represented by a completion whose cost equals the full
 * reserve and costEstimated=true. The completion and cumulative ledgers move
 * in one transaction, and an identical replay never charges cost/tokens twice.
 */
export async function finalizeBuildSessionAccounting(
  missionId: string,
  completion: BuildSessionCompletion,
  tokenUsage: { input: number; output: number }
): Promise<BuildSessionFinalizationResult> {
  if (!Number.isFinite(completion.costUsd) || completion.costUsd < 0) {
    throw new Error('Build session completion must have a non-negative finite USD amount');
  }
  if (
    !Number.isSafeInteger(tokenUsage.input) ||
    tokenUsage.input < 0 ||
    !Number.isSafeInteger(tokenUsage.output) ||
    tokenUsage.output < 0
  ) {
    throw new Error('Build session completion has invalid token usage');
  }

  const ref = db.collection(COLLECTION).doc(missionId);
  const observedAt = new Date().toISOString();
  return withDeadline(
    db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Mission ${missionId} not found`);
      const data = (snapshot.data() ?? {}) as Record<string, unknown>;
      const sessions = missionSessions(data);
      const reservations = sessions.filter(
        (session) => session.index === completion.index && session.endedAt === undefined
      );
      if (reservations.length !== 1) {
        throw new Error(`Build session ${completion.index} has no durable budget reservation`);
      }
      const reservation = reservations[0];
      if (
        typeof reservation.reservedCostUsd !== 'number' ||
        !Number.isFinite(reservation.reservedCostUsd) ||
        reservation.reservedCostUsd <= 0
      ) {
        throw new Error(`Build session ${completion.index} has an invalid durable budget reservation`);
      }
      if (
        reservation.role !== completion.role ||
        reservation.model !== completion.model ||
        reservation.startedAt !== completion.startedAt
      ) {
        throw new Error(`Build session ${completion.index} completion does not match its durable reservation`);
      }
      if (completion.costEstimated && completion.costUsd !== reservation.reservedCostUsd) {
        throw new Error(
          `Build session ${completion.index} estimated completion must retain its full budget reservation`
        );
      }

      const recordedCompletion: BuildSessionCompletion = {
        ...completion,
        inputTokens: tokenUsage.input,
        outputTokens: tokenUsage.output,
      };
      const existingCompletions = sessions.filter(
        (session) => session.index === completion.index && session.endedAt !== undefined
      );
      if (existingCompletions.length > 0) {
        if (existingCompletions.length === 1 && sameCompletionReplay(existingCompletions[0], recordedCompletion)) {
          const { accounting } = buildCostAccountingTransition({
            data,
            currentSessions: sessions,
            nextSessions: sessions,
            terminal: false,
            observedAt,
          });
          return {
            applied: false,
            chargedCostUsd: completion.costUsd,
            reservedCostUsd: reservation.reservedCostUsd,
            missionCostUsd: accounting.maximumExposureUsd,
            endedAt: existingCompletions[0].endedAt!,
          };
        }
        throw new Error(`Build session ${completion.index} is already finalized with different data`);
      }

      const currentTokens = missionTokens(data);
      const nextSessions = [...sessions, recordedCompletion];
      const { accounting } = buildCostAccountingTransition({
        data,
        currentSessions: sessions,
        nextSessions,
        terminal: false,
        observedAt,
      });
      transaction.update(ref, {
        sessions: nextSessions,
        costUsd: accounting.maximumExposureUsd,
        buildCostAccounting: accounting,
        tokenUsage: {
          input: currentTokens.input + tokenUsage.input,
          output: currentTokens.output + tokenUsage.output,
        },
      });
      return {
        applied: true,
        chargedCostUsd: completion.costUsd,
        reservedCostUsd: reservation.reservedCostUsd,
        missionCostUsd: accounting.maximumExposureUsd,
        endedAt: recordedCompletion.endedAt,
      };
    }),
    'finalizeBuildSessionAccounting.transaction'
  );
}

export interface BuildCostReconciliationResult {
  applied: boolean;
  accounting: PersistedBuildCostAccounting;
}

/**
 * Explicitly reconcile active versus terminal reservation state. Callers must
 * name the state transition; this boundary never guesses from mission.status.
 * Identical terminal/cancel/crash replays keep the first observation timestamp.
 */
export async function reconcileBuildMissionCostAccounting(
  missionId: string,
  input: { state: 'active' | 'terminal'; observedAt?: string }
): Promise<BuildCostReconciliationResult> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const ref = db.collection(COLLECTION).doc(missionId);
  return withDeadline(
    db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error(`Mission ${missionId} not found`);
      const data = (snapshot.data() ?? {}) as Record<string, unknown>;
      const sessions = missionSessions(data);
      const persisted = readPersistedBuildCostAccounting(data.buildCostAccounting);
      const { accounting } = buildCostAccountingTransition({
        data,
        currentSessions: sessions,
        nextSessions: sessions,
        terminal: input.state === 'terminal',
        observedAt,
      });
      if (persisted && sameAccounting(persisted, accounting)) {
        return { applied: false, accounting: persisted };
      }
      transaction.update(ref, {
        buildCostAccounting: accounting,
        costUsd: accounting.maximumExposureUsd,
      });
      return { applied: true, accounting };
    }),
    'reconcileBuildMissionCostAccounting.transaction'
  );
}

/** Append a human-gate record to a build mission (atomic arrayUnion). */
export async function appendBuildGate(missionId: string, gate: NonNullable<Mission['gates']>[number]): Promise<void> {
  const { FieldValue } = await import('firebase-admin/firestore');
  await withDeadline(
    db
      .collection(COLLECTION)
      .doc(missionId)
      .update({ gates: FieldValue.arrayUnion(gate) }),
    'appendBuildGate.update'
  );
}

export async function appendSkillInvocation(
  missionId: string,
  invocation: { skill: string; args?: string; firedAt: string; turn?: number }
): Promise<void> {
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    // Firestore rejects undefined anywhere inside an arrayUnion element.
    // Skill(...) permits omitted args, so normalize the receipt at the one
    // persistence boundary even when an older caller includes args: undefined.
    const cleanInvocation = sanitizeForFirestore(invocation);
    await withDeadline(
      db
        .collection(COLLECTION)
        .doc(missionId)
        .update({ skillInvocations: FieldValue.arrayUnion(cleanInvocation) }),
      'appendSkillInvocation.update'
    );
  } catch (error) {
    log.warn('appendSkillInvocation failed', {
      missionId,
      skill: invocation.skill,
      error: error instanceof Error ? error.message : String(error),
    });
    // Never throw — skill telemetry is non-critical
  }
}
