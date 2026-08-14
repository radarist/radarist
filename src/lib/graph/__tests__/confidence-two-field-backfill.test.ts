/**
 * @file confidence-two-field-backfill.test.ts
 * @description Mocked unit tests for the B0 two-field confidence backfill
 * migration ('2026-07-05-confidence-two-field-backfill'). Copies the legacy
 * confidence value into assertedConfidence/effectiveConfidence wherever
 * either is absent (idempotent — copy-where-absent, never clobber).
 *
 * Real-Neo4j proof (idempotent re-run + reader-visibility law) lives in
 * confidence-reader-visibility.integration.test.ts.
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

import * as neo4j from '../neo4j-client';
import { MIGRATIONS, MANUAL_MIGRATIONS } from '../schema-migrations';

const mockedRead = neo4j.runReadTransaction as jest.Mock;
const mockedWrite = neo4j.runWriteTransaction as jest.Mock;

const BACKFILL_NAME = '2026-07-05-confidence-two-field-backfill';

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

function getBackfillMigration() {
  const m = MIGRATIONS.find((x) => x.name === BACKFILL_NAME);
  if (!m) throw new Error('backfill migration not registered');
  return m;
}

describe('confidence-two-field-backfill — registration', () => {
  it('registers in MIGRATIONS (auto-appliable) — this is idempotent cleanup, not a one-way door', () => {
    expect(MIGRATIONS.find((m) => m.name === BACKFILL_NAME)).toBeDefined();
  });

  it('is NOT registered in MANUAL_MIGRATIONS', () => {
    expect(MANUAL_MIGRATIONS.find((m) => m.name === BACKFILL_NAME)).toBeUndefined();
  });
});

describe('confidence-two-field-backfill — apply()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('copies confidence into assertedConfidence/effectiveConfidence where absent for edges, then Assertion nodes, then verifies', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([{ n: 4 }])) // copy-edges-where-absent
      .mockResolvedValueOnce(records([{ n: 2 }])); // copy-assertions-where-absent
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }])); // verify: 0 residual rows

    const passes = await getBackfillMigration().apply();

    const passNames = passes.map((p) => p.pass);
    expect(passNames).toEqual(['copy-edges-where-absent', 'copy-assertions-where-absent', 'verify-zero-residual']);
    expect(passes[0].updatedOrDeleted).toBe(4);
    expect(passes[1].updatedOrDeleted).toBe(2);
    expect(passes[2].updatedOrDeleted).toBe(0);
  });

  it('copy-edges-where-absent guards on confidence set but either field missing, coalesces both fields', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }])).mockResolvedValueOnce(records([{ n: 0 }]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getBackfillMigration().apply();

    const [cypher] = mockedWrite.mock.calls[0];
    expect(cypher).toContain('r.confidence IS NOT NULL');
    expect(cypher).toContain('r.effectiveConfidence IS NULL OR r.assertedConfidence IS NULL');
    expect(cypher).toContain('r.assertedConfidence = coalesce(r.assertedConfidence, r.confidence)');
    expect(cypher).toContain('r.effectiveConfidence = coalesce(r.effectiveConfidence, r.confidence)');
  });

  it('copy-assertions-where-absent targets (c:Assertion) with the same copy-where-absent guard', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }])).mockResolvedValueOnce(records([{ n: 0 }]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getBackfillMigration().apply();

    const [cypher] = mockedWrite.mock.calls[1];
    expect(cypher).toContain('(c:Assertion)');
    expect(cypher).toContain('c.confidence IS NOT NULL');
    expect(cypher).toContain('c.effectiveConfidence IS NULL OR c.assertedConfidence IS NULL');
    expect(cypher).toContain('c.assertedConfidence = coalesce(c.assertedConfidence, c.confidence)');
    expect(cypher).toContain('c.effectiveConfidence = coalesce(c.effectiveConfidence, c.confidence)');
  });

  it('throws when the verify pass finds residual rows (confidence set but effectiveConfidence still missing)', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }])).mockResolvedValueOnce(records([{ n: 0 }]));
    mockedRead.mockResolvedValueOnce(records([{ n: 3 }])); // 3 residual rows — bug

    await expect(getBackfillMigration().apply()).rejects.toThrow(/residual/i);
  });

  it('is idempotent: re-running after a clean apply copies 0 additional rows', async () => {
    mockedWrite.mockResolvedValueOnce(records([{ n: 0 }])).mockResolvedValueOnce(records([{ n: 0 }]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    const passes = await getBackfillMigration().apply();

    expect(passes[0].updatedOrDeleted).toBe(0);
    expect(passes[1].updatedOrDeleted).toBe(0);
  });
});
