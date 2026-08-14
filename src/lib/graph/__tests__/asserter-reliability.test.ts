/**
 * @file asserter-reliability.test.ts
 * @description Unit tests for the per-asserter reliability store (Increment 2,
 * patent improvement #3). `:AsserterReliability` accrues approve/reject
 * outcomes per `assertedBy` key; `computeReliabilityBonus` is a PURE decayed
 * scoring function; `getAsserterReliability` is the read-side that composes
 * the two and never throws (missing node or read failure both resolve to
 * zeros — this module must never be the reason a sync call fails).
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import * as neo4j from '../neo4j-client';
import { recordAsserterOutcome, computeReliabilityBonus, getAsserterReliability } from '../asserter-reliability';

const mockedWrite = neo4j.runWriteTransaction as jest.Mock;
const mockedRead = neo4j.runReadTransaction as jest.Mock;

const writeResult = (records: Record<string, unknown>[]) => ({
  records,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

beforeEach(() => jest.clearAllMocks());

// ============================================================================
// computeReliabilityBonus — PURE
// ============================================================================

describe('computeReliabilityBonus', () => {
  it('returns 0 when fewer than 5 outcomes have accrued', () => {
    expect(computeReliabilityBonus(2, 1)).toBe(0); // n=3
    expect(computeReliabilityBonus(4, 0)).toBe(0); // n=4
    expect(computeReliabilityBonus(0, 0)).toBe(0); // n=0
  });

  it('clamps to +10 at a 100% approval rate (n>=5)', () => {
    expect(computeReliabilityBonus(5, 0)).toBe(10);
  });

  it('clamps to -10 at a 0% approval rate (n>=5)', () => {
    expect(computeReliabilityBonus(0, 5)).toBe(-10);
  });

  it('produces +5 at a 75% approval rate', () => {
    // rate=0.75 -> raw = 20 * (0.75 - 0.5) = 5
    expect(computeReliabilityBonus(15, 5)).toBe(5);
  });

  it('produces 0 at exactly a 50% approval rate', () => {
    expect(computeReliabilityBonus(5, 5)).toBe(0);
  });

  it('halves the bonus at exactly one half-life (default 30 days)', () => {
    const now = Date.parse('2026-08-01T00:00:00Z');
    const updatedAt = now - 30 * 24 * 60 * 60 * 1000;
    // raw bonus at 100% approval is +10; one half-life -> +5
    expect(computeReliabilityBonus(5, 0, { now, updatedAt })).toBe(5);
  });

  it('decays fully away after many half-lives', () => {
    const now = Date.parse('2026-08-01T00:00:00Z');
    const updatedAt = now - 365 * 24 * 60 * 60 * 1000; // ~12 half-lives
    expect(computeReliabilityBonus(5, 0, { now, updatedAt })).toBe(0);
  });

  it('applies no decay when updatedAt is omitted (fresh read)', () => {
    expect(computeReliabilityBonus(5, 0, { now: Date.now() })).toBe(10);
  });

  it('honors a custom halfLifeDays', () => {
    const now = Date.parse('2026-08-01T00:00:00Z');
    const updatedAt = now - 10 * 24 * 60 * 60 * 1000;
    expect(computeReliabilityBonus(5, 0, { now, updatedAt, halfLifeDays: 10 })).toBe(5);
  });

  it('rounds the half-integer decay boundary up (60d = two half-lives: raw 2.5 → 3)', () => {
    const now = Date.parse('2026-08-01T00:00:00Z');
    const updatedAt = now - 60 * 24 * 60 * 60 * 1000;
    // raw bonus at 100% approval is +10; two half-lives: 10 * 0.5^2 = 2.5 → Math.round = 3
    expect(computeReliabilityBonus(5, 0, { now, updatedAt })).toBe(3);
  });
});

// ============================================================================
// recordAsserterOutcome — WRITE
// ============================================================================

describe('recordAsserterOutcome', () => {
  it('MERGEs on the asserter key and increments only approvedCount on an approve', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{}]));

    await recordAsserterOutcome('agent:linker', 'approved');

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('MERGE (r:AsserterReliability {asserter: $assertedBy})');
    expect(cypher).toContain('approvedCount');
    expect(params.assertedBy).toBe('agent:linker');
    expect(params.outcome).toBe('approved');
  });

  it('increments only rejectedCount on a reject', async () => {
    mockedWrite.mockResolvedValueOnce(writeResult([{}]));

    await recordAsserterOutcome('agent:auto-linker', 'rejected');

    const [, params] = mockedWrite.mock.calls[0];
    expect(params.assertedBy).toBe('agent:auto-linker');
    expect(params.outcome).toBe('rejected');
  });
});

// ============================================================================
// getAsserterReliability — READ (never throws)
// ============================================================================

describe('getAsserterReliability', () => {
  it('returns zeros (bonus 0) when no AsserterReliability node exists yet', async () => {
    mockedRead.mockResolvedValueOnce(writeResult([]));

    const result = await getAsserterReliability('agent:linker');

    expect(result).toEqual({ approvedCount: 0, rejectedCount: 0, reliabilityBonus: 0 });
  });

  it('computes the bonus from the stored counts and updatedAt', async () => {
    mockedRead.mockResolvedValueOnce(writeResult([{ approvedCount: 5, rejectedCount: 0, updatedAt: Date.now() }]));

    const result = await getAsserterReliability('agent:linker');

    expect(result.approvedCount).toBe(5);
    expect(result.rejectedCount).toBe(0);
    expect(result.reliabilityBonus).toBe(10);
  });

  it('never throws — a read failure resolves to zeros', async () => {
    mockedRead.mockRejectedValueOnce(new Error('neo4j unavailable'));

    const result = await getAsserterReliability('agent:linker');

    expect(result).toEqual({ approvedCount: 0, rejectedCount: 0, reliabilityBonus: 0 });
  });
});
