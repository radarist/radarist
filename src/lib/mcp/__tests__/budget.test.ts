/**
 * @file mcp/__tests__/budget.test.ts
 * @description Lane A hard-gate suite for the durable per-API-key request budget.
 *
 * The HARD GATE is the concurrent-increment race test: firing many overlapping
 * `checkAndConsume` calls near the daily limit must never double-spend (never
 * allow more units than the limit). The Firestore admin mock below models
 * Firestore's serializable-transaction isolation (transactions run one at a
 * time against a shared in-memory store), so the test exercises the production
 * deny-before-spend logic rather than the mock.
 */

/**
 * Shared mutable state for the admin-SDK mock. Named with the `mock` prefix so
 * it can be referenced inside the hoisted `jest.mock` factories.
 */
const mockState: {
  store: Map<string, Record<string, unknown>>;
  chain: Promise<void>;
  failNextTransaction: boolean;
  getCalls: number;
} = {
  store: new Map(),
  chain: Promise.resolve(),
  failNextTransaction: false,
  getCalls: 0,
};

jest.mock('firebase-admin/firestore', () => ({
  // Sentinel-based increment so the mock `set` can resolve it like Firestore.
  FieldValue: { increment: (n: number) => ({ __op: 'increment', n }) },
  Timestamp: { fromMillis: (ms: number) => ({ __ts: ms }) },
}));

jest.mock('@/lib/firebase-admin', () => {
  const makeRef = (id: string) => ({
    id,
    _get: () => {
      const data = mockState.store.get(id);
      return { exists: data !== undefined, data: () => data };
    },
    _set: (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      const existing = mockState.store.get(id) ?? {};
      const merged: Record<string, unknown> = options?.merge ? { ...existing } : {};
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && (v as { __op?: string }).__op === 'increment') {
          const base = typeof existing[k] === 'number' ? (existing[k] as number) : 0;
          merged[k] = base + (v as { n: number }).n;
        } else {
          merged[k] = v;
        }
      }
      mockState.store.set(id, merged);
    },
  });

  const db = {
    collection: () => ({ doc: (id: string) => makeRef(id) }),
    // Models Firestore serializable isolation: transactions are run one at a
    // time against the shared store via a promise chain (a mutex).
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      let release!: () => void;
      const prev = mockState.chain;
      mockState.chain = new Promise<void>((res) => {
        release = res;
      });
      await prev;
      try {
        if (mockState.failNextTransaction) {
          mockState.failNextTransaction = false;
          throw new Error('simulated firestore failure');
        }
        const tx = {
          get: async (ref: { _get: () => unknown }) => {
            mockState.getCalls += 1;
            return ref._get();
          },
          set: (
            ref: { _set: (d: Record<string, unknown>, o?: { merge?: boolean }) => void },
            data: Record<string, unknown>,
            options?: { merge?: boolean }
          ) => ref._set(data, options),
        };
        return await fn(tx as unknown as Parameters<typeof fn>[0]);
      } finally {
        release();
      }
    },
  };

  return { db };
});

import { checkAndConsume } from '../budget';

const DOC = (keyId: string, date: string) => `${keyId}_${date}`;

