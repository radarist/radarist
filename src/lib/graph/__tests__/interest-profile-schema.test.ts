/**
 * @jest-environment node
 *
 * P0-T2 — InterestProfile schema wiring: the EDGE_RULES registration (tested via
 * the public `getEdgeRulesForType`, NOT by importing the private const) and the
 * presence + DDL of the schema migration (presence-by-name, not array length).
 */

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runReadTransaction: jest.fn(),
  runWriteTransaction: jest.fn().mockResolvedValue({ records: [] }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { runWriteTransaction } from '../neo4j-client';
import { MIGRATIONS } from '../schema-migrations';
import { getEdgeRulesForType } from '../ensure-edges';

const mockedWrite = runWriteTransaction as jest.Mock;

describe('InterestProfile schema wiring (P0-T2)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('EDGE_RULES registration (via getEdgeRulesForType)', () => {
    it('registers PROFILE_FOR: InterestProfile -> User (outgoing)', () => {
      const rules = getEdgeRulesForType('InterestProfile');
      expect(rules).toEqual([
        { relationship: 'PROFILE_FOR', targetLabel: 'User', sourceProperty: 'userId', direction: 'outgoing' },
      ]);
    });
  });

  describe('schema migration', () => {
    it('includes the 2026-06-23-interest-profile migration (presence-by-name)', () => {
      const m = MIGRATIONS.find((x) => x.name === '2026-06-23-interest-profile');
      expect(m).toBeDefined();
      expect(typeof m!.apply).toBe('function');
    });

    it('apply() creates an IF NOT EXISTS uniqueness constraint + updatedAt index', async () => {
      mockedWrite.mockResolvedValue({ records: [] });
      const m = MIGRATIONS.find((x) => x.name === '2026-06-23-interest-profile')!;

      const passes = await m.apply();

      // Assert PER-STATEMENT so a regression that drops IF NOT EXISTS from only
      // one DDL statement is caught (not hidden by a joined-blob substring match).
      const cyphers = mockedWrite.mock.calls.map((c) => c[0] as string);
      const constraint = cyphers.find((c) => c.includes('CREATE CONSTRAINT'));
      const index = cyphers.find((c) => c.includes('CREATE INDEX'));

      expect(constraint).toBeDefined();
      expect(constraint).toContain('IF NOT EXISTS');
      expect(constraint).toContain('FOR (ip:InterestProfile) REQUIRE ip.userId IS UNIQUE');

      expect(index).toBeDefined();
      expect(index).toContain('IF NOT EXISTS');
      expect(index).toContain('FOR (ip:InterestProfile) ON (ip.updatedAt)');

      expect(passes.length).toBeGreaterThanOrEqual(2);
    });
  });
});
