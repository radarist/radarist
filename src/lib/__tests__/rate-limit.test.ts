/**
 * @file rate-limit.test.ts
 * @description Unit tests for the in-process token-bucket rate limiter.
 *
 * Pins the contract used by Option A's engagement endpoints (A.1):
 *   - bucket capacity = `limit`
 *   - refill rate = limit / windowMs tokens per ms
 *   - first call after a fresh bucket consumes exactly one token
 *   - exhaustion returns `allowed: false` with a non-zero `retryAfterMs`
 *   - waiting `windowMs` fully refills the bucket
 */

import { consumeRateLimitToken, __resetRateLimitForTests } from '../rate-limit';

describe('consumeRateLimitToken', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns allowed=true with remaining=limit-1 on the first call', () => {
    const result = consumeRateLimitToken('test:user-1', { limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.remaining).toBe(4);
    }
  });

  it('exhausts the bucket after `limit` calls in the same instant', () => {
    const limit = 3;
    const opts = { limit, windowMs: 60_000 };
    for (let i = 0; i < limit; i++) {
      const r = consumeRateLimitToken('test:user-2', opts);
      expect(r.allowed).toBe(true);
    }
    const exhausted = consumeRateLimitToken('test:user-2', opts);
    expect(exhausted.allowed).toBe(false);
    if (!exhausted.allowed) {
      // retryAfterMs ≈ windowMs / limit = 20_000ms for a 3-per-60s budget
      expect(exhausted.retryAfterMs).toBeGreaterThan(0);
      expect(exhausted.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('refills proportionally over time — half the window restores half the budget', () => {
    const opts = { limit: 10, windowMs: 60_000 };
    // Drain the bucket.
    for (let i = 0; i < 10; i++) consumeRateLimitToken('test:user-3', opts);
    expect(consumeRateLimitToken('test:user-3', opts).allowed).toBe(false);

    // Advance half the window — expect ~5 tokens refilled.
    jest.advanceTimersByTime(30_000);

    let allowedCount = 0;
    for (let i = 0; i < 6; i++) {
      if (consumeRateLimitToken('test:user-3', opts).allowed) allowedCount++;
    }
    expect(allowedCount).toBe(5);
  });

  it('isolates buckets by key — one user does not affect another', () => {
    const opts = { limit: 2, windowMs: 60_000 };
    expect(consumeRateLimitToken('a', opts).allowed).toBe(true);
    expect(consumeRateLimitToken('a', opts).allowed).toBe(true);
    expect(consumeRateLimitToken('a', opts).allowed).toBe(false);
    // Different key starts with a full bucket.
    expect(consumeRateLimitToken('b', opts).allowed).toBe(true);
  });

  it('treats a non-positive limit as unlimited (defensive — never break the route)', () => {
    const result = consumeRateLimitToken('test:zero', { limit: 0, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.remaining).toBe(Number.POSITIVE_INFINITY);
    }
  });
});
