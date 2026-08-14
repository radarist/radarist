/**
 * Tests for the schema-migration runner.
 *
 * Each :SchemaMigration record gates re-application. The runner must:
 *   - skip already-applied migrations (returns alreadyApplied: true)
 *   - allow force-reapply (alreadyApplied stays true, but runs anyway)
 *   - run pending migrations in declaration order
 *   - record name + description + per-pass counters
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

import * as neo4j from '../neo4j-client';
import {
  MIGRATIONS,
  MANUAL_MIGRATIONS,
  applyMigrationByName,
  applyPendingMigrations,
  listAppliedMigrations,
} from '../schema-migrations';
import type { SchemaMigration } from '../schema-migrations';

const mockedRead = neo4j.runReadTransaction as jest.Mock;
const mockedWrite = neo4j.runWriteTransaction as jest.Mock;

const records = <T>(rows: T[]) => ({
  records: rows,
  summary: { counters: {}, queryType: '', resultAvailableAfter: 0, resultConsumedAfter: 0 },
});

describe('schema-migrations runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default every write to return a single {n: 0} row so the per-pass
    // counter math doesn't blow up when a specific test doesn't care.
    mockedWrite.mockResolvedValue(records([{ n: 0 }]));
  });

  it('MIGRATIONS contains the 2026-04-18 schema-simplification entry', () => {
    const m = MIGRATIONS.find((x) => x.name === '2026-04-18-schema-simplification');
    expect(m).toBeDefined();
    expect(typeof m!.apply).toBe('function');
  });

  it('GRAPH-066 radar-placement pair-identity migration is MANUAL-only (never auto-applied)', () => {
    const name = '2026-07-22-radar-placement-pair-identity';
    // Adds uniqueness constraints and can fail closed on duplicate drift — it
    // must be named-execution only, never swept in by applyPendingMigrations.
    expect(MANUAL_MIGRATIONS.find((x) => x.name === name)).toBeDefined();
    expect(MIGRATIONS.find((x) => x.name === name)).toBeUndefined();
  });

  describe('applyMigrationByName', () => {
    it('skips migrations that are already recorded', async () => {
      mockedRead.mockResolvedValueOnce(records([{ appliedAt: 1234 }]));

      const r = await applyMigrationByName('2026-04-18-schema-simplification');
      expect(r.alreadyApplied).toBe(true);
      expect(r.passes).toEqual([]);
      // No writes except possibly the MERGE record — but the skip branch
      // should write nothing at all.
      expect(mockedWrite).not.toHaveBeenCalled();
    });

    it('applies the migration and records it when not already applied', async () => {
      mockedRead.mockResolvedValueOnce(records([])); // hasBeenApplied = false
      // 5 passes each return a single-row result; last call is the MERGE recorder.
      mockedWrite
        .mockResolvedValueOnce(records([{ n: 2 }]))
        .mockResolvedValueOnce(records([{ n: 10 }]))
        .mockResolvedValueOnce(records([{ n: 0 }]))
        .mockResolvedValueOnce(records([{ n: 1 }]))
        .mockResolvedValueOnce(records([{ n: 0 }]))
        .mockResolvedValueOnce(records([])); // MERGE :SchemaMigration

      const r = await applyMigrationByName('2026-04-18-schema-simplification');
      expect(r.alreadyApplied).toBe(false);
      expect(r.passes).toHaveLength(5);
      expect(r.passes[0].updatedOrDeleted).toBe(2);
      expect(r.passes[1].updatedOrDeleted).toBe(10);
      // The recorder write should have been called with a MERGE pattern.
      const lastCall = mockedWrite.mock.calls[mockedWrite.mock.calls.length - 1];
      expect(lastCall[0]).toContain('MERGE (m:SchemaMigration');
      expect(lastCall[1].name).toBe('2026-04-18-schema-simplification');
    });

    it('re-applies when force=true even if already recorded', async () => {
      mockedRead.mockResolvedValueOnce(records([{ appliedAt: 1234 }]));

      await applyMigrationByName('2026-04-18-schema-simplification', { force: true });
      // 5 pass writes + 1 recorder write => at least 6
      expect(mockedWrite.mock.calls.length).toBeGreaterThanOrEqual(6);
    });

    it('throws on unknown migration name', async () => {
      await expect(applyMigrationByName('does-not-exist')).rejects.toThrow(/Unknown migration/);
    });
  });

  describe('applyPendingMigrations', () => {
    it('returns an entry per migration, marking skips and successes', async () => {
      // Every migration is already applied.
      mockedRead.mockResolvedValue(records([{ appliedAt: 1 }]));

      const results = await applyPendingMigrations();
      expect(results).toHaveLength(MIGRATIONS.length);
      for (const r of results) expect(r.alreadyApplied).toBe(true);
    });
  });

  describe('listAppliedMigrations', () => {
    it('returns the graph record sorted by appliedAt', async () => {
      mockedRead.mockResolvedValue(records([{ name: '2026-04-18-schema-simplification', appliedAt: 1234567890 }]));
      const r = await listAppliedMigrations();
      expect(r).toHaveLength(1);
      expect(r[0].name).toBe('2026-04-18-schema-simplification');
    });
  });
});

describe('UserPreference identity migration', () => {
  const migrationName = '2026-07-12-user-preference-identity';
  const getMigration = () => MANUAL_MIGRATIONS.find((candidate) => candidate.name === migrationName)!;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedWrite.mockResolvedValue(records([{ n: 0 }]));
  });

  it('consolidates legacy rows before creating composite and receipt constraints', async () => {
    mockedRead
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(records([{ nonCanonicalRows: 0, duplicateRows: 0, lockResidue: 0 }]));
    mockedWrite
      .mockResolvedValueOnce(records([{ canonicalGroups: 1, consolidatedRows: 2 }]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(records([]));

    const migration = getMigration();
    expect(migration).toBeDefined();
    const passes = await migration.apply();

    expect(passes).toEqual([
      { pass: 'preflight-safe-legacy-preferences', updatedOrDeleted: 0 },
      { pass: 'canonicalize-and-consolidate-user-preferences', updatedOrDeleted: 2 },
      { pass: 'create-user-preference-user-topic-constraint', updatedOrDeleted: 0 },
      { pass: 'create-preference-engagement-receipt-id-constraint', updatedOrDeleted: 0 },
      { pass: 'postflight-safe-user-preferences', updatedOrDeleted: 0 },
      { pass: 'verify-user-preference-identity', updatedOrDeleted: 0 },
    ]);

    const [consolidation, compositeConstraint, receiptConstraint] = mockedWrite.mock.calls.map(
      ([cypher]) => cypher as string
    );
    expect(consolidation).toContain('SET up._preferenceIdentityMigrationLock = true');
    expect(consolidation).toContain('FOREACH (duplicate IN duplicates | DELETE duplicate)');
    expect(consolidation).not.toContain('DETACH DELETE duplicate');
    expect(consolidation.indexOf('DELETE duplicate')).toBeLessThan(
      consolidation.indexOf('target.topic = canonicalTopic')
    );
    expect(compositeConstraint).toContain('REQUIRE (up.userId, up.topic) IS UNIQUE');
    expect(receiptConstraint).toContain('PreferenceEngagementReceipt');
    expect(mockedWrite.mock.calls[0][1]).toEqual({
      topicSeparators: expect.arrayContaining(['-', '\u00a0', '\u3000']),
    });
  });

  it('fails before mutation when deterministic consolidation cannot preserve a legacy row', async () => {
    mockedRead.mockResolvedValueOnce(
      records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 1, relatedRows: 1 }])
    );

    const migration = getMigration();
    await expect(migration.apply()).rejects.toThrow('unexpectedProperties=1, related=1');
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it('fails without recording success when post-constraint verification finds drift', async () => {
    mockedRead
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(records([{ nonCanonicalRows: 1, duplicateRows: 0, lockResidue: 0 }]));
    mockedWrite
      .mockResolvedValueOnce(records([{ canonicalGroups: 1, consolidatedRows: 0 }]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(records([]));

    const migration = getMigration();
    await expect(migration.apply()).rejects.toThrow('nonCanonical=1');
  });

  it('fails closed when a row becomes unsafe between preflight and constraint creation', async () => {
    mockedRead
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 1, unexpectedPropertyRows: 0, relatedRows: 0 }])
      );
    mockedWrite
      .mockResolvedValueOnce(records([{ canonicalGroups: 1, consolidatedRows: 0 }]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(records([]));

    const migration = getMigration();
    await expect(migration.apply()).rejects.toThrow('identity postflight failed');
  });
});

describe('MANUAL_MIGRATIONS lane (Task 16 A1 — manual-only, no auto-apply)', () => {
  const FAKE_MANUAL_NAME = 'test-fixture-manual-migration';
  let fakeManual: SchemaMigration;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedWrite.mockResolvedValue(records([{ n: 0 }]));
    fakeManual = {
      name: FAKE_MANUAL_NAME,
      description: 'Test-only fixture — never a real migration.',
      apply: jest.fn(async () => [{ pass: 'fixture-pass', updatedOrDeleted: 1 }]),
    };
    MANUAL_MIGRATIONS.push(fakeManual);
  });

  afterEach(() => {
    const idx = MANUAL_MIGRATIONS.indexOf(fakeManual);
    if (idx >= 0) MANUAL_MIGRATIONS.splice(idx, 1);
  });

  it('applyMigrationByName resolves manual migrations by name', async () => {
    mockedRead.mockResolvedValueOnce(records([])); // not yet applied

    const r = await applyMigrationByName(FAKE_MANUAL_NAME);

    expect(r.alreadyApplied).toBe(false);
    expect(r.passes).toEqual([{ pass: 'fixture-pass', updatedOrDeleted: 1 }]);
    expect(fakeManual.apply).toHaveBeenCalledTimes(1);
  });

  it('applyPendingMigrations never applies MANUAL_MIGRATIONS', async () => {
    // Every real MIGRATIONS entry already applied — applyPendingMigrations
    // should return exactly MIGRATIONS.length results, never touching the
    // manual fixture just pushed onto MANUAL_MIGRATIONS.
    mockedRead.mockResolvedValue(records([{ appliedAt: 1 }]));

    const results = await applyPendingMigrations();

    expect(results).toHaveLength(MIGRATIONS.length);
    expect(results.find((r) => r.name === FAKE_MANUAL_NAME)).toBeUndefined();
    expect(fakeManual.apply).not.toHaveBeenCalled();
  });

  it('keeps the destructive preference identity migration out of apply-all', async () => {
    mockedRead.mockResolvedValue(records([{ appliedAt: 1 }]));

    await applyPendingMigrations();

    expect(MIGRATIONS.some((migration) => migration.name === '2026-07-12-user-preference-identity')).toBe(false);
    expect(MANUAL_MIGRATIONS.some((migration) => migration.name === '2026-07-12-user-preference-identity')).toBe(true);
    expect(
      mockedWrite.mock.calls.some(
        ([cypher]) => typeof cypher === 'string' && cypher.includes('_preferenceIdentityMigrationLock')
      )
    ).toBe(false);
  });

  it('still runs the preference identity migration by exact name', async () => {
    mockedRead
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(
        records([{ malformedRows: 0, invalidCounterRows: 0, unexpectedPropertyRows: 0, relatedRows: 0 }])
      )
      .mockResolvedValueOnce(records([{ nonCanonicalRows: 0, duplicateRows: 0, lockResidue: 0 }]));
    mockedWrite
      .mockResolvedValueOnce(records([{ canonicalGroups: 1, consolidatedRows: 2 }]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(records([]))
      .mockResolvedValueOnce(records([]));

    const result = await applyMigrationByName('2026-07-12-user-preference-identity');

    expect(result).toMatchObject({
      name: '2026-07-12-user-preference-identity',
      alreadyApplied: false,
    });
    expect(mockedWrite.mock.calls[0][0]).toContain('_preferenceIdentityMigrationLock');
    expect(mockedWrite.mock.calls.at(-1)?.[1]).toMatchObject({
      name: '2026-07-12-user-preference-identity',
    });
  });
});

describe('legacy confidence-scale rollback isolation', () => {
  it('never rolls back relationships owned by a GRAPH-018 integrity repair', async () => {
    mockedRead.mockResolvedValueOnce(records([]));
    mockedWrite.mockResolvedValue(records([{ n: 0 }]));

    await applyMigrationByName('2026-07-05-confidence-scale-0-100-rollback');

    const edgeRollback = mockedWrite.mock.calls.find(
      ([cypher]) =>
        typeof cypher === 'string' && cypher.includes('MATCH ()-[r]->()') && cypher.includes('confidencePre100')
    );
    expect(edgeRollback).toBeDefined();
    expect(edgeRollback![0]).toContain('r.integrityRepairPlanSha IS NULL');
    expect(edgeRollback![0]).not.toContain('integrityRepairAppliedAt');
  });
});

describe('Pass-4 RelationType prune guard (repair-safety BROKEN #6)', () => {
  it('only prunes UNSEEDED RelationTypes (description IS NULL) so a reseed cannot be garbage-collected', async () => {
    mockedRead.mockResolvedValueOnce(records([])); // not yet applied
    mockedWrite.mockResolvedValue(records([{ n: 0 }]));

    await applyMigrationByName('2026-04-18-schema-simplification');

    const pruneCall = mockedWrite.mock.calls.find(
      ([cypher]) => typeof cypher === 'string' && cypher.includes('RelationType') && cypher.includes('DETACH DELETE')
    );
    expect(pruneCall).toBeDefined();
    // The guard: seeded metadata nodes carry a description; the prune must
    // never touch them even though they are edgeless.
    expect(pruneCall![0]).toMatch(/description IS NULL/);
  });
});