describe('mcp/budget · checkAndConsume', () => {
  beforeEach(() => {
    mockState.store.clear();
    mockState.chain = Promise.resolve();
    mockState.failNextTransaction = false;
    mockState.getCalls = 0;
    process.env.MCP_DAILY_READ_BUDGET = '10';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-26T10:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── HARD GATE ──────────────────────────────────────────────────────────────
  it('HARD GATE: concurrent increments never double-spend (deny before spend)', async () => {
    // Limit is 10. Fire 25 overlapping single-unit consumes for the same key.
    const attempts = await Promise.all(Array.from({ length: 25 }, () => checkAndConsume('key-race', 1)));

    const allowed = attempts.filter((r) => r.allowed);
    const denied = attempts.filter((r) => !r.allowed);

    // Exactly the limit may be allowed — never more (no double-spend).
    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(15);

    // The durable counter reflects exactly the limit, never above it.
    const stored = mockState.store.get(DOC('key-race', '2026-06-26'));
    expect(stored?.count).toBe(10);

    // Every denial reports zero remaining once the budget is exhausted.
    for (const d of denied) {
      expect(d.remaining).toBe(0);
    }
    // The transaction was actually used (atomic read-modify-write).
    expect(mockState.getCalls).toBeGreaterThanOrEqual(25);
  });

  // ── over-limit denies ───────────────────────────────────────────────────────
  it('denies before spend when a single request exceeds remaining budget', async () => {
    const first = await checkAndConsume('key-over', 8); // 8/10
    expect(first).toEqual({ allowed: true, remaining: 2 });

    const second = await checkAndConsume('key-over', 5); // would be 13 > 10 → deny
    expect(second).toEqual({ allowed: false, remaining: 2 });

    // No spend occurred on the denied call — counter stays at 8.
    const stored = mockState.store.get(DOC('key-over', '2026-06-26'));
    expect(stored?.count).toBe(8);
  });

  it('allows a request that exactly reaches the limit, then denies the next', async () => {
    expect(await checkAndConsume('key-edge', 10)).toEqual({ allowed: true, remaining: 0 });
    expect(await checkAndConsume('key-edge', 1)).toEqual({ allowed: false, remaining: 0 });
  });

  // ── reset-window rollover ────────────────────────────────────────────────────
  it('resets the budget on UTC-day rollover (new doc id, fresh count)', async () => {
    // Exhaust day 1.
    expect(await checkAndConsume('key-day', 10)).toEqual({ allowed: true, remaining: 0 });
    expect(await checkAndConsume('key-day', 1)).toEqual({ allowed: false, remaining: 0 });

    // Cross into the next UTC day.
    jest.setSystemTime(new Date('2026-06-27T00:00:01.000Z'));

    const nextDay = await checkAndConsume('key-day', 3);
    expect(nextDay).toEqual({ allowed: true, remaining: 7 });

    // Distinct durable documents — yesterday's count is preserved (never deleted).
    expect(mockState.store.get(DOC('key-day', '2026-06-26'))?.count).toBe(10);
    expect(mockState.store.get(DOC('key-day', '2026-06-27'))?.count).toBe(3);
  });

  // ── per-key isolation ────────────────────────────────────────────────────────
  it('tracks budget independently per apiKeyId', async () => {
    await checkAndConsume('key-a', 10); // exhaust key-a
    const aDenied = await checkAndConsume('key-a', 1);
    const bAllowed = await checkAndConsume('key-b', 4);

    expect(aDenied.allowed).toBe(false);
    expect(bAllowed).toEqual({ allowed: true, remaining: 6 });
  });

  // ── env-configured limit ─────────────────────────────────────────────────────
  it('honours the MCP_DAILY_READ_BUDGET env limit', async () => {
    process.env.MCP_DAILY_READ_BUDGET = '3';
    expect(await checkAndConsume('key-env', 3)).toEqual({ allowed: true, remaining: 0 });
    expect(await checkAndConsume('key-env', 1)).toEqual({ allowed: false, remaining: 0 });
  });

  // ── input validation ─────────────────────────────────────────────────────────
  it('rejects an empty apiKeyId', async () => {
    await expect(checkAndConsume('', 1)).rejects.toThrow(/apiKeyId/);
  });

  it.each([0, -1, 1.5, NaN])('rejects a non-positive-integer n (%p)', async (n) => {
    await expect(checkAndConsume('key-bad', n as number)).rejects.toThrow(/positive integer/);
  });

  // ── error propagation ────────────────────────────────────────────────────────
  it('propagates a Firestore transaction failure', async () => {
    mockState.failNextTransaction = true;
    await expect(checkAndConsume('key-err', 1)).rejects.toThrow(/simulated firestore failure/);
  });
});
