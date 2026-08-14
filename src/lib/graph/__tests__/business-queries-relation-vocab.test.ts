/**
 * Regression test — business-query graph consumers must only pass relation
 * types that satisfy the canonical vocabulary (`relationTypeCypherSchema`),
 * and `analyzeGaps` must actually scan the pain points in the graph.
 *
 * Business-query functions must not pass phantom relation types (`DEVELOPS`,
 * `PROVIDES`, `TARGETS`) that don't exist in the vocabulary. The real
 * `Neo4jGraphService.getNeighbors` runs `relationTypeCypherSchema.parse` on
 * every type (neo4j-graph-service.ts:164), so these threw `ZodError: Invalid
 * relation type` on every call. This test
 * mirrors production validation by asserting the exact relation types the
 * functions route to the service.
 *
 * `analyzeGaps` had a second bug: it fetched "all pain points" via
 * `getNeighbors('*', …)`, but no node has id `'*'`, so it ALWAYS returned an
 * empty gap list regardless of the data.
 *
 * @jest-environment node
 */

import { relationTypeCypherSchema } from '../validation';

// Relation types routed to the service across a function call.
const captured: string[][] = [];

const NODE = { id: 'node-x', labels: ['Technology'], properties: { name: 'X' } };

const STRATEGY_NODE = { id: 'strategy-vendor-1', labels: ['Strategy'], properties: { name: 'S' } };

/**
 * A one-hop curated business path. `findTechnologiesForStrategy` now drops a
 * technology with no resolvable business path (GRAPH-062), so a stub that
 * always returns `null` would stop the vendor lookup before it routes any
 * relation type — and this suite's whole point is to observe those types.
 */
const BUSINESS_PATH = {
  nodes: [{ ...NODE }, { ...STRATEGY_NODE }],
  relations: [
    {
      id: 'r1',
      type: 'ALIGNS_WITH',
      sourceId: NODE.id,
      targetId: STRATEGY_NODE.id,
      properties: { effectiveConfidence: 90 },
    },
  ],
  length: 1,
};

const stubService = {
  getNode: jest.fn(async () => ({ ...NODE })),
  getNeighbors: jest.fn(async (_id: string, options: { relationTypes?: string[] } = {}) => {
    if (options.relationTypes) captured.push(options.relationTypes);
    return [] as unknown[];
  }),
  findConnected: jest.fn(async () => [{ ...NODE }]),
  findPath: jest.fn(async () => BUSINESS_PATH),
  query: jest.fn(async (cypher: string) => {
    if (/PainPoint/i.test(cypher)) {
      return {
        records: [
          { id: 'pp-1', labels: ['PainPoint'], properties: { name: 'PP1', severity: 'high' } },
          { id: 'pp-2', labels: ['PainPoint'], properties: { name: 'PP2', severity: 'low' } },
        ],
        summary: {},
      };
    }
    return { records: [], summary: {} };
  }),
};

jest.mock('../service-factory', () => ({
  getGraphService: jest.fn(async () => stubService),
}));

import {
  findCompetitorTechnologies,
  findInitiativesForPainPoint,
  findVendorsForStrategy,
  generateTechnologySummary,
  analyzeGaps,
} from '../business-queries';

function expectAllRelationTypesValid(): void {
  const flat = captured.flat();
  expect(flat.length).toBeGreaterThan(0); // the function actually routed some types
  for (const t of flat) {
    expect(relationTypeCypherSchema.safeParse(t).success).toBe(true);
  }
}

beforeEach(() => {
  captured.length = 0;
});

describe('business-queries relation-type vocabulary contract', () => {
  it('findCompetitorTechnologies routes only valid relation types', async () => {
    await findCompetitorTechnologies('company-comp-1');
    expectAllRelationTypesValid();
  });

  it('findInitiativesForPainPoint routes only valid relation types', async () => {
    await findInitiativesForPainPoint('painpoint-init-1');
    expectAllRelationTypesValid();
  });

  it('findVendorsForStrategy routes only valid relation types', async () => {
    await findVendorsForStrategy('strategy-vendor-1');
    expectAllRelationTypesValid();
  });

  it('generateTechnologySummary routes only valid relation types', async () => {
    await generateTechnologySummary('tech-summary-1');
    expectAllRelationTypesValid();
  });
});

describe('analyzeGaps scans the pain points in the graph', () => {
  it('returns one gap entry per pain point (not the dead * wildcard)', async () => {
    const gaps = await analyzeGaps();
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => g.painPoint.id).sort()).toEqual(['pp-1', 'pp-2']);
  });
});
