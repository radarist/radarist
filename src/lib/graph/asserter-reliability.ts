/**
 * @file graph/asserter-reliability.ts
 * @description Per-asserter reliability store (Increment 2, patent
 * improvement #3 — the last learning-loop writer). Distinct asserter
 * identities (`agent:linker` / `agent:auto-linker` / `agent:assistant`, per
 * B1) accrue approve/reject outcomes from the relations triage route onto a
 * `:AsserterReliability` node keyed by `assertedBy`. A decayed bonus (±10,
 * half-life 30 days) derived from that history can shift the 75-point
 * materialization gate in `shouldMaterializeAssertion` — an asserter with a
 * consistently strong approval track record clears the gate a little sooner;
 * a consistently rejected one needs a little more confidence to clear it.
 *
 * Flag-gated OFF by default (`ASSERTER_RELIABILITY_ENABLED`, resolved in
 * `relation-assertion-sync.ts`) — byte-identical baseline when off. This
 * module itself has no flag awareness; it is pure read/write plumbing.
 *
 * `getAsserterReliability` never throws: a missing node (asserter never
 * scored) or a Neo4j read failure both resolve to zeros/bonus-0 so a failure
 * here can never turn a successful sync into a broken one.
 */
import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';
import { MAX_MACHINE_RELIABILITY_ADJUSTMENT } from './materialization-policy';

const log = createLogger('graph/asserter-reliability');

const MIN_OUTCOMES_FOR_SIGNAL = 5;
const DEFAULT_HALF_LIFE_DAYS = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Records a single approve/reject outcome for an asserter. MERGEs on the
 * `asserter` key (e.g. `agent:linker`) so repeated calls accrue onto the same
 * node; ON CREATE seeds both counters at 0 before incrementing the matching
 * one so a first-ever outcome for a brand-new asserter still lands correctly.
 */
export async function recordAsserterOutcome(assertedBy: string, outcome: 'approved' | 'rejected'): Promise<void> {
  const now = Date.now();
  const cypher = `
    MERGE (r:AsserterReliability {asserter: $assertedBy})
    ON CREATE SET
      r.approvedCount = 0,
      r.rejectedCount = 0,
      r.createdAt = $now
    SET
      r.approvedCount = CASE WHEN $outcome = 'approved' THEN coalesce(r.approvedCount, 0) + 1 ELSE coalesce(r.approvedCount, 0) END,
      r.rejectedCount = CASE WHEN $outcome = 'rejected' THEN coalesce(r.rejectedCount, 0) + 1 ELSE coalesce(r.rejectedCount, 0) END,
      r.updatedAt = $now
    RETURN r
  `;

  await runWriteTransaction(cypher, { assertedBy, outcome, now });
  log.info('Asserter outcome recorded', { assertedBy, outcome });
}

/**
 * PURE decayed-bonus derivation. No fewer than `MIN_OUTCOMES_FOR_SIGNAL`
 * (5) outcomes -> 0 (not enough signal to trust yet). Otherwise the raw bonus
 * is the approval rate centered on 50% and scaled so a perfect/zero record
 * hits ±10: `clamp(20 * (approved/n - 0.5), -10, +10)`. The raw bonus then
 * decays toward 0 with a half-life (default 30 days) measured from the
 * asserter's last recorded outcome — a track record that hasn't been
 * reinforced recently carries less weight than a freshly-confirmed one.
 */
export function computeReliabilityBonus(
  approved: number,
  rejected: number,
  opts?: { updatedAt?: number; now?: number; halfLifeDays?: number }
): number {
  const n = approved + rejected;
  if (n < MIN_OUTCOMES_FOR_SIGNAL) return 0;

  const rate = approved / n;
  const raw = clamp(
    MAX_MACHINE_RELIABILITY_ADJUSTMENT * 2 * (rate - 0.5),
    -MAX_MACHINE_RELIABILITY_ADJUSTMENT,
    MAX_MACHINE_RELIABILITY_ADJUSTMENT
  );

  const now = opts?.now ?? Date.now();
  const updatedAt = opts?.updatedAt ?? now;
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const ageMs = Math.max(0, now - updatedAt);
  const decay = halfLifeMs > 0 ? Math.pow(0.5, ageMs / halfLifeMs) : 1;

  return Math.round(raw * decay);
}

/**
 * Reads an asserter's current reliability, deriving the decayed bonus from
 * whatever is stored. Never throws — a missing node (never scored) or a
 * Neo4j read failure both resolve to zeros with bonus 0, so a caller can
 * unconditionally trust the return shape.
 */
export async function getAsserterReliability(assertedBy: string): Promise<{
  approvedCount: number;
  rejectedCount: number;
  reliabilityBonus: number;
}> {
  const zeros = { approvedCount: 0, rejectedCount: 0, reliabilityBonus: 0 };

  try {
    const cypher = `
      MATCH (r:AsserterReliability {asserter: $assertedBy})
      RETURN r.approvedCount AS approvedCount, r.rejectedCount AS rejectedCount, r.updatedAt AS updatedAt
    `;
    const result = await runReadTransaction<{
      approvedCount: number | null;
      rejectedCount: number | null;
      updatedAt: number | null;
    }>(cypher, { assertedBy });

    const record = result.records[0];
    if (!record) return zeros;

    const approvedCount = record.approvedCount ?? 0;
    const rejectedCount = record.rejectedCount ?? 0;
    const reliabilityBonus = computeReliabilityBonus(approvedCount, rejectedCount, {
      updatedAt: record.updatedAt ?? undefined,
    });

    return { approvedCount, rejectedCount, reliabilityBonus };
  } catch (err) {
    log.warn('getAsserterReliability failed — falling back to zeros', {
      assertedBy,
      error: err instanceof Error ? err.message : String(err),
    });
    return zeros;
  }
}
