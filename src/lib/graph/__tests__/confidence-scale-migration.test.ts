/**
 * @file confidence-scale-migration.test.ts
 * @description Mocked unit tests for the 2026-07-05-confidence-scale-0-100
 * forward migration + its MANUAL-only rollback (Task 16 / A1).
 *
 * Real-Neo4j proof lives in confidence-scale-migration.integration.test.ts —
 * this file pins registration, pass order, per-pass Cypher guards, and the
 * TS-side verify-pass invariants (I1 conservation, I2 no residual open-(0,1)
 * edges, I3 precise VISIBLE@60 growth) against a fully mocked driver.
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

const FORWARD_NAME = '2026-07-05-confidence-scale-0-100';
const ROLLBACK_NAME = '2026-07-05-confidence-scale-0-100-rollback';

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

function baseCensusRow(overrides: Partial<Record<string, number>> = {}) {
  return {
    bucketNull: 0,
    bucketOpen01: 2,
    bucketExactly1: 3,
    bucket1To100: 10,
    bucketOther: 0,
    visibleAt60: 8,
    healCohortBecomingVisible: 1,
    total: 15,
    ...overrides,
  };
}

function healedCensusRow(overrides: Partial<Record<string, number>> = {}) {
  // After a clean heal: bucketOpen01 -> 0, total unchanged, visibleAt60 grew
  // by exactly the healCohortBecomingVisible from the "before" row (1).
  return {
    bucketNull: 0,
    bucketOpen01: 0,
    bucketExactly1: 3,
    bucket1To100: 12,
    bucketOther: 0,
    visibleAt60: 9,
    healCohortBecomingVisible: 0,
    total: 15,
    ...overrides,
  };
}

function getForwardMigration() {
  const m = MIGRATIONS.find((x) => x.name === FORWARD_NAME);
  if (!m) throw new Error('forward migration not registered');
  return m;
}

function getRollbackMigration() {
  const m = MANUAL_MIGRATIONS.find((x) => x.name === ROLLBACK_NAME);
  if (!m) throw new Error('rollback migration not registered');
  return m;
}

describe('confidence-scale-migration — registration (Task 16 A1)', () => {
  it('registers the forward migration in MIGRATIONS (auto-appliable)', () => {
    expect(MIGRATIONS.find((m) => m.name === FORWARD_NAME)).toBeDefined();
  });

  it('registers the rollback in MANUAL_MIGRATIONS, and NOT in MIGRATIONS', () => {
    expect(MANUAL_MIGRATIONS.find((m) => m.name === ROLLBACK_NAME)).toBeDefined();
    expect(MIGRATIONS.find((m) => m.name === ROLLBACK_NAME)).toBeUndefined();
  });

  it('does NOT register the forward migration in MANUAL_MIGRATIONS', () => {
    expect(MANUAL_MIGRATIONS.find((m) => m.name === FORWARD_NAME)).toBeUndefined();
  });
});

describe('confidence-scale-migration — forward pass order + guards', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs census-before, then the 4 heal passes, then census-after, in that order', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()])) // census-before
      .mockResolvedValueOnce(records([{ n: 2 }])) // heal-open-interval
      .mockResolvedValueOnce(records([{ n: 1 }])) // heal-exactly-one-mentions
      .mockResolvedValueOnce(records([{ n: 0 }])) // heal-exactly-one-relation-defaults
      .mockResolvedValueOnce(records([{ n: 0 }])) // heal-assertion-nodes
      .mockResolvedValueOnce(records([healedCensusRow()])); // census-after
    mockedRead.mockResolvedValueOnce(records([{ n: 1 }])); // healedGE60

    const passes = await getForwardMigration().apply();

    const passNames = passes.map((p) => p.pass);
    expect(passNames[0]).toBe('census-before');
    expect(passNames).toContain('heal-open-interval');
    expect(passNames).toContain('heal-exactly-one-mentions');
    expect(passNames).toContain('heal-exactly-one-relation-defaults');
    expect(passNames).toContain('heal-assertion-nodes');
    expect(passNames).toContain('census-after-and-verify');
    // heal-open-interval must come before both signature-specific heals.
    expect(passNames.indexOf('heal-open-interval')).toBeLessThan(passNames.indexOf('heal-exactly-one-mentions'));
    expect(passNames.indexOf('heal-exactly-one-mentions')).toBeLessThan(
      passNames.indexOf('heal-exactly-one-relation-defaults')
    );
    expect(passNames.indexOf('census-after-and-verify')).toBe(passNames.length - 2);
    // Residual logged last.
    expect(passNames[passNames.length - 1]).toBe('residual-exactly-one-unhealed');
    expect(passes[passes.length - 1].updatedOrDeleted).toBe(healedCensusRow().bucketExactly1);
  });

  it('heal-open-interval cypher guards on the open (0,1) interval and confidencePre100 IS NULL', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ visibleAt60: 8, bucketExactly1: 3 })]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getForwardMigration().apply();

    const healOpenIntervalCall = mockedWrite.mock.calls[1];
    expect(healOpenIntervalCall[0]).toContain('r.confidence > 0 AND r.confidence < 1');
    expect(healOpenIntervalCall[0]).toContain('r.confidencePre100 IS NULL');
    expect(healOpenIntervalCall[0]).toContain('toInteger(round(r.confidence * 100))');
  });

  it('heal-exactly-one-mentions cypher guards on MENTIONS + system:chunk-mentions + confidencePre100 IS NULL', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ visibleAt60: 8, bucketExactly1: 3 })]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getForwardMigration().apply();

    const mentionsCall = mockedWrite.mock.calls[2];
    expect(mentionsCall[0]).toContain(':MENTIONS');
    expect(mentionsCall[0]).toContain("r.assertedBy = 'system:chunk-mentions'");
    expect(mentionsCall[0]).toContain('r.confidencePre100 IS NULL');
  });

  it('heal-exactly-one-relation-defaults cypher guards on claimStatus + aiSuggested + confidencePre100 IS NULL', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ visibleAt60: 8, bucketExactly1: 3 })]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getForwardMigration().apply();

    const relationDefaultsCall = mockedWrite.mock.calls[3];
    expect(relationDefaultsCall[0]).toContain('r.claimStatus IS NOT NULL');
    expect(relationDefaultsCall[0]).toContain('r.aiSuggested IS NOT NULL');
    expect(relationDefaultsCall[0]).toContain('r.confidencePre100 IS NULL');
  });

  it('heal-assertion-nodes cypher targets (c:Assertion) on the open (0,1) interval only', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ visibleAt60: 8, bucketExactly1: 3 })]));
    mockedRead.mockResolvedValueOnce(records([{ n: 0 }]));

    await getForwardMigration().apply();

    const assertionCall = mockedWrite.mock.calls[4];
    expect(assertionCall[0]).toContain('(c:Assertion)');
    expect(assertionCall[0]).toContain('c.confidence > 0 AND c.confidence < 1');
    expect(assertionCall[0]).toContain('c.confidencePre100 IS NULL');
  });
});

describe('confidence-scale-migration — verify pass rejects invariant violations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when I1 (total conservation) is violated', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow({ total: 15 })])) // before
      .mockResolvedValueOnce(records([{ n: 2 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ total: 14 })])); // after — total DROPPED, impossible for a pure heal

    await expect(getForwardMigration().apply()).rejects.toThrow(/I1/);
  });

  it('throws when I2 (residual open-(0,1) edges) is violated', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 2 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ bucketOpen01: 1 })])); // after — should be 0

    await expect(getForwardMigration().apply()).rejects.toThrow(/I2/);
  });

  it('throws when I3 (precise VISIBLE@60 growth) is violated', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow({ visibleAt60: 8 })])) // before
      .mockResolvedValueOnce(records([{ n: 2 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ visibleAt60: 11 })])); // after — grew by 3, not 1
    mockedRead.mockResolvedValueOnce(records([{ n: 1 }])); // healedGE60 says only 1 should have become visible

    await expect(getForwardMigration().apply()).rejects.toThrow(/I3/);
  });

  it('does NOT record a re-runnable failure: the write count for the failing run is only the passes it actually ran', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([baseCensusRow()]))
      .mockResolvedValueOnce(records([{ n: 2 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([{ n: 0 }]))
      .mockResolvedValueOnce(records([healedCensusRow({ total: 999 })]));

    await expect(getForwardMigration().apply()).rejects.toThrow();
    // Exactly 6 writes: census-before + 4 heals + census-after. No 7th
    // "recordApplied"-style write happens inside apply() itself — that is
    // the runner's job (applyMigrationByName), and it never runs because
    // apply() threw.
    expect(mockedWrite).toHaveBeenCalledTimes(6);
  });
});

describe('confidence-scale-migration — rollback (MANUAL-only)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('restores edges and Assertion nodes from confidencePre100, then un-records the forward migration + deletes census nodes', async () => {
    mockedWrite
      .mockResolvedValueOnce(records([{ n: 5 }])) // restore edges
      .mockResolvedValueOnce(records([{ n: 2 }])) // restore Assertion nodes
      .mockResolvedValueOnce(records([{ n: 1 }])) // un-record forward migration
      .mockResolvedValueOnce(records([{ n: 2 }])); // delete census nodes

    const passes = await getRollbackMigration().apply();

    expect(passes.map((p) => p.updatedOrDeleted)).toEqual([5, 2, 1, 2]);

    const [edgesCall, assertionCall, unrecordCall, censusCall] = mockedWrite.mock.calls;
    expect(edgesCall[0]).toContain('r.confidencePre100 IS NOT NULL');
    expect(edgesCall[0]).toContain('SET r.confidence = r.confidencePre100');
    expect(edgesCall[0]).toContain('REMOVE r.confidencePre100, r.confidenceScaleMigratedAt');

    expect(assertionCall[0]).toContain('(c:Assertion)');
    expect(assertionCall[0]).toContain('c.confidencePre100 IS NOT NULL');
    expect(assertionCall[0]).toContain('SET c.confidence = c.confidencePre100');

    expect(unrecordCall[0]).toContain('SchemaMigration');
    expect(unrecordCall[0]).toContain('DETACH DELETE');
    expect(unrecordCall[1]).toMatchObject({ migrationName: FORWARD_NAME });

    expect(censusCall[0]).toContain('MigrationCensus');
    expect(censusCall[0]).toContain('DETACH DELETE');
    expect(censusCall[1]).toMatchObject({ migrationName: FORWARD_NAME });
  });
});
