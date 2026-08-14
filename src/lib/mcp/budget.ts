/**
 * @file mcp/budget.ts
 * @description Durable per-API-key request budget (L1 Judgment Envelope).
 *
 * Wave 0 STUB. Lane A implements an atomic, durable, per-`apiKeyId`,
 * per-UTC-day counter backed by Firestore admin `FieldValue.increment`
 * (pattern: `concept-admin.ts:402`), collection `apiKeyUsage/{apiKeyId}_{utcDate}`.
 * `checkAndConsume` MUST deny BEFORE spend (no double-spend under concurrency)
 * and MUST NOT be an in-memory singleton (resets per serverless invocation).
 *
 * @author Radarist Team
 * @created 2026-06-26
 */

import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('mcp-budget');

/** Firestore collection holding per-key, per-UTC-day usage counters. */
const USAGE_COLLECTION = 'apiKeyUsage';

/**
 * Fallback daily read budget when `MCP_DAILY_READ_BUDGET` is unset or invalid.
 * Generous enough for a demo MCP client; the env var is the real control.
 */
const DEFAULT_DAILY_LIMIT = 1000;

/** Result of a budget check-and-consume attempt. */
export interface BudgetResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Resolve the per-key daily limit from `MCP_DAILY_READ_BUDGET`, falling back to
 * {@link DEFAULT_DAILY_LIMIT} when unset or not a positive integer.
 */
function resolveDailyLimit(): number {
  const raw = process.env.MCP_DAILY_READ_BUDGET;
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT;
}

/**
 * UTC calendar-day string (`YYYY-MM-DD`) used as part of the counter doc id.
 * Crossing midnight UTC routes writes to a fresh document, which resets the
 * window without any cron — and preserves prior days' counters (never-delete).
 */
function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomically reserve `n` units of budget for `apiKeyId` within the current
 * UTC-day window. Returns `{ allowed: false, remaining }` when the spend would
 * exceed the limit, **without consuming any budget** (deny-before-spend).
 *
 * Durability + atomicity come from a Firestore admin transaction over
 * `apiKeyUsage/{apiKeyId}_{utcDate}` (read-modify-write with `FieldValue.increment`,
 * pattern: `concept-admin.ts:402`). Firestore's serializable transactions retry
 * on contention, so overlapping calls cannot double-spend. This is intentionally
 * NOT an in-memory counter — those reset on every serverless cold start.
 *
 * @param apiKeyId - The API key whose budget to charge.
 * @param n - Number of units to consume (must be a positive integer).
 * @returns `{ allowed, remaining }` for the current UTC-day window.
 * @throws {Error} when `apiKeyId` is empty or `n` is not a positive integer.
 */
export async function checkAndConsume(apiKeyId: string, n: number): Promise<BudgetResult> {
  if (!apiKeyId) {
    throw new Error('checkAndConsume requires a non-empty apiKeyId');
  }
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('checkAndConsume requires a positive integer n');
  }

  const limit = resolveDailyLimit();
  const date = utcDateString(new Date());
  const docId = `${apiKeyId}_${date}`;
  const ref = db.collection(USAGE_COLLECTION).doc(docId);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : undefined;
      const current = typeof data?.count === 'number' ? data.count : 0;

      // Deny BEFORE spend: the write only happens when it fits within the limit.
      if (current + n > limit) {
        return { allowed: false, remaining: Math.max(0, limit - current) };
      }

      tx.set(
        ref,
        {
          apiKeyId,
          utcDate: date,
          count: FieldValue.increment(n),
          updatedAt: Timestamp.fromMillis(Date.now()),
        },
        { merge: true }
      );

      return { allowed: true, remaining: limit - (current + n) };
    });
  } catch (error) {
    log.error('checkAndConsume failed', error instanceof Error ? error : new Error(String(error)), {
      apiKeyId,
      n,
      date,
    });
    throw error;
  }
}
